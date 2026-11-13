import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { endOfMonth, namaBulan, startOfMonth, today, type IsoDate } from './time.js';
import { formatIDR } from './money.js';
import { listReceivables } from './receivables.js';
import { listInvoices } from './services.js';

export type MonthlyReport = {
  bulan: string;
  label: string;
  dari: IsoDate;
  sampai: IsoDate;
  arus_kas: {
    masuk_minor: number;
    keluar_minor: number;
    neto_minor: number;
    /** Transfer antar rekening saya tidak dihitung sebagai masuk/keluar. */
    transfer_internal_minor: number;
  };
  biaya_pribadi_neto_minor: number;
  biaya_pribadi_per_kategori: Array<{ kategori: string; minor: number }>;
  tabungan: { setoran_minor: number; penarikan_minor: number; neto_minor: number };
  piutang: {
    bertambah_minor: number;
    kembali_minor: number;
    sisa_akhir_minor: number;
    sisa_teman_minor: number;
    sisa_company_minor: number;
  };
  pengeluaran_company: {
    dibayar_company_langsung_minor: number;
    saya_talangi_minor: number;
    sudah_direimburse_minor: number;
    belum_direimburse_minor: number;
  };
  tagihan_belum_dibayar: Array<{
    label: string;
    tanggal: string | null;
    nominal_minor: number | null;
    status: string;
    penanggung: string | null;
  }>;
  kredit_layanan_minor: number;
  refund_minor: number;
  koreksi_minor: number;
  pemasukan_sumber: Array<{ sumber: string; minor: number }>;
  catatan: string[];
};

