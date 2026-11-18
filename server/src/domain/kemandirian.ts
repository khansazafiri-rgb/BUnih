import fs from 'node:fs';
import path from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { nowIso } from './time.js';
import { writeAudit } from './audit.js';

/**
 * Membuat BUnih berdiri sendiri (tanpa Google Sheet) pada database yang SUDAH berisi
 * data warisan dari Sheet lama, dan merapikan pembayaran ganda yang masuk dari Gmail.
 *
 * Yang dibersihkan hanya data PERENCANAAN yang berasal dari Sheet dan tidak punya bukti nyata:
 *   - asumsi bersumber 'sheet' (saldo awal, rencana top-up, anggaran makan harian, ...)
 *   - rencana top-up dan rencana belanja hasil impor / pembangkitan dari asumsi itu
 *   - tagihan seed yang tidak punya bukti email maupun transaksi
 *   - layanan katalog Sheet yang tidak pernah punya transaksi atau bukti
 *
 * Yang TIDAK pernah disentuh: transaksi yang kamu catat sendiri, transaksi bank, rekening,
 * rekonsiliasi saldo, kategori, anggaran, tujuan, dan bukti email.
 *
 * Satu salinan database dibuat dulu (VACUUM INTO) sebelum ada yang diubah.
 */

export const KUNCI_SELESAI = 'kemandirian_v1';

export type LaporanPembersihan = {
  kering: boolean;
  cadangan: string | null;
  asumsi_sheet: number;
  topup_rencana: number;
  belanja_rencana: number;
  tagihan_seed: number;
  layanan_tanpa_bukti: number;
  riwayat_impor_sheet: number;
  bayar_ganda: Array<{ dipertahankan: number; dibatalkan: number[]; merchant: string | null; jumlah_minor: number }>;
};

function hitung(database: DB, sql: string, ...p: unknown[]): number {
  return (database.prepare(sql).get(...p) as { n: number }).n;
}

