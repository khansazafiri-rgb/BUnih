import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { addDays, endOfMonth, formatTanggal, namaBulan, nowIso, today, type IsoDate } from './time.js';
import { formatIDR } from './money.js';
import { categoryMap } from './categories.js';
import { spendRows, sumSpend } from './spend.js';
import { persenPerubahan, resolveRange, spendingByCategory } from './analytics.js';
import { listBudgets, type BudgetEval } from './budgets.js';
import { listGoals, type GoalEval } from './goals.js';
import { balanceSummary } from './balances.js';
import { tagihanMendekat } from './services.js';
import { countOpenDecisions } from './decisions.js';
import { listReceivables } from './receivables.js';
import { project } from './projection.js';
import { buildInsightsUntukDashboard } from './dashboardInsight.js';

export type Wajah = 'senang' | 'biasa' | 'khawatir' | 'kosong';

export type Jawaban = {
  wajah: Wajah;
  /** Kata pendek yang selalu tampil di samping ikon wajah, supaya status tidak bergantung pada gambar/warna. */
  judul: string;
  kalimat: string;
  alasan: string[];
};

export type LangkahMulai = { kunci: string; label: string; selesai: boolean; tautan: string };

export function getSetting<T>(key: string, fallback: T, database: DB = db()): T {
  const row = database.prepare(`SELECT value_json FROM app_setting WHERE key = ?`).get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown, database: DB = db()): void {
  database
    .prepare(
      `INSERT INTO app_setting (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), nowIso());
}

/**
 * Kalimat jawaban untuk pertanyaan paling dasar: "keadaanku sekarang bagaimana?"
 * Aturannya pasti dan urut dari yang paling mendesak. Tidak ada kalimat yang tidak punya angka di baliknya.
 */
export function susunJawaban(input: {
  adaData: boolean;
  dipakaiBulanIni: number;
  budgets: BudgetEval[];
  defisitTanggal: IsoDate | null;
  saldoTerverifikasi: boolean;
}): Jawaban {
  const lewat = input.budgets.filter((b) => b.status === 'lewat');
  const berisiko = input.budgets.filter((b) => b.status === 'berisiko');
  const alasan: string[] = [];

  if (!input.adaData) {
    return {
      wajah: 'kosong',
      judul: 'Mulai dari sini',
      kalimat: 'Belum ada catatan. Catat pengeluaran pertamamu, lalu BUnih akan menunjukkan ke mana uangmu pergi.',
      alasan,
    };
  }

  if (lewat.length) {
    for (const b of lewat) alasan.push(`${b.nama}: lewat ${formatIDR(-b.sisa_minor)} dari batas ${formatIDR(b.dialokasikan_minor)}.`);
    return {
      wajah: 'khawatir',
      judul: 'Perlu perhatian',
      kalimat:
        lewat.length === 1
          ? `Anggaran ${lewat[0]!.nama} sudah terlewati ${formatIDR(-lewat[0]!.sisa_minor)}.`
          : `${lewat.length} anggaran sudah terlewati.`,
      alasan,
    };
  }

  if (input.defisitTanggal && input.saldoTerverifikasi) {
    alasan.push('Ini perkiraan dari saldo terverifikasi, tagihan, dan rencana yang sudah kamu atur.');
    return {
      wajah: 'khawatir',
      judul: 'Perlu perhatian',
      kalimat: `Uangmu diperkirakan tidak cukup mulai ${formatTanggal(input.defisitTanggal)}.`,
      alasan,
    };
  }

  if (berisiko.length) {
    for (const b of berisiko)
      alasan.push(`${b.nama}: perkiraan akhir periode ${formatIDR(b.perkiraan_akhir_minor ?? 0)} dari batas ${formatIDR(b.dialokasikan_minor)} (estimasi).`);
    return {
      wajah: 'biasa',
      judul: 'Hati-hati',
      kalimat:
        berisiko.length === 1
          ? `Kalau lajunya begini, anggaran ${berisiko[0]!.nama} bisa terlewati.`
          : `${berisiko.length} anggaran bisa terlewati kalau lajunya begini.`,
      alasan,
    };
  }

  if (input.budgets.length) {
    return {
      wajah: 'senang',
      judul: 'Aman',
      kalimat: 'Semua anggaranmu masih di bawah batas. Teruskan!',
      alasan,
    };
  }

  return {
    wajah: 'biasa',
    judul: 'Belum ada batas',
    kalimat: 'Pengeluaranmu sudah tercatat. Buat anggaran supaya kamu tahu kapan harus mengerem.',
    alasan,
  };
}

export function langkahMulai(database: DB, hariIni: IsoDate): LangkahMulai[] {
  const n = (sql: string) => (database.prepare(sql).get() as { n: number }).n;
  const rekeningBelum = n(`SELECT COUNT(*) AS n FROM account WHERE is_mine = 1 AND active = 1 AND verified = 0`);
  const gmail = n(`SELECT COUNT(*) AS n FROM oauth_token WHERE provider = 'google'`) > 0;
  void hariIni;
  return [
    {
      kunci: 'rekening',
      label: 'Konfirmasi empat digit terakhir rekeningmu',
      selesai: rekeningBelum === 0 && n(`SELECT COUNT(*) AS n FROM account WHERE is_mine = 1 AND active = 1`) > 0,
      tautan: '#/pengaturan',
    },
    {
      kunci: 'saldo',
      label: 'Isi saldo rekening hari ini',
      selesai: n(`SELECT COUNT(*) AS n FROM reconciliation`) > 0,
      tautan: '#/pengaturan',
    },
    {
      kunci: 'transaksi',
      label: 'Catat transaksi pertama',
      selesai: n(`SELECT COUNT(*) AS n FROM cash_event WHERE status <> 'dibatalkan'`) > 0,
      tautan: '#/transaksi',
    },
    {
      kunci: 'anggaran',
      label: 'Buat anggaran pertama',
      selesai: n(`SELECT COUNT(*) AS n FROM budget WHERE active = 1`) > 0,
      tautan: '#/anggaran',
    },
    {
      kunci: 'tujuan',
      label: 'Buat tujuan tabungan pertama',
      selesai: n(`SELECT COUNT(*) AS n FROM goal WHERE status <> 'dibatalkan'`) > 0,
      tautan: '#/tujuan',
    },
    {
      kunci: 'telegram',
      label: 'Hubungkan bot Telegram',
      selesai: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_ALLOWED_CHAT_ID),
      tautan: '#/pengaturan',
    },
    { kunci: 'gmail', label: 'Hubungkan Gmail (opsional)', selesai: gmail, tautan: '#/pengaturan' },
  ];
}

export type DataDashboard = ReturnType<typeof ringkasanDashboard>;

export function ringkasanDashboard(database: DB = db(), hariIni: IsoDate = today()) {
  const r = resolveRange({ preset: 'bulan_ini' }, hariIni);
  const peta = categoryMap(database);
  const rows = spendRows(r.dari, r.sampai, {}, database);
  const prev = spendRows(r.sebelumnya.dari, r.sebelumnya.sampai, {}, database);
  const total = sumSpend(rows);
  const totalSebelumnya = sumSpend(prev);

  const kategoriSemua = spendingByCategory(rows, prev, peta);
  const teratas = kategoriSemua.slice(0, 5);
  const sisa = kategoriSemua.slice(5);
  const lainnyaMinor = sisa.reduce((s, k) => s + Math.max(0, k.jumlah_minor), 0);

  const budgets = listBudgets({ asOf: hariIni }, database);
  const goals = listGoals({ asOf: hariIni }, database);
  const tagihan = tagihanMendekat({ hari: 14, asOf: hariIni }, database);
  const saldo = balanceSummary(undefined, database);
  const piutang = listReceivables({ onlyOpen: true }, database);

  let proyeksi: { saldo_terendah_minor: number; saldo_terendah_tanggal: IsoDate; tanggal_defisit: IsoDate | null } | null = null;
  if (saldo.akun_terverifikasi > 0) {
    const p = project({ dari: hariIni, sampai: addDays(hariIni, 30) }, database);
    proyeksi = {
      saldo_terendah_minor: p.ringkasan.saldo_terendah_minor,
      saldo_terendah_tanggal: p.ringkasan.saldo_terendah_tanggal,
      tanggal_defisit: p.ringkasan.tanggal_defisit,
    };
  }

  // Pengeluaran 7 hari terakhir, satu batang per hari.
  const tujuhAwal = addDays(hariIni, -6);
  const tujuhRows = spendRows(tujuhAwal, hariIni, {}, database);
  const perHari = new Map<string, number>();
  for (const x of tujuhRows) perHari.set(x.tanggal, (perHari.get(x.tanggal) ?? 0) + x.jumlah_minor);
  const tujuhHari = Array.from({ length: 7 }, (_, i) => {
    const t = addDays(tujuhAwal, i);
    return { tanggal: t, label: ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'][new Date(`${t}T00:00:00Z`).getUTCDay()]!, jumlah_minor: perHari.get(t) ?? 0, hari_ini: t === hariIni };
  });

  const jumlahTransaksi = (database.prepare(`SELECT COUNT(*) AS n FROM cash_event WHERE status <> 'dibatalkan'`).get() as { n: number }).n;
  const adaData = jumlahTransaksi > 0 || budgets.length > 0 || goals.length > 0;

  const jawaban = susunJawaban({
    adaData: jumlahTransaksi > 0,
    dipakaiBulanIni: total,
    budgets,
    defisitTanggal: proyeksi?.tanggal_defisit ?? null,
    saldoTerverifikasi: saldo.akun_terverifikasi > 0,
  });

  const belum = rows.filter((x) => x.category_id === null);
  const tanpaPasangan = (database.prepare(`SELECT COUNT(*) AS n FROM cash_event WHERE status = 'menunggu_pasangan'`).get() as { n: number }).n;
  const perhatian: Array<{ tipe: string; teks: string; tautan: string }> = [];
  const keputusan = countOpenDecisions(database);
  if (keputusan > 0) perhatian.push({ tipe: 'keputusan', teks: `${keputusan} pertanyaan menunggu jawabanmu`, tautan: '#/transaksi' });
  if (belum.length) perhatian.push({ tipe: 'kategori', teks: `${new Set(belum.map((x) => x.cash_event_id)).size} transaksi belum punya kategori`, tautan: '#/analitik' });
  if (tanpaPasangan) perhatian.push({ tipe: 'transfer', teks: `${tanpaPasangan} transfer menunggu pasangannya`, tautan: '#/tabungan' });
  const terlambat = tagihan.daftar.filter((d) => d.terlambat && d.aktif_di_skenario && d.memotong_saldo_saya);
  if (terlambat.length) perhatian.push({ tipe: 'tagihan', teks: `${terlambat.length} tagihan sudah lewat jatuh tempo`, tautan: '#/tagihan' });
  if (piutang.jumlah_terlambat) perhatian.push({ tipe: 'piutang', teks: `${piutang.jumlah_terlambat} piutang belum dibayar lewat waktunya`, tautan: '#/reimburse' });
  const tujuanRisiko = goals.filter((g) => g.risiko === 'berisiko' || g.risiko === 'terlambat');
  if (tujuanRisiko.length) perhatian.push({ tipe: 'tujuan', teks: `${tujuanRisiko.length} tujuan berisiko tidak tercapai tepat waktu`, tautan: '#/tujuan' });

  const urutanBudget = { lewat: 0, berisiko: 1, aman: 2, belum_mulai: 3, selesai: 4 } as const;
  const langkah = langkahMulai(database, hariIni);
  const tutup = getSetting<boolean>('onboarding_ditutup', false, database);

  return {
    hari_ini: hariIni,
    bulan: namaBulan(hariIni.slice(0, 7)),
    adaData,
    jawaban,
    uang: {
      saldo_terverifikasi_minor: saldo.akun_terverifikasi > 0 ? saldo.total_terverifikasi_minor : null,
      lengkap: saldo.lengkap,
      rekening: saldo.rekening.map((x) => ({
        nama: x.name,
        last4: x.last4,
        saldo_minor: x.balance_minor,
        tabungan: x.is_savings_target,
      })),
      dalam_perjalanan_minor: saldo.dalam_perjalanan_minor,
      catatan: saldo.catatan,
    },
    pemakaian: {
      dari: r.dari,
      sampai: r.sampai,
      hari_berjalan: r.hari,
      hari_dalam_bulan: Number(endOfMonth(hariIni).slice(8)),
      total_minor: total,
      sebelumnya_minor: totalSebelumnya,
      sebelumnya_label: r.sebelumnya.label,
      perubahan_persen: persenPerubahan(total, totalSebelumnya),
      rata_per_hari_minor: Math.round(total / Math.max(1, r.hari)),
      kategori: teratas.map((k) => ({ category_id: k.category_id, nama: k.nama, ikon: k.ikon, jumlah_minor: k.jumlah_minor, persen: k.persen, belum_dikategorikan: k.belum_dikategorikan })),
      lainnya_minor: lainnyaMinor,
      lainnya_jumlah: sisa.length,
    },
    tujuh_hari: tujuhHari,
    anggaran: [...budgets].sort((a, b) => urutanBudget[a.status] - urutanBudget[b.status] || b.persen_terpakai - a.persen_terpakai).slice(0, 5),
    anggaran_total: budgets.length,
    tujuan: goals.filter((g) => g.status === 'aktif').slice(0, 3) as GoalEval[],
    tujuan_total: goals.length,
    tagihan: {
      daftar: tagihan.daftar.filter((d) => d.aktif_di_skenario && d.memotong_saldo_saya).slice(0, 4),
      dana_14_hari_minor: tagihan.dana_perlu_disiapkan_minor,
      tanpa_nominal: tagihan.jumlah_tanpa_nominal,
    },
    proyeksi,
    perlu_perhatian: perhatian,
    insight: buildInsightsUntukDashboard(database, hariIni).slice(0, 3),
    mulai: { langkah, selesai: langkah.filter((l) => ['saldo', 'transaksi', 'anggaran', 'tujuan'].includes(l.kunci)).every((l) => l.selesai), ditutup: tutup },
  };
}
