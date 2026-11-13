/**
 * Operasi kategori untuk antarmuka percakapan (Telegram) dan web:
 * pembuatan yang kebal duplikat, gabung tanpa kehilangan riwayat.
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { writeAudit } from './audit.js';
import { CategoryError, createCategory, getCategory, updateCategory, type CategoryRow } from './categories.js';
import { nowIso } from './time.js';

/** "  Pacaran  " , "PACARAN", "pacáran!" dan "Pa-caran" dianggap nama yang sama. */
export function normalisasiNamaKategori(nama: string): string {
  return nama
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function cariKategoriPersis(
  nama: string,
  opts: { termasukNonaktif?: boolean; kecuali?: number } = {},
  database: DB = db(),
): CategoryRow | undefined {
  const target = normalisasiNamaKategori(nama);
  if (!target) return undefined;
  const rows = database
    .prepare(`SELECT * FROM category ${opts.termasukNonaktif ? '' : 'WHERE active = 1'} ORDER BY active DESC, id`)
    .all() as CategoryRow[];
  return rows.find((r) => r.id !== opts.kecuali && normalisasiNamaKategori(r.name) === target);
}

export type HasilBuat = { id: number; status: 'baru' | 'sudah_ada' | 'diaktifkan_lagi'; nama: string };

/**
 * Idempoten: nama yang sama (apa pun kapitalisasi, spasi, atau tanda bacanya) tidak membuat duplikat.
 * Bila kategori dengan nama itu sudah diarsipkan, kategori itu diaktifkan kembali (riwayat tetap utuh).
 */
export function buatAtauPakaiKategori(
  nama: string,
  actor = 'telegram',
  opts: { icon?: string | null; parent_id?: number | null } = {},
  database: DB = db(),
): HasilBuat {
  const bersih = nama.trim().replace(/\s+/g, ' ');
  if (bersih.length < 2) throw new CategoryError('Nama kategori minimal 2 huruf.');
  if (bersih.length > 40) throw new CategoryError('Nama kategori maksimal 40 karakter.');
  if (!normalisasiNamaKategori(bersih)) throw new CategoryError('Nama kategori harus memuat huruf atau angka.');

  return database.transaction((): HasilBuat => {
    const ada = cariKategoriPersis(bersih, { termasukNonaktif: true }, database);
    if (ada && ada.active) return { id: ada.id, status: 'sudah_ada', nama: ada.name };
    if (ada) {
      database.prepare(`UPDATE category SET active = 1, merged_into = NULL WHERE id = ?`).run(ada.id);
      writeAudit({ entity: 'category', entity_id: ada.id, action: 'aktif_lagi', actor, before: ada }, database);
      return { id: ada.id, status: 'diaktifkan_lagi', nama: ada.name };
    }
    const id = createCategory({ name: bersih, icon: opts.icon ?? null, parent_id: opts.parent_id ?? null }, actor, database);
    return { id, status: 'baru', nama: bersih };
  })();
}

export function gantiNamaKategori(id: number, nama: string, actor = 'telegram', database: DB = db()): void {
  const bersih = nama.trim().replace(/\s+/g, ' ');
  const sama = cariKategoriPersis(bersih, { kecuali: id }, database);
  if (sama) throw new CategoryError(`Sudah ada kategori "${sama.name}".`);
  updateCategory(id, { name: bersih }, actor, database);
}

export type HasilGabung = { dipindah_transaksi: number; dipindah_potongan: number; anggaran: number; ke: string; dari: string };

/**
 * Gabungkan kategori `dari` ke `ke`. Semua transaksi, potongan, anggaran, aturan merchant, dan
 * subkategori dipindahkan; kategori asal TIDAK dihapus, hanya dinonaktifkan dan menunjuk tujuan gabungan.
 * Kategori tujuan tidak boleh berada di dalam turunan kategori asal.
 */
export function gabungKategori(dari: number, ke: number, actor = 'telegram', database: DB = db()): HasilGabung {
  if (dari === ke) throw new CategoryError('Pilih dua kategori yang berbeda.');
  return database.transaction((): HasilGabung => {
    const a = getCategory(dari, database);
    const b = getCategory(ke, database);
    if (!a || !b) throw new CategoryError('Kategori tidak ditemukan.');
    if (!b.active) throw new CategoryError('Kategori tujuan sudah diarsipkan.');
    // Cegah lingkaran: tujuan tidak boleh turunan dari asal.
    let cur: CategoryRow | undefined = b;
    for (let i = 0; cur && i < 20; i += 1) {
      if (cur.parent_id === dari) throw new CategoryError('Kategori tujuan berada di dalam kategori asal.');
      cur = cur.parent_id ? getCategory(cur.parent_id, database) : undefined;
    }
    const t = database.prepare(`UPDATE cash_event SET category_id = ?, updated_at = ? WHERE category_id = ?`).run(ke, nowIso(), dari).changes;
    const p = database.prepare(`UPDATE allocation SET category_id = ? WHERE category_id = ?`).run(ke, dari).changes;
    const ag = database.prepare(`UPDATE budget SET category_id = ? WHERE category_id = ?`).run(ke, dari).changes;
    database.prepare(`UPDATE merchant SET default_category_id = ? WHERE default_category_id = ?`).run(ke, dari);
    database.prepare(`UPDATE merchant_rule SET category_id = ? WHERE category_id = ?`).run(ke, dari);
    database.prepare(`UPDATE category SET parent_id = ? WHERE parent_id = ?`).run(ke, dari);
    database.prepare(`UPDATE category SET active = 0, merged_into = ? WHERE id = ?`).run(ke, dari);
    writeAudit(
      {
        entity: 'category',
        entity_id: dari,
        action: 'digabung',
        actor,
        before: a,
        after: { ke, nama_tujuan: b.name, transaksi: t, potongan: p, anggaran: ag },
      },
      database,
    );
    return { dipindah_transaksi: t, dipindah_potongan: p, anggaran: ag, ke: b.name, dari: a.name };
  })();
}