function sumAlloc(
  database: DB,
  dari: IsoDate,
  sampai: IsoDate,
  purpose: string,
  direction?: 'masuk' | 'keluar',
): number {
  const dirClause = direction ? `AND ce.direction = '${direction}'` : '';
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(a.amount_minor), 0) AS total
         FROM allocation a JOIN cash_event ce ON ce.id = a.cash_event_id
        WHERE a.purpose = ?
          AND ce.status <> 'dibatalkan'
          AND date(ce.occurred_at) BETWEEN ? AND ?
          ${dirClause}`,
    )
    .get(purpose, dari, sampai) as { total: number };
  return row.total;
}

/**
 * Laporan bulanan yang memisahkan arus kas, biaya pribadi neto, transfer internal,
 * tabungan, piutang reimburse, tagihan belum dibayar, dan pengeluaran company.
 * Satu rupiah hanya muncul di satu baris makna.
 */
export function monthlyReport(
  ym: string = today().slice(0, 7),
  database: DB = db(),
): MonthlyReport {
  const dari = startOfMonth(`${ym}-01`);
  const sampai = endOfMonth(dari);
  const catatan: string[] = [];

  const kas = database
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ce.direction = 'masuk'  THEN ce.amount_minor ELSE 0 END), 0) AS masuk,
         COALESCE(SUM(CASE WHEN ce.direction = 'keluar' THEN ce.amount_minor ELSE 0 END), 0) AS keluar
       FROM cash_event ce
       JOIN account ac ON ac.id = ce.account_id
      WHERE ce.status <> 'dibatalkan'
        AND ac.is_mine = 1
        AND ce.kind NOT IN ('transfer_internal','setoran_tabungan','penarikan_tabungan')
        AND date(ce.occurred_at) BETWEEN ? AND ?`,
    )
    .get(dari, sampai) as { masuk: number; keluar: number };

  const transferInternal = database
    .prepare(
      `SELECT COALESCE(SUM(ce.amount_minor), 0) AS total FROM cash_event ce
        WHERE ce.direction = 'keluar'
          AND ce.kind IN ('transfer_internal','setoran_tabungan')
          AND ce.status <> 'dibatalkan'
          AND date(ce.occurred_at) BETWEEN ? AND ?`,
    )
    .get(dari, sampai) as { total: number };

  const biayaPribadi = sumAlloc(database, dari, sampai, 'biaya_pribadi', 'keluar');
  const refund = sumAlloc(database, dari, sampai, 'refund', 'masuk');
  const kreditLayanan = sumAlloc(database, dari, sampai, 'kredit_layanan', 'keluar');
  const koreksi =
    sumAlloc(database, dari, sampai, 'penyesuaian', 'keluar') -
    sumAlloc(database, dari, sampai, 'penyesuaian', 'masuk');

  const perKategori = database
    .prepare(
      `SELECT COALESCE(c.name, 'Tanpa kategori') AS kategori, SUM(a.amount_minor) AS minor
         FROM allocation a
         JOIN cash_event ce ON ce.id = a.cash_event_id
         LEFT JOIN category c ON c.id = COALESCE(a.category_id, ce.category_id)
        WHERE a.purpose IN ('biaya_pribadi','kredit_layanan')
          AND ce.direction = 'keluar'
          AND ce.status <> 'dibatalkan'
          AND date(ce.occurred_at) BETWEEN ? AND ?
        GROUP BY kategori ORDER BY minor DESC`,
    )
    .all(dari, sampai) as Array<{ kategori: string; minor: number }>;

  const tabungan = database
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'setoran_tabungan'   THEN amount_minor ELSE 0 END), 0) AS setoran,
         COALESCE(SUM(CASE WHEN kind = 'penarikan_tabungan' THEN amount_minor ELSE 0 END), 0) AS penarikan
       FROM cash_event
      WHERE status <> 'dibatalkan' AND date(occurred_at) BETWEEN ? AND ?`,
    )
    .get(dari, sampai) as { setoran: number; penarikan: number };

  const piutangBertambah =
    sumAlloc(database, dari, sampai, 'piutang_teman', 'keluar') +
    sumAlloc(database, dari, sampai, 'piutang_company', 'keluar');
  const piutangKembali = database
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM receivable_settlement
        WHERE settled_on BETWEEN ? AND ?`,
    )
    .get(dari, sampai) as { total: number };
  const piutangSisa = listReceivables({ onlyOpen: true }, database);

  const companyLangsung = sumAlloc(database, dari, sampai, 'biaya_company_langsung', 'keluar');
  const sayaTalangiCompany = sumAlloc(database, dari, sampai, 'piutang_company', 'keluar');
  const reimburseMasuk = database
    .prepare(
      `SELECT COALESCE(SUM(rs.amount_minor), 0) AS total
         FROM receivable_settlement rs JOIN receivable r ON r.id = rs.receivable_id
        WHERE r.debtor_type = 'company' AND rs.settled_on BETWEEN ? AND ?`,
    )
    .get(dari, sampai) as { total: number };

  const belumDibayar = listInvoices(
    {
      to: sampai,
      status: ['tagihan_baru', 'jatuh_tempo', 'gagal_bayar', 'perlu_verifikasi'],
    },
    database,
  ).map((i) => ({
    label: `${i.service_name ?? 'Tagihan'}${i.invoice_no ? ` #${i.invoice_no}` : ''}`,
    tanggal: i.due_date,
    nominal_minor: i.amount_minor,
    status: i.status,
    penanggung: i.bearer,
  }));

  const pemasukanSumber = database
    .prepare(
      `SELECT COALESCE(ce.counterparty, ce.merchant_raw, 'Tidak diketahui') AS sumber,
              SUM(a.amount_minor) AS minor
         FROM allocation a JOIN cash_event ce ON ce.id = a.cash_event_id
        WHERE a.purpose = 'pemasukan' AND ce.direction = 'masuk'
          AND ce.status <> 'dibatalkan'
          AND date(ce.occurred_at) BETWEEN ? AND ?
        GROUP BY sumber ORDER BY minor DESC`,
    )
    .all(dari, sampai) as Array<{ sumber: string; minor: number }>;

  if (belumDibayar.some((b) => b.nominal_minor === null)) {
    catatan.push('Ada tagihan tanpa nominal, jadi total kewajiban bulan ini belum lengkap.');
  }
  if (transferInternal.total > 0) {
    catatan.push(
      `Transfer antar rekening saya ${formatIDR(transferInternal.total)} tidak dihitung ` +
        'sebagai pemasukan maupun pengeluaran.',
    );
  }

  return {
    bulan: ym,
    label: namaBulan(ym),
    dari,
    sampai,
    arus_kas: {
      masuk_minor: kas.masuk,
      keluar_minor: kas.keluar,
      neto_minor: kas.masuk - kas.keluar,
      transfer_internal_minor: transferInternal.total,
    },
    biaya_pribadi_neto_minor: biayaPribadi + kreditLayanan - refund,
    biaya_pribadi_per_kategori: perKategori,
    tabungan: {
      setoran_minor: tabungan.setoran,
      penarikan_minor: tabungan.penarikan,
      neto_minor: tabungan.setoran - tabungan.penarikan,
    },
    piutang: {
      bertambah_minor: piutangBertambah,
      kembali_minor: piutangKembali.total,
      sisa_akhir_minor: piutangSisa.total_sisa_minor,
      sisa_teman_minor: piutangSisa.total_sisa_teman_minor,
      sisa_company_minor: piutangSisa.total_sisa_company_minor,
    },
    pengeluaran_company: {
      dibayar_company_langsung_minor: companyLangsung,
      saya_talangi_minor: sayaTalangiCompany,
      sudah_direimburse_minor: reimburseMasuk.total,
      belum_direimburse_minor: piutangSisa.total_sisa_company_minor,
    },
    tagihan_belum_dibayar: belumDibayar,
    kredit_layanan_minor: kreditLayanan,
    refund_minor: refund,
    koreksi_minor: koreksi,
    pemasukan_sumber: pemasukanSumber,
    catatan,
  };
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function monthlyReportCsv(ym: string, database: DB = db()): string {
  const r = monthlyReport(ym, database);
  const lines: string[] = [];
  const add = (...cells: unknown[]) => lines.push(cells.map(csvEscape).join(';'));

  add('Laporan bulanan BUnih', r.label);
  add('Periode', r.dari, r.sampai);
  add('');
  add('Bagian', 'Keterangan', 'Rupiah');
  add('Arus kas', 'Uang masuk', r.arus_kas.masuk_minor);
  add('Arus kas', 'Uang keluar', r.arus_kas.keluar_minor);
  add('Arus kas', 'Neto', r.arus_kas.neto_minor);
  add('Arus kas', 'Transfer antar rekening saya (bukan masuk/keluar)', r.arus_kas.transfer_internal_minor);
  add('Biaya pribadi', 'Neto setelah refund', r.biaya_pribadi_neto_minor);
  for (const k of r.biaya_pribadi_per_kategori) add('Biaya pribadi', k.kategori, k.minor);
  add('Tabungan', 'Setoran', r.tabungan.setoran_minor);
  add('Tabungan', 'Penarikan', r.tabungan.penarikan_minor);
  add('Tabungan', 'Neto', r.tabungan.neto_minor);
  add('Piutang', 'Bertambah bulan ini', r.piutang.bertambah_minor);
  add('Piutang', 'Kembali bulan ini', r.piutang.kembali_minor);
  add('Piutang', 'Sisa (teman)', r.piutang.sisa_teman_minor);
  add('Piutang', 'Sisa (company)', r.piutang.sisa_company_minor);
  add('Company', 'Dibayar company langsung', r.pengeluaran_company.dibayar_company_langsung_minor);
  add('Company', 'Saya talangi', r.pengeluaran_company.saya_talangi_minor);
  add('Company', 'Sudah direimburse', r.pengeluaran_company.sudah_direimburse_minor);
  add('Company', 'Belum direimburse', r.pengeluaran_company.belum_direimburse_minor);
  add('Kredit layanan', 'Pembelian sesuai pemakaian', r.kredit_layanan_minor);
  add('Refund', 'Pengembalian dana', r.refund_minor);
  add('');
  add('Tagihan belum dibayar', 'Tanggal', 'Rupiah', 'Status', 'Penanggung');
  for (const t of r.tagihan_belum_dibayar)
    add(t.label, t.tanggal, t.nominal_minor, t.status, t.penanggung);
  add('');
  add('Catatan');
  for (const c of r.catatan) add(c);
  return lines.join('\n');
}

