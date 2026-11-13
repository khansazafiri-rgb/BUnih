import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso } from './time.js';
import { normalizeMerchant } from './merchantNorm.js';
import { writeAudit } from './audit.js';

export class MerchantError extends Error {}

export type MerchantRow = {
  id: number;
  name: string;
  name_norm: string;
  default_category_id: number | null;
  note: string | null;
  active: number;
};

export type ResolvedMerchant = {
  id: number;
  name: string;
  default_category_id: number | null;
  baru: boolean;
};

/**
 * Cari merchant untuk sebuah teks mentah, atau buat yang baru.
 *
 * Aturannya sengaja konservatif: HANYA nama ternormalisasi yang persis sama (atau alias yang
 * sudah terdaftar) yang dianggap merchant yang sama. "Warung Bu Sri" dan "Warung Sri" tetap
 * dua merchant sampai kamu sendiri menggabungkannya.
 */
export function resolveMerchant(
  raw: string | null | undefined,
  database: DB = db(),
): ResolvedMerchant | null {
  const norm = normalizeMerchant(raw);
  if (!norm || !raw) return null;

  const lewatAlias = database
    .prepare(
      `SELECT m.id, m.name, m.default_category_id FROM merchant_alias a
         JOIN merchant m ON m.id = a.merchant_id
        WHERE a.alias_norm = ? AND m.active = 1`,
    )
    .get(norm) as { id: number; name: string; default_category_id: number | null } | undefined;
  if (lewatAlias) return { ...lewatAlias, baru: false };

  const langsung = database
    .prepare(`SELECT id, name, default_category_id FROM merchant WHERE name_norm = ?`)
    .get(norm) as { id: number; name: string; default_category_id: number | null } | undefined;
  if (langsung) return { ...langsung, baru: false };

  const at = nowIso();
  const nama = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
  const res = database
    .prepare(
      `INSERT INTO merchant (name, name_norm, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(nama, norm, at, at);
  const id = Number(res.lastInsertRowid);
  database
    .prepare(
      `INSERT OR IGNORE INTO merchant_alias (merchant_id, alias_norm, alias_raw, source, created_at)
       VALUES (?, ?, ?, 'otomatis', ?)`,
    )
    .run(id, norm, nama, at);
  return { id, name: nama, default_category_id: null, baru: true };
}

export function getMerchant(id: number, database: DB = db()): MerchantRow | undefined {
  return database.prepare(`SELECT * FROM merchant WHERE id = ?`).get(id) as MerchantRow | undefined;
}

export function renameMerchant(
  id: number,
  name: string,
  actor = 'web',
  database: DB = db(),
): void {
  const bersih = name.trim().replace(/\s+/g, ' ');
  if (bersih.length < 2) throw new MerchantError('Nama merchant minimal 2 huruf.');
  const before = getMerchant(id, database);
  if (!before) throw new MerchantError('Merchant tidak ditemukan.');
  database
    .prepare(`UPDATE merchant SET name = ?, updated_at = ? WHERE id = ?`)
    .run(bersih, nowIso(), id);
  writeAudit(
    { entity: 'merchant', entity_id: id, action: 'ganti_nama', actor, before: { name: before.name }, after: { name: bersih } },
    database,
  );
}

export function setMerchantDefaultCategory(
  id: number,
  categoryId: number | null,
  actor = 'web',
  database: DB = db(),
): void {
  const before = getMerchant(id, database);
  if (!before) throw new MerchantError('Merchant tidak ditemukan.');
  database
    .prepare(`UPDATE merchant SET default_category_id = ?, updated_at = ? WHERE id = ?`)
    .run(categoryId, nowIso(), id);
  writeAudit(
    {
      entity: 'merchant',
      entity_id: id,
      action: 'kategori_bawaan',
      actor,
      before: { default_category_id: before.default_category_id },
      after: { default_category_id: categoryId },
    },
    database,
  );
}

/** True bila merchant hanya dibuat otomatis dan belum pernah disentuh pengguna. */
function merchantMurniOtomatis(id: number, database: DB): boolean {
  const m = getMerchant(id, database);
  if (!m || m.default_category_id !== null || m.note) return false;
  const bukanOtomatis = database
    .prepare(`SELECT COUNT(*) AS n FROM merchant_alias WHERE merchant_id = ? AND source <> 'otomatis'`)
    .get(id) as { n: number };
  return bukanOtomatis.n === 0;
}

/**
 * Tambah alias ke sebuah merchant. Transaksi lama dengan nama itu ikut dikelompokkan.
 * Bila nama itu sudah dipakai merchant yang sudah kamu atur, ditolak (gabungkan secara eksplisit).
 */
export function addAlias(
  merchantId: number,
  aliasRaw: string,
  actor = 'web',
  database: DB = db(),
): void {
  const norm = normalizeMerchant(aliasRaw);
  if (!norm) throw new MerchantError('Alias tidak valid.');
  if (!getMerchant(merchantId, database)) throw new MerchantError('Merchant tidak ditemukan.');
  const dipakai = database
    .prepare(`SELECT merchant_id FROM merchant_alias WHERE alias_norm = ?`)
    .get(norm) as { merchant_id: number } | undefined;
  if (dipakai && dipakai.merchant_id !== merchantId) {
    // Nama dari bank sering sudah otomatis membuat merchant sendiri. Bila merchant itu murni
    // buatan otomatis (semua namanya otomatis, belum diberi kategori atau catatan), maksud
    // pengguna jelas: nama itu sama dengan merchant ini, jadi digabung langsung.
    // Merchant yang sudah dikustomisasi pengguna tetap dilindungi dan harus digabung eksplisit.
    if (merchantMurniOtomatis(dipakai.merchant_id, database)) {
      mergeMerchants(dipakai.merchant_id, merchantId, actor, database);
      return;
    }
    throw new MerchantError(
      'Alias itu sudah dipakai merchant lain yang sudah kamu atur. Gabungkan kedua merchant bila memang sama.',
    );
  }
  if (dipakai) return;

  const run = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO merchant_alias (merchant_id, alias_norm, alias_raw, source, created_at)
         VALUES (?, ?, ?, 'manual', ?)`,
      )
      .run(merchantId, norm, aliasRaw.trim(), nowIso());
    // Transaksi lama dengan nama itu ikut dikelompokkan.
    database
      .prepare(`UPDATE cash_event SET merchant_id = ? WHERE merchant_norm = ? AND (merchant_id IS NULL OR merchant_id <> ?)`)
      .run(merchantId, norm, merchantId);
    writeAudit(
      { entity: 'merchant', entity_id: merchantId, action: 'alias_ditambah', actor, after: { alias: aliasRaw.trim() } },
      database,
    );
  });
  run();
}

