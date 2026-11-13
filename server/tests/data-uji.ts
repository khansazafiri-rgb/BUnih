import type { Database as DB } from 'better-sqlite3';
import { akun, kategori } from './bantu.js';
import { recordCashEvent } from '../src/domain/ledger.js';
import { jadikanPelunasanPiutang } from '../src/domain/applyDecision.js';
import { recordReconciliation } from '../src/domain/balances.js';

let nomor = 0;

/** Satu pengeluaran pada tanggal tetap. Nomor referensi selalu unik supaya tidak digabung. */
export function keluar(
  database: DB,
  tanggal: string,
  jumlah: number,
  slug: string | null,
  merchant: string | null,
  extra: Record<string, unknown> = {},
) {
  nomor += 1;
  return recordCashEvent(
    {
      occurred_at: `${tanggal}T12:00:00+07:00`,
      direction: 'keluar',
      amount_minor: jumlah,
      account_id: akun(database, 'Mandiri'),
      kind: 'pengeluaran_pribadi',
      category_id: slug ? kategori(database, slug) : null,
      merchant_raw: merchant,
      reference_no: `UJI-${nomor}`,
      source: 'manual',
      ...extra,
    },
    database,
  );
}

/**
 * Dataset sintetis November/Oktober 2026 dengan angka yang dapat dihitung manual.
 * Tidak ada data pribadi: semua nama merchant fiktif.
 *
 * Hari acuan: 2026-11-20.
 *   Oktober 1-20 (pembanding adil): makan 180.000 + transport 90.000 = 270.000
 *   Oktober 25 (di luar pembanding): makan 300.000
 *   November 1-20: makan 460.000, transport 60.000, hiburan 100.000 - refund 20.000, tanpa kategori 40.000
 *                   = 640.000 pengeluaran pribadi neto
 *   Bukan pengeluaran pribadi: setoran tabungan 300.000, talangan 120.000, biaya company langsung 410.700,
 *                   pelunasan piutang 50.000, pemasukan 3.000.000
 */
export const HARI_ACUAN = '2026-11-20';

export function isiDataUji(database: DB): void {
  // Oktober
  for (const d of ['02', '04', '06', '08', '10']) keluar(database, `2026-10-${d}`, 20_000, 'makan', 'Kantin Kampus');
  keluar(database, '2026-10-12', 40_000, 'makan', 'Warung Bu Sri');
  keluar(database, '2026-10-15', 40_000, 'makan', 'Warung Bu Sri');
  for (const d of ['03', '09', '16']) keluar(database, `2026-10-${d}`, 30_000, 'transport', 'Gojek');
  keluar(database, '2026-10-25', 300_000, 'makan', 'Resto Mahal');

  // November
  for (const d of ['02', '03', '05', '09', '12', '16']) keluar(database, `2026-11-${d}`, 25_000, 'makan', 'Kantin Kampus');
  keluar(database, '2026-11-08', 60_000, 'makan', 'Warung Bu Sri');
  keluar(database, '2026-11-14', 250_000, 'makan', 'Resto Mahal');
  keluar(database, '2026-11-06', 30_000, 'transport', 'Gojek');
  keluar(database, '2026-11-13', 30_000, 'transport', 'Gojek');
  keluar(database, '2026-11-15', 100_000, 'hiburan', 'Bioskop Fiktif');
  keluar(database, '2026-11-18', 40_000, null, 'Toko X');

  // Refund hiburan: mengurangi pengeluaran, bukan pemasukan.
  recordCashEvent(
    {
      occurred_at: '2026-11-17T10:00:00+07:00',
      direction: 'masuk',
      amount_minor: 20_000,
      account_id: akun(database, 'Mandiri'),
      kind: 'refund',
      category_id: kategori(database, 'hiburan'),
      merchant_raw: 'Bioskop Fiktif',
      reference_no: 'UJI-REFUND',
      source: 'manual',
    },
    database,
  );

  // Pemasukan nyata
  recordCashEvent(
    {
      occurred_at: '2026-11-05T09:00:00+07:00',
      direction: 'masuk',
      amount_minor: 3_000_000,
      account_id: akun(database, 'Mandiri'),
      kind: 'pemasukan_luar',
      merchant_raw: 'Pemberi Kerja Fiktif',
      reference_no: 'UJI-GAJI',
      source: 'manual',
    },
    database,
  );

  // Perpindahan uang sendiri, piutang, dan biaya company: BUKAN pengeluaran pribadi.
  recordCashEvent({ occurred_at: '2026-11-07T10:00:00+07:00', direction: 'keluar', amount_minor: 300_000, account_id: akun(database, 'Mandiri'), kind: 'setoran_tabungan', reference_no: 'UJI-TAB', source: 'manual' }, database);
  const talangan = recordCashEvent({ occurred_at: '2026-11-09T10:00:00+07:00', direction: 'keluar', amount_minor: 120_000, account_id: akun(database, 'Mandiri'), kind: 'talangan', merchant_raw: 'Talangan Teman', reference_no: 'UJI-TAL', source: 'manual' }, database);
  recordCashEvent({ occurred_at: '2026-11-10T10:00:00+07:00', direction: 'keluar', amount_minor: 410_700, account_id: null, kind: 'pengeluaran_company_langsung', merchant_raw: 'Hosting Company', reference_no: 'UJI-COM', source: 'manual' }, database);

  const piutang = database
    .prepare(`SELECT r.id FROM receivable r JOIN allocation a ON a.id = r.allocation_id WHERE a.cash_event_id = ?`)
    .get(talangan.id) as { id: number };
  const kembali = recordCashEvent({ occurred_at: '2026-11-11T10:00:00+07:00', direction: 'masuk', amount_minor: 50_000, account_id: akun(database, 'Mandiri'), kind: 'pemasukan_luar', merchant_raw: 'Pelunasan Teman', reference_no: 'UJI-KEMBALI', source: 'manual' }, database);
  jadikanPelunasanPiutang(kembali.id, piutang.id, 'uji', database);

  recordReconciliation({ account_id: akun(database, 'Mandiri'), as_of: '2026-10-01T00:00:00+07:00', statement_balance_minor: 1_500_000, source: 'manual', note: 'uji' }, database);
}