/** Ekspor seluruh transaksi untuk dibandingkan dengan Sheet. */
export function transactionsCsv(
  opts: { dari?: IsoDate; sampai?: IsoDate } = {},
  database: DB = db(),
): string {
  const dari = opts.dari ?? '1970-01-01';
  const sampai = opts.sampai ?? '2999-12-31';
  const rows = database
    .prepare(
      `SELECT ce.id, ce.occurred_at, ce.direction, ce.amount_minor, ce.currency, ce.kind,
              ce.merchant_raw, ce.counterparty, ce.reference_no, ce.status, ce.certainty, ce.source,
              ce.transfer_group_id, a.name AS rekening, s.name AS layanan,
              (SELECT GROUP_CONCAT(al.purpose || '=' || al.amount_minor, '|')
                 FROM allocation al WHERE al.cash_event_id = ce.id) AS alokasi,
              (SELECT COUNT(*) FROM cash_event_evidence cee WHERE cee.cash_event_id = ce.id) AS jumlah_bukti
         FROM cash_event ce
         LEFT JOIN account a ON a.id = ce.account_id
         LEFT JOIN service s ON s.id = ce.service_id
        WHERE date(ce.occurred_at) BETWEEN ? AND ?
        ORDER BY ce.occurred_at, ce.id`,
    )
    .all(dari, sampai) as Array<Record<string, unknown>>;

  const header = [
    'id', 'waktu', 'arah', 'nominal', 'mata_uang', 'jenis', 'merchant', 'pihak_lain',
    'no_referensi', 'status', 'kepastian', 'sumber', 'grup_transfer', 'rekening', 'layanan',
    'alokasi', 'jumlah_bukti',
  ];
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push(
      [
        r['id'], r['occurred_at'], r['direction'], r['amount_minor'], r['currency'], r['kind'],
        r['merchant_raw'], r['counterparty'], r['reference_no'], r['status'], r['certainty'],
        r['source'], r['transfer_group_id'], r['rekening'], r['layanan'], r['alokasi'],
        r['jumlah_bukti'],
      ]
        .map(csvEscape)
        .join(';'),
    );
  }
  return lines.join('\n');
}