export function removeAlias(aliasId: number, actor = 'web', database: DB = db()): void {
  const row = database.prepare(`SELECT * FROM merchant_alias WHERE id = ?`).get(aliasId) as
    | { id: number; merchant_id: number; alias_norm: string; alias_raw: string | null; source: string }
    | undefined;
  if (!row) throw new MerchantError('Alias tidak ditemukan.');
  const sisa = database
    .prepare(`SELECT COUNT(*) AS n FROM merchant_alias WHERE merchant_id = ?`)
    .get(row.merchant_id) as { n: number };
  if (sisa.n <= 1) throw new MerchantError('Merchant harus punya minimal satu nama.');
  database.prepare(`DELETE FROM merchant_alias WHERE id = ?`).run(aliasId);
  writeAudit(
    { entity: 'merchant', entity_id: row.merchant_id, action: 'alias_dihapus', actor, before: { alias: row.alias_raw } },
    database,
  );
}

/**
 * Gabungkan merchant `dari` ke `ke`: semua alias dan transaksi pindah. Dilakukan hanya atas
 * permintaan pengguna; aplikasi tidak pernah menggabungkan merchant sendiri.
 */
export function mergeMerchants(
  dari: number,
  ke: number,
  actor = 'web',
  database: DB = db(),
): { transaksi_dipindah: number; alias_dipindah: number } {
  if (dari === ke) throw new MerchantError('Pilih dua merchant yang berbeda.');
  const run = database.transaction(() => {
    const a = getMerchant(dari, database);
    const b = getMerchant(ke, database);
    if (!a || !b) throw new MerchantError('Merchant tidak ditemukan.');

    const alias = database
      .prepare(`UPDATE merchant_alias SET merchant_id = ?, source = 'gabungan' WHERE merchant_id = ?`)
      .run(ke, dari);
    const tx = database
      .prepare(`UPDATE cash_event SET merchant_id = ? WHERE merchant_id = ?`)
      .run(ke, dari);
    if (b.default_category_id === null && a.default_category_id !== null) {
      database
        .prepare(`UPDATE merchant SET default_category_id = ?, updated_at = ? WHERE id = ?`)
        .run(a.default_category_id, nowIso(), ke);
    }
    database
      .prepare(`UPDATE merchant SET active = 0, updated_at = ? WHERE id = ?`)
      .run(nowIso(), dari);
    writeAudit(
      {
        entity: 'merchant',
        entity_id: ke,
        action: 'gabung',
        actor,
        before: { digabung: a.name },
        after: { ke: b.name, transaksi: tx.changes, alias: alias.changes },
      },
      database,
    );
    return { transaksi_dipindah: tx.changes, alias_dipindah: alias.changes };
  });
  return run();
}

export type MerchantView = MerchantRow & {
  kategori_bawaan: string | null;
  alias: Array<{ id: number; alias_raw: string | null; source: string }>;
  jumlah_transaksi: number;
  total_pengeluaran_minor: number;
  terakhir: string | null;
};

export function listMerchants(
  opts: { cari?: string; termasukNonaktif?: boolean; batas?: number } = {},
  database: DB = db(),
): MerchantView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.termasukNonaktif) where.push('m.active = 1');
  if (opts.cari) {
    where.push('(m.name LIKE ? OR m.name_norm LIKE ?)');
    params.push(`%${opts.cari}%`, `%${opts.cari.toLowerCase()}%`);
  }
  const rows = database
    .prepare(
      `SELECT m.*, c.name AS kategori_bawaan,
              COUNT(ce.id) AS jumlah_transaksi,
              COALESCE(SUM(CASE WHEN ce.direction='keluar' THEN ce.amount_minor ELSE 0 END),0) AS total_pengeluaran_minor,
              MAX(ce.occurred_at) AS terakhir
         FROM merchant m
         LEFT JOIN category c ON c.id = m.default_category_id
         LEFT JOIN cash_event ce ON ce.merchant_id = m.id AND ce.status <> 'dibatalkan'
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        GROUP BY m.id
        ORDER BY jumlah_transaksi DESC, m.name
        LIMIT ?`,
    )
    .all(...params, opts.batas ?? 200) as Array<Omit<MerchantView, 'alias'>>;

  const aliasStmt = database.prepare(
    `SELECT id, alias_raw, source FROM merchant_alias WHERE merchant_id = ? ORDER BY id`,
  );
  return rows.map((r) => ({
    ...r,
    alias: aliasStmt.all(r.id) as MerchantView['alias'],
  }));
}
