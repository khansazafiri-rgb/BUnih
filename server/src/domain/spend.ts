import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import type { IsoDate } from './time.js';

/**
 * SATU-SATUNYA tempat yang mendefinisikan "pengeluaran pribadi".
 *
 * Pengeluaran pribadi = potongan alokasi bertujuan biaya_pribadi atau kredit_layanan,
 * dikurangi potongan refund. Yang BUKAN pengeluaran pribadi:
 *   - transfer antar rekening sendiri dan setoran tabungan
 *   - piutang (uang yang akan kembali) dan pelunasannya
 *   - biaya yang dibayar langsung company
 *   - transaksi yang dibatalkan
 *
 * Laporan bulanan, anggaran, analitik, dan insight semua membaca dari sini, sehingga angkanya
 * tidak mungkin berbeda satu sama lain.
 */
export type SpendRow = {
  allocation_id: number;
  cash_event_id: number;
  tanggal: IsoDate;
  waktu: string;
  /** Positif untuk pengeluaran; negatif untuk refund. */
  jumlah_minor: number;
  category_id: number | null;
  merchant_id: number | null;
  merchant_name: string | null;
  kind: string;
  service_id: number | null;
  project: string | null;
  purpose: string;
  account_id: number | null;
};

const SQL_SPEND = `
  SELECT a.id AS allocation_id, ce.id AS cash_event_id, date(ce.occurred_at) AS tanggal,
         ce.occurred_at AS waktu,
         CASE WHEN a.purpose = 'refund' THEN -a.amount_minor ELSE a.amount_minor END AS jumlah_minor,
         COALESCE(a.category_id, ce.category_id) AS category_id,
         ce.merchant_id, COALESCE(m.name, ce.merchant_raw) AS merchant_name,
         ce.kind, ce.service_id, ce.project, a.purpose, ce.account_id
    FROM allocation a
    JOIN cash_event ce ON ce.id = a.cash_event_id
    LEFT JOIN merchant m ON m.id = ce.merchant_id
   WHERE a.purpose IN ('biaya_pribadi','kredit_layanan','refund')
     AND ce.status <> 'dibatalkan'
     AND date(ce.occurred_at) BETWEEN ? AND ?
   ORDER BY ce.occurred_at, a.id`;

export function spendRows(
  dari: IsoDate,
  sampai: IsoDate,
  opts: { categoryIds?: number[] | null; merchantId?: number | null } = {},
  database: DB = db(),
): SpendRow[] {
  let rows = database.prepare(SQL_SPEND).all(dari, sampai) as SpendRow[];
  if (opts.categoryIds) {
    const set = new Set(opts.categoryIds);
    rows = rows.filter((r) => r.category_id !== null && set.has(r.category_id));
  }
  if (opts.merchantId !== undefined && opts.merchantId !== null) {
    rows = rows.filter((r) => r.merchant_id === opts.merchantId);
  }
  return rows;
}

export function sumSpend(rows: SpendRow[]): number {
  return rows.reduce((s, r) => s + r.jumlah_minor, 0);
}

/** Pemasukan nyata: BUKAN pelunasan piutang, refund, atau perpindahan uang sendiri. */
export function incomeTotal(dari: IsoDate, sampai: IsoDate, database: DB = db()): number {
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(a.amount_minor), 0) AS total
         FROM allocation a JOIN cash_event ce ON ce.id = a.cash_event_id
        WHERE a.purpose = 'pemasukan' AND ce.direction = 'masuk'
          AND ce.status <> 'dibatalkan'
          AND date(ce.occurred_at) BETWEEN ? AND ?`,
    )
    .get(dari, sampai) as { total: number };
  return row.total;
}

const PERPINDAHAN = `('transfer_internal','setoran_tabungan','penarikan_tabungan')`;

/** Arus kas nyata lewat rekeningku atau tunai. Perpindahan uang sendiri dan biaya company-langsung tidak ikut. */
export function cashFlow(
  dari: IsoDate,
  sampai: IsoDate,
  database: DB = db(),
): { masuk_minor: number; keluar_minor: number } {
  const row = database
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ce.direction = 'masuk'  THEN ce.amount_minor ELSE 0 END), 0) AS masuk,
         COALESCE(SUM(CASE WHEN ce.direction = 'keluar' THEN ce.amount_minor ELSE 0 END), 0) AS keluar
         FROM cash_event ce
         LEFT JOIN account ac ON ac.id = ce.account_id
        WHERE ce.status <> 'dibatalkan'
          AND ce.kind NOT IN ${PERPINDAHAN}
          AND (ac.is_mine = 1 OR ce.is_cash = 1)
          AND date(ce.occurred_at) BETWEEN ? AND ?`,
    )
    .get(dari, sampai) as { masuk: number; keluar: number };
  return { masuk_minor: row.masuk, keluar_minor: row.keluar };
}
