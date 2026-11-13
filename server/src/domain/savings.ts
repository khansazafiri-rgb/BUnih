import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { startOfMonth, today, type IsoDate } from './time.js';
import { accountBalance, listAccounts } from './balances.js';
import { numberAssumption } from './assumptions.js';

export type SavingsReport = {
  rekening_tabungan: Array<{
    account_id: number;
    nama: string;
    last4: string | null;
    saldo_minor: number | null;
    saldo_terverifikasi: boolean;
    penjelasan: string[];
  }>;
  setoran_total_minor: number;
  penarikan_total_minor: number;
  neto_minor: number;
  bulan_ini: { setoran_minor: number; penarikan_minor: number; neto_minor: number };
  target_bulanan_minor: number;
  pencapaian_bulan_ini_persen: number | null;
  menunggu_pasangan: Array<{
    cash_event_id: number;
    tanggal: string;
    nominal_minor: number;
    dari: string | null;
  }>;
  riwayat: Array<{
    cash_event_id: number;
    tanggal: string;
    jenis: 'setoran' | 'penarikan';
    nominal_minor: number;
    dari_rekening: string | null;
    status: string;
    berpasangan: boolean;
  }>;
  catatan: string[];
};

/**
 * Tabungan: transfer Mandiri -> BCA milik saya.
 * Setoran bukan pengeluaran, penarikan bukan pendapatan — keduanya perpindahan
 * uang saya sendiri. Saldo BCA hanya diklaim bila sudah direkonsiliasi.
 */
export function savingsReport(
  opts: { asOf?: IsoDate } = {},
  database: DB = db(),
): SavingsReport {
  const asOf = opts.asOf ?? today();
  const awalBulan = startOfMonth(asOf);
  const catatan: string[] = [];

  const targets = listAccounts(database, true).filter((a) => a.is_savings_target === 1);
  const rekening = targets.map((a) => {
    const bal = accountBalance(a.id, `${asOf}T23:59:59+07:00`, database);
    return {
      account_id: a.id,
      nama: a.name,
      last4: a.last4,
      saldo_minor: bal.balance_minor,
      saldo_terverifikasi: bal.balance_minor !== null,
      penjelasan: bal.catatan,
    };
  });
  if (!targets.length) {
    catatan.push('Belum ada rekening yang ditandai sebagai rekening tabungan.');
  }

  const riwayatRows = database
    .prepare(
      `SELECT ce.id, ce.occurred_at, ce.kind, ce.amount_minor, ce.status, ce.transfer_group_id,
              a.name AS account_name
         FROM cash_event ce LEFT JOIN account a ON a.id = ce.account_id
        WHERE ce.kind IN ('setoran_tabungan','penarikan_tabungan')
          AND ce.status <> 'dibatalkan'
          AND date(ce.occurred_at) <= ?
        ORDER BY ce.occurred_at DESC, ce.id DESC`,
    )
    .all(asOf) as Array<Record<string, unknown>>;

  const riwayat = riwayatRows.map((r) => ({
    cash_event_id: Number(r['id']),
    tanggal: String(r['occurred_at']),
    jenis: (String(r['kind']) === 'setoran_tabungan' ? 'setoran' : 'penarikan') as
      | 'setoran'
      | 'penarikan',
    nominal_minor: Number(r['amount_minor']),
    dari_rekening: (r['account_name'] as string | null) ?? null,
    status: String(r['status']),
    berpasangan: r['transfer_group_id'] !== null,
  }));

  const setoran = riwayat.filter((r) => r.jenis === 'setoran');
  const penarikan = riwayat.filter((r) => r.jenis === 'penarikan');
  const setoranTotal = setoran.reduce((s, r) => s + r.nominal_minor, 0);
  const penarikanTotal = penarikan.reduce((s, r) => s + r.nominal_minor, 0);

  const bulanSetoran = setoran
    .filter((r) => r.tanggal.slice(0, 10) >= awalBulan)
    .reduce((s, r) => s + r.nominal_minor, 0);
  const bulanPenarikan = penarikan
    .filter((r) => r.tanggal.slice(0, 10) >= awalBulan)
    .reduce((s, r) => s + r.nominal_minor, 0);

  const target = numberAssumption('target_tabungan_bulanan', 0, asOf, database).value;

  const menunggu = riwayat
    .filter((r) => !r.berpasangan && r.status === 'menunggu_pasangan')
    .map((r) => ({
      cash_event_id: r.cash_event_id,
      tanggal: r.tanggal,
      nominal_minor: r.nominal_minor,
      dari: r.dari_rekening,
    }));
  if (menunggu.length) {
    catatan.push(
      `${menunggu.length} setoran/penarikan baru terlihat satu sisinya. Uangnya tidak hilang, ` +
        'tetapi sisi rekening tujuan belum terlihat sehingga saldo tabungan belum dapat dipastikan dari sini.',
    );
  }
  if (rekening.some((r) => !r.saldo_terverifikasi)) {
    catatan.push(
      'Saldo BCA belum dapat diverifikasi dari email saja. Impor mutasi atau masukkan saldo ' +
        'terkonfirmasi agar angka tabungan menjadi saldo sebenarnya.',
    );
  }

  return {
    rekening_tabungan: rekening,
    setoran_total_minor: setoranTotal,
    penarikan_total_minor: penarikanTotal,
    neto_minor: setoranTotal - penarikanTotal,
    bulan_ini: {
      setoran_minor: bulanSetoran,
      penarikan_minor: bulanPenarikan,
      neto_minor: bulanSetoran - bulanPenarikan,
    },
    target_bulanan_minor: target,
    pencapaian_bulan_ini_persen:
      target > 0 ? Math.round(((bulanSetoran - bulanPenarikan) / target) * 100) : null,
    menunggu_pasangan: menunggu,
    riwayat,
    catatan,
  };
}