function bersihkanSql(sql: string): string {
  return sql.replace(/'/g, "''");
}

/** Salin database sebelum diubah. Mengembalikan jalur salinan, atau null untuk database memori. */
export function buatSalinan(database: DB, direktori: string | null = path.join(config.dataDir, 'cadangan')): string | null {
  if (!direktori) return null;
  const berkas = (database.pragma('database_list') as Array<{ name: string; file: string }>).find((d) => d.name === 'main')?.file;
  if (!berkas) return null; // memori
  fs.mkdirSync(direktori, { recursive: true });
  const stempel = nowIso().replace(/[:+]/g, '-').slice(0, 19);
  const tujuan = path.join(direktori, `sebelum-mandiri-${stempel}.sqlite`);
  database.exec(`VACUUM INTO '${bersihkanSql(tujuan)}'`);
  return tujuan;
}

/* ------------------------------------------------------------ data warisan Sheet */

function sasaranSheet(database: DB) {
  const impor = (entitas: string): number[] =>
    (
      database
        .prepare(`SELECT entity_id FROM import_item WHERE source = 'sheet' AND entity = ? AND entity_id IS NOT NULL`)
        .all(entitas) as Array<{ entity_id: number }>
    ).map((r) => r.entity_id);

  const topup = (
    database
      .prepare(
        `SELECT id FROM topup_plan
          WHERE cash_event_id IS NULL
            AND status IN ('rencana','tidak_diterima','dibatalkan')
            AND (generation_key LIKE 'topup:%' OR generation_key LIKE 'sheet-topup:%')`,
      )
      .all() as Array<{ id: number }>
  ).map((r) => r.id);

  const belanjaImpor = new Set(impor('purchase'));
  const belanja = (
    database
      .prepare(`SELECT id FROM purchase WHERE cash_event_id IS NULL AND payment_status <> 'dibayar'`)
      .all() as Array<{ id: number }>
  )
    .map((r) => r.id)
    .filter((id) => belanjaImpor.has(id));

  const tagihan = (
    database
      .prepare(
        `SELECT i.id FROM invoice i
          WHERE i.dedupe_key LIKE 'seed:%'
            AND NOT EXISTS (SELECT 1 FROM invoice_evidence e WHERE e.invoice_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM cash_event c WHERE c.invoice_id = i.id AND c.status <> 'dibatalkan')`,
      )
      .all() as Array<{ id: number }>
  ).map((r) => r.id);

  const asumsi = hitung(database, `SELECT COUNT(*) AS n FROM assumption WHERE source = 'sheet'`);
  const riwayat = hitung(database, `SELECT COUNT(*) AS n FROM import_run WHERE source = 'sheet'`);
  return { topup, belanja, tagihan, asumsi, riwayat, layananImpor: new Set(impor('service')) };
}

const SLUG_SEED = [
  'chatgpt-plus-pribadi', 'biznet-gio-pribadi', 'claude-pro-pribadi', 'idcloudhost-vps-company',
  'claude-pro-company', 'google-ai-pro-5tb', 'tencent-cloud-hermes', 'cloudflare-pro',
  'canva-pro', 'elevenlabs-starter', 'openrouter-credits',
];

/** Layanan katalog Sheet yang belum pernah punya transaksi, bukti email, atau tagihan bukti. */
function layananTanpaBukti(database: DB, tagihanDihapus: Set<number>, layananImpor: Set<number>): number[] {
  const kandidat = database.prepare(`SELECT id, slug FROM service`).all() as Array<{ id: number; slug: string }>;
  const hasil: number[] = [];
  for (const s of kandidat) {
    if (!SLUG_SEED.includes(s.slug) && !layananImpor.has(s.id)) continue;
    if (hitung(database, `SELECT COUNT(*) AS n FROM cash_event WHERE service_id = ?`, s.id) > 0) continue;
    const tagihan = database.prepare(`SELECT id FROM invoice WHERE service_id = ?`).all(s.id) as Array<{ id: number }>;
    const adaBukti = tagihan.some(
      (t) =>
        !tagihanDihapus.has(t.id) &&
        (hitung(database, `SELECT COUNT(*) AS n FROM invoice_evidence WHERE invoice_id = ?`, t.id) > 0 ||
          hitung(database, `SELECT COUNT(*) AS n FROM cash_event WHERE invoice_id = ?`, t.id) > 0),
    );
    if (adaBukti) continue;
    // Tagihan tanpa bukti yang bukan seed (mis. dibuat manual) ikut menahan layanan.
    if (tagihan.some((t) => !tagihanDihapus.has(t.id))) continue;
    hasil.push(s.id);
  }
  return hasil;
}

/* ------------------------------------------------------------ pembayaran ganda dari Gmail */

type BarisBayar = {
  id: number;
  occurred_at: string;
  amount_minor: number;
  currency: string;
  account_id: number | null;
  service_id: number | null;
  merchant_raw: string | null;
  merchant_norm: string | null;
  reference_no: string | null;
  status: string;
};

/**
 * Pembayaran langganan yang sama (layanan + nominal) dalam jendela 7 hari yang berasal dari
 * Gmail adalah SATU pembayaran: notifikasi bank, kuitansi, dan invoice yang lunas hanyalah
 * bukti-bukti untuk peristiwa yang sama. Dua transaksi dengan nomor referensi bank yang
 * berbeda tidak pernah digabung.
 */
export function cariBayarGanda(database: DB) {
  const baris = database
    .prepare(
      `SELECT id, occurred_at, amount_minor, currency, account_id, service_id, merchant_raw,
              merchant_norm, reference_no, status
         FROM cash_event
        WHERE direction = 'keluar' AND status <> 'dibatalkan' AND source = 'gmail'
          AND service_id IS NOT NULL
        ORDER BY occurred_at, id`,
    )
    .all() as BarisBayar[];

  const kelompok = new Map<string, BarisBayar[]>();
  for (const b of baris) {
    const k = `${b.service_id}|${b.currency}|${b.amount_minor}`;
    (kelompok.get(k) ?? kelompok.set(k, []).get(k)!).push(b);
  }

  const hasil: Array<{ dipertahankan: BarisBayar; dibatalkan: BarisBayar[] }> = [];
  for (const daftar of kelompok.values()) {
    if (daftar.length < 2) continue;
    let gugus: BarisBayar[] = [];
    const tutup = () => {
      if (gugus.length > 1) {
        const urut = [...gugus].sort((a, b) => {
          const sa = (a.account_id ? 0 : 2) + (a.status === 'terkonfirmasi' ? 0 : 1);
          const sb = (b.account_id ? 0 : 2) + (b.status === 'terkonfirmasi' ? 0 : 1);
          return sa - sb || a.id - b.id;
        });
        const [utama, ...lain] = urut;
        // Referensi bank yang berbeda = transaksi berbeda.
        const aman = lain.filter((x) => !(x.reference_no && utama!.reference_no && x.reference_no !== utama!.reference_no));
        if (aman.length) hasil.push({ dipertahankan: utama!, dibatalkan: aman });
      }
      gugus = [];
    };
    for (const b of daftar) {
      if (gugus.length && Date.parse(b.occurred_at) - Date.parse(gugus[0]!.occurred_at) > 7 * 86_400_000) tutup();
      gugus.push(b);
    }
    tutup();
  }
  return hasil;
}

export function gabungkanBayarGanda(database: DB, kering = false): LaporanPembersihan['bayar_ganda'] {
  const temuan = cariBayarGanda(database);
  const laporan: LaporanPembersihan['bayar_ganda'] = [];
  const at = nowIso();
  for (const t of temuan) {
    laporan.push({
      dipertahankan: t.dipertahankan.id,
      dibatalkan: t.dibatalkan.map((x) => x.id),
      merchant: t.dipertahankan.merchant_raw,
      jumlah_minor: t.dipertahankan.amount_minor,
    });
    if (kering) continue;
    for (const dup of t.dibatalkan) {
      database
        .prepare(
          `INSERT OR IGNORE INTO cash_event_evidence (cash_event_id, evidence_id, role)
           SELECT ?, evidence_id, role FROM cash_event_evidence WHERE cash_event_id = ?`,
        )
        .run(t.dipertahankan.id, dup.id);
      // Isi yang kosong pada transaksi utama dari duplikatnya.
      database
        .prepare(
          `UPDATE cash_event SET
             reference_no = COALESCE(reference_no, ?),
             invoice_id = COALESCE(invoice_id, (SELECT invoice_id FROM cash_event WHERE id = ?)),
             updated_at = ?
           WHERE id = ?`,
        )
        .run(dup.reference_no, dup.id, at, t.dipertahankan.id);
      database
        .prepare(
          `UPDATE cash_event SET status = 'dibatalkan',
             note = TRIM(COALESCE(note, '') || ' [Digabung otomatis ke transaksi #' || ? || ': pembayaran yang sama terlihat dari beberapa email.]'),
             updated_at = ? WHERE id = ?`,
        )
        .run(t.dipertahankan.id, at, dup.id);
      database
        .prepare(`UPDATE pending_decision SET state = 'dibatalkan' WHERE cash_event_id = ? AND state IN ('terbuka','terkirim')`)
        .run(dup.id);
      writeAudit(
        {
          entity: 'cash_event',
          entity_id: dup.id,
          action: 'gabung_bayar_ganda',
          actor: 'kemandirian',
          before: { status: dup.status },
          after: { status: 'dibatalkan', digabung_ke: t.dipertahankan.id },
          reason: 'Pembayaran langganan yang sama (layanan + nominal) dalam 7 hari dari Gmail.',
        },
        database,
      );
    }
  }
  return laporan;
}

/* ------------------------------------------------------------ pintu masuk */

export function pembersihanSudahJalan(database: DB = db()): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(KUNCI_SELESAI));
}

export function pembersihan(
  database: DB = db(),
  opsi: { kering?: boolean; direktoriCadangan?: string | null } = {},
): LaporanPembersihan {
  const kering = opsi.kering ?? false;
  const s = sasaranSheet(database);
  const tagihanSet = new Set(s.tagihan);
  const layanan = layananTanpaBukti(database, tagihanSet, s.layananImpor);
  const ganda = gabungkanBayarGanda(database, true);

  const laporan: LaporanPembersihan = {
    kering,
    cadangan: null,
    asumsi_sheet: s.asumsi,
    topup_rencana: s.topup.length,
    belanja_rencana: s.belanja.length,
    tagihan_seed: s.tagihan.length,
    layanan_tanpa_bukti: layanan.length,
    riwayat_impor_sheet: s.riwayat,
    bayar_ganda: ganda,
  };
  if (kering) return laporan;

  const ada = s.asumsi + s.topup.length + s.belanja.length + s.tagihan.length + layanan.length + s.riwayat + ganda.length;
  if (ada > 0) laporan.cadangan = buatSalinan(database, opsi.direktoriCadangan === undefined ? undefined : opsi.direktoriCadangan);

  const jalankan = database.transaction(() => {
    const hapus = (tabel: string, ids: number[]) => {
      const st = database.prepare(`DELETE FROM ${tabel} WHERE id = ?`);
      for (const id of ids) st.run(id);
    };
    database.prepare(`DELETE FROM assumption WHERE source = 'sheet'`).run();
    hapus('topup_plan', s.topup);
    hapus('purchase', s.belanja);
    hapus('invoice', s.tagihan);
    for (const id of layanan) {
      database.prepare(`UPDATE merchant_rule SET service_id = NULL WHERE service_id = ?`).run(id);
      try {
        database.prepare(`DELETE FROM service WHERE id = ?`).run(id);
      } catch {
        // Masih ada yang merujuk layanan ini: biarkan, lebih aman daripada memaksa.
        laporan.layanan_tanpa_bukti -= 1;
      }
    }
    database.prepare(`DELETE FROM import_run WHERE source = 'sheet'`).run();
    laporan.bayar_ganda = gabungkanBayarGanda(database, false);
    database
      .prepare(
        `INSERT INTO app_setting (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(KUNCI_SELESAI, JSON.stringify({ ...laporan, bayar_ganda: laporan.bayar_ganda.length }), nowIso());
    writeAudit(
      { entity: 'database', entity_id: null, action: 'kemandirian_dijalankan', actor: 'kemandirian', after: { ...laporan, bayar_ganda: laporan.bayar_ganda.length } },
      database,
    );
  });
  jalankan();
  return laporan;
}

/** Dipanggil saat aplikasi start. Berjalan SEKALI per database; gagal tidak pernah menghentikan aplikasi. */
export function pembersihanSekali(database: DB = db()): LaporanPembersihan | null {
  if (pembersihanSudahJalan(database)) return null;
  try {
    return pembersihan(database);
  } catch (err) {
    console.error('[kemandirian] pembersihan dilewati:', (err as Error).message);
    return null;
  }
}
