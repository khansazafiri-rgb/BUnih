import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import {
  addDays, addMonths, diffDays, endOfMonth, startOfMonth, startOfWeek, today, minDate, eachDay, namaBulan,
  type IsoDate,
} from './time.js';
import { formatIDR } from './money.js';
import {
  categoryBySlug, categoryMap, categoryRootId, categorySubtreeIds, type CategoryRow,
} from './categories.js';
import { cashFlow, incomeTotal, spendRows, sumSpend, type SpendRow } from './spend.js';
import { evaluateBudget, listBudgets, getBudget, type BudgetEval, type BudgetRow } from './budgets.js';
import { listGoals, type GoalEval } from './goals.js';
import { balanceSummary } from './balances.js';
import { tagihanMendekat } from './services.js';

/* ------------------------------------------------------------------ rentang waktu */

export type RentangSpec = { preset?: string; dari?: IsoDate; sampai?: IsoDate };

export type Rentang = {
  preset: string;
  label: string;
  dari: IsoDate;
  sampai: IsoDate;
  hari: number;
  /** Periode pembanding yang ADIL: panjangnya sama dengan yang sudah berjalan. */
  sebelumnya: { dari: IsoDate; sampai: IsoDate; hari: number; label: string };
};

export const PRESET_RENTANG = ['bulan_ini', 'bulan_lalu', '7_hari', '30_hari', '90_hari', 'tahun_ini', 'kustom'];

/**
 * Tentukan rentang dan pembandingnya. Bulan berjalan dibandingkan dengan jumlah hari yang sama
 * di bulan sebelumnya (hari ke-1 sampai ke-N), BUKAN seluruh bulan lalu, supaya "naik 60%"
 * tidak muncul hanya karena bulan ini belum selesai.
 */
export function resolveRange(spec: RentangSpec = {}, hariIni: IsoDate = today()): Rentang {
  const preset = spec.preset && PRESET_RENTANG.includes(spec.preset) ? spec.preset : spec.dari ? 'kustom' : 'bulan_ini';
  let dari: IsoDate;
  let sampai: IsoDate;
  let label: string;

  switch (preset) {
    case 'bulan_lalu': {
      dari = startOfMonth(addMonths(hariIni, -1));
      sampai = endOfMonth(dari);
      label = namaBulan(dari.slice(0, 7));
      break;
    }
    case '7_hari':
      sampai = hariIni;
      dari = addDays(hariIni, -6);
      label = '7 hari terakhir';
      break;
    case '30_hari':
      sampai = hariIni;
      dari = addDays(hariIni, -29);
      label = '30 hari terakhir';
      break;
    case '90_hari':
      sampai = hariIni;
      dari = addDays(hariIni, -89);
      label = '90 hari terakhir';
      break;
    case 'tahun_ini':
      dari = `${hariIni.slice(0, 4)}-01-01`;
      sampai = hariIni;
      label = `Tahun ${hariIni.slice(0, 4)}`;
      break;
    case 'kustom':
      dari = spec.dari ?? startOfMonth(hariIni);
      sampai = spec.sampai ?? hariIni;
      if (sampai < dari) [dari, sampai] = [sampai, dari];
      label = 'Rentang pilihan';
      break;
    default:
      dari = startOfMonth(hariIni);
      sampai = hariIni;
      label = `${namaBulan(hariIni.slice(0, 7))} sampai hari ini`;
  }

  const hari = diffDays(dari, sampai) + 1;
  let sbDari: IsoDate;
  let sbSampai: IsoDate;
  let sbLabel: string;
  if (preset === 'bulan_ini' || preset === 'bulan_lalu') {
    sbDari = startOfMonth(addMonths(dari, -1));
    sbSampai = minDate(addDays(sbDari, hari - 1), endOfMonth(sbDari));
    sbLabel = `${namaBulan(sbDari.slice(0, 7))}, hari ke-1 sampai ke-${diffDays(sbDari, sbSampai) + 1}`;
  } else if (preset === 'tahun_ini') {
    sbDari = `${Number(dari.slice(0, 4)) - 1}-01-01`;
    sbSampai = addMonths(sampai, -12);
    sbLabel = `Tahun ${sbDari.slice(0, 4)} pada rentang yang sama`;
  } else {
    sbSampai = addDays(dari, -1);
    sbDari = addDays(sbSampai, -(hari - 1));
    sbLabel = `${hari} hari sebelumnya`;
  }
  return {
    preset,
    label,
    dari,
    sampai,
    hari,
    sebelumnya: { dari: sbDari, sampai: sbSampai, hari: diffDays(sbDari, sbSampai) + 1, label: sbLabel },
  };
}

export function persenPerubahan(sekarang: number, sebelumnya: number): number | null {
  if (sebelumnya <= 0) return null;
  return Math.round(((sekarang - sebelumnya) / sebelumnya) * 100);
}

const bulat1 = (x: number) => Math.round(x * 10) / 10;

/* ------------------------------------------------------------------ kategori */

export type KategoriBaris = {
  category_id: number | null;
  nama: string;
  ikon: string;
  jumlah_minor: number;
  persen: number;
  jumlah_transaksi: number;
  sebelumnya_minor: number;
  perubahan_persen: number | null;
  belum_dikategorikan: boolean;
  anak: Array<{ category_id: number | null; nama: string; ikon: string; jumlah_minor: number; jumlah_transaksi: number }>;
};

export function spendingByCategory(
  rows: SpendRow[],
  prevRows: SpendRow[],
  peta: Map<number, CategoryRow>,
): KategoriBaris[] {
  const agregasi = (data: SpendRow[]) => {
    const root = new Map<
      number | null,
      { jumlah: number; events: Set<number>; anak: Map<number | null, { jumlah: number; events: Set<number> }> }
    >();
    for (const r of data) {
      const akar = r.category_id === null ? null : categoryRootId(r.category_id, peta);
      const g = root.get(akar) ?? { jumlah: 0, events: new Set<number>(), anak: new Map() };
      g.jumlah += r.jumlah_minor;
      g.events.add(r.cash_event_id);
      const a = g.anak.get(r.category_id) ?? { jumlah: 0, events: new Set<number>() };
      a.jumlah += r.jumlah_minor;
      a.events.add(r.cash_event_id);
      g.anak.set(r.category_id, a);
      root.set(akar, g);
    }
    return root;
  };

  const sekarang = agregasi(rows);
  const sebelum = agregasi(prevRows);
  const total = [...sekarang.values()].reduce((s, g) => s + Math.max(0, g.jumlah), 0);

  const out: KategoriBaris[] = [];
  for (const [akar, g] of sekarang) {
    if (g.jumlah === 0) continue;
    const kat = akar !== null ? peta.get(akar) : undefined;
    const prev = sebelum.get(akar)?.jumlah ?? 0;
    out.push({
      category_id: akar,
      nama: kat?.name ?? 'Belum dikategorikan',
      ikon: kat?.icon ?? '❔',
      jumlah_minor: g.jumlah,
      persen: total > 0 && g.jumlah > 0 ? bulat1((g.jumlah / total) * 100) : 0,
      jumlah_transaksi: g.events.size,
      sebelumnya_minor: prev,
      perubahan_persen: persenPerubahan(g.jumlah, prev),
      belum_dikategorikan: akar === null,
      anak: [...g.anak.entries()]
        .map(([id, a]) => {
          const k = id !== null ? peta.get(id) : undefined;
          return {
            category_id: id,
            nama: k?.name ?? 'Belum dikategorikan',
            ikon: k?.icon ?? '❔',
            jumlah_minor: a.jumlah,
            jumlah_transaksi: a.events.size,
          };
        })
        .filter((a) => a.jumlah_minor !== 0)
        .sort((a, b) => b.jumlah_minor - a.jumlah_minor),
    });
  }
  return out.sort((a, b) => b.jumlah_minor - a.jumlah_minor);
}

/* ------------------------------------------------------------------ merchant */

export type MerchantBaris = {
  merchant_id: number | null;
  nama: string;
  jumlah_transaksi: number;
  total_minor: number;
  rata_rata_minor: number;
  pertama: string;
  terakhir: string;
  sebelumnya_transaksi: number;
  sebelumnya_total_minor: number;
  perubahan_transaksi: number;
};

export function merchantStats(rows: SpendRow[], prevRows: SpendRow[]): MerchantBaris[] {
  const kunci = (r: SpendRow) =>
    r.merchant_id !== null ? `m${r.merchant_id}` : r.merchant_name ? `n${r.merchant_name.toLowerCase()}` : null;
  type Acc = { id: number | null; nama: string; events: Set<number>; total: number; pertama: string; terakhir: string };
  const bangun = (data: SpendRow[]) => {
    const peta = new Map<string, Acc>();
    for (const r of data) {
      const k = kunci(r);
      if (!k) continue;
      const a = peta.get(k) ?? {
        id: r.merchant_id,
        nama: r.merchant_name ?? 'Tanpa nama',
        events: new Set<number>(),
        total: 0,
        pertama: r.tanggal,
        terakhir: r.tanggal,
      };
      a.events.add(r.cash_event_id);
      a.total += r.jumlah_minor;
      if (r.tanggal < a.pertama) a.pertama = r.tanggal;
      if (r.tanggal > a.terakhir) a.terakhir = r.tanggal;
      peta.set(k, a);
    }
    return peta;
  };
  const sekarang = bangun(rows);
  const sebelum = bangun(prevRows);
  return [...sekarang.entries()].map(([k, a]) => {
    const p = sebelum.get(k);
    return {
      merchant_id: a.id,
      nama: a.nama,
      jumlah_transaksi: a.events.size,
      total_minor: a.total,
      rata_rata_minor: a.events.size ? Math.round(a.total / a.events.size) : 0,
      pertama: a.pertama,
      terakhir: a.terakhir,
      sebelumnya_transaksi: p?.events.size ?? 0,
      sebelumnya_total_minor: p?.total ?? 0,
      perubahan_transaksi: a.events.size - (p?.events.size ?? 0),
    };
  });
}

/* ------------------------------------------------------------------ makanan */

export type AnalisisMakanan = {
  tersedia: boolean;
  alasan?: string;
  total_minor: number;
  jumlah_transaksi: number;
  rata_per_hari_minor: number;
  hari_berjalan: number;
  hari_dengan_catatan: number;
  hari_tanpa_catatan: number;
  sebelumnya_total_minor: number;
  perubahan_persen: number | null;
  paling_sering: MerchantBaris[];
  paling_besar_total: MerchantBaris[];
  transaksi_termahal: Array<{ cash_event_id: number; tanggal: string; merchant: string; jumlah_minor: number }>;
  tren_bulanan: Array<{ bulan: string; label: string; total_minor: number }>;
  anggaran: BudgetEval | null;
  /** Makanan tanpa merchant dikenali tidak ikut peringkat merchant, tapi tetap dihitung di total. */
  tanpa_merchant_jumlah: number;
};

export function foodAnalysis(r: Rentang, hariIni: IsoDate, database: DB): AnalisisMakanan {
  const makan = categoryBySlug('makan', database);
  const kosong: AnalisisMakanan = {
    tersedia: false,
    total_minor: 0,
    jumlah_transaksi: 0,
    rata_per_hari_minor: 0,
    hari_berjalan: 0,
    hari_dengan_catatan: 0,
    hari_tanpa_catatan: 0,
    sebelumnya_total_minor: 0,
    perubahan_persen: null,
    paling_sering: [],
    paling_besar_total: [],
    transaksi_termahal: [],
    tren_bulanan: [],
    anggaran: null,
    tanpa_merchant_jumlah: 0,
  };
  if (!makan || !makan.active) return { ...kosong, alasan: 'Kategori makanan tidak aktif atau tidak ada.' };

  const ids = categorySubtreeIds(makan.id, database);
  const rows = spendRows(r.dari, r.sampai, { categoryIds: ids }, database);
  const prev = spendRows(r.sebelumnya.dari, r.sebelumnya.sampai, { categoryIds: ids }, database);
  const total = sumSpend(rows);
  const akhir = minDate(r.sampai, hariIni);
  const hariBerjalan = Math.max(1, diffDays(r.dari, akhir) + 1);
  const hariAda = new Set(rows.map((x) => x.tanggal)).size;
  const merchants = merchantStats(rows, prev);

  // Transaksi termahal: gabungkan potongan dari satu transaksi.
  const perEvent = new Map<number, { tanggal: string; merchant: string; jumlah: number }>();
  for (const x of rows) {
    const e = perEvent.get(x.cash_event_id) ?? { tanggal: x.tanggal, merchant: x.merchant_name ?? 'Tanpa nama', jumlah: 0 };
    e.jumlah += x.jumlah_minor;
    perEvent.set(x.cash_event_id, e);
  }

  // Tren 6 bulan terakhir, berakhir pada bulan dari akhir rentang.
  const tren: AnalisisMakanan['tren_bulanan'] = [];
  for (let i = 5; i >= 0; i -= 1) {
    const awal = startOfMonth(addMonths(r.sampai, -i));
    const bulanRows = spendRows(awal, endOfMonth(awal), { categoryIds: ids }, database);
    tren.push({ bulan: awal.slice(0, 7), label: namaBulan(awal.slice(0, 7)), total_minor: sumSpend(bulanRows) });
  }

  const anggaranRow = database
    .prepare(`SELECT * FROM budget WHERE active = 1 AND category_id = ? ORDER BY id LIMIT 1`)
    .get(makan.id) as BudgetRow | undefined;

  return {
    tersedia: true,
    total_minor: total,
    jumlah_transaksi: new Set(rows.map((x) => x.cash_event_id)).size,
    rata_per_hari_minor: Math.round(total / hariBerjalan),
    hari_berjalan: hariBerjalan,
    hari_dengan_catatan: hariAda,
    hari_tanpa_catatan: Math.max(0, hariBerjalan - hariAda),
    sebelumnya_total_minor: sumSpend(prev),
    perubahan_persen: persenPerubahan(total, sumSpend(prev)),
    paling_sering: [...merchants].sort((a, b) => b.jumlah_transaksi - a.jumlah_transaksi || b.total_minor - a.total_minor).slice(0, 5),
    paling_besar_total: [...merchants].sort((a, b) => b.total_minor - a.total_minor).slice(0, 5),
    transaksi_termahal: [...perEvent.entries()]
      .map(([id, e]) => ({ cash_event_id: id, tanggal: e.tanggal, merchant: e.merchant, jumlah_minor: e.jumlah }))
      .sort((a, b) => b.jumlah_minor - a.jumlah_minor)
      .slice(0, 5),
    tren_bulanan: tren,
    anggaran: anggaranRow ? evaluateBudget(anggaranRow, akhir, database) : null,
    tanpa_merchant_jumlah: new Set(rows.filter((x) => x.merchant_id === null && !x.merchant_name).map((x) => x.cash_event_id)).size,
  };
}

/* ------------------------------------------------------------------ tren */

export type TitikTren = {
  awal: IsoDate;
  akhir: IsoDate;
  label: string;
  pengeluaran_minor: number;
  pemasukan_minor: number;
};

export function trendSeries(r: Rentang, rows: SpendRow[], database: DB): { granularitas: 'harian' | 'mingguan' | 'bulanan'; titik: TitikTren[] } {
  const granularitas = r.hari <= 31 ? 'harian' : r.hari <= 120 ? 'mingguan' : 'bulanan';
  const pemasukan = database
    .prepare(
      `SELECT date(ce.occurred_at) AS tanggal, COALESCE(SUM(a.amount_minor),0) AS total
         FROM allocation a JOIN cash_event ce ON ce.id = a.cash_event_id
        WHERE a.purpose = 'pemasukan' AND ce.direction = 'masuk' AND ce.status <> 'dibatalkan'
          AND date(ce.occurred_at) BETWEEN ? AND ?
        GROUP BY date(ce.occurred_at)`,
    )
    .all(r.dari, r.sampai) as Array<{ tanggal: string; total: number }>;
  const masukPerHari = new Map(pemasukan.map((x) => [x.tanggal, x.total]));
  const keluarPerHari = new Map<string, number>();
  for (const x of rows) keluarPerHari.set(x.tanggal, (keluarPerHari.get(x.tanggal) ?? 0) + x.jumlah_minor);

  const kunciBucket = (d: IsoDate): { awal: IsoDate; akhir: IsoDate; label: string } => {
    if (granularitas === 'harian') return { awal: d, akhir: d, label: d.slice(8) + '/' + d.slice(5, 7) };
    if (granularitas === 'mingguan') {
      const a = startOfWeek(d);
      return { awal: a, akhir: addDays(a, 6), label: a.slice(8) + '/' + a.slice(5, 7) };
    }
    const a = startOfMonth(d);
    return { awal: a, akhir: endOfMonth(a), label: namaBulan(a.slice(0, 7)).split(' ')[0]!.slice(0, 3) };
  };

  const bucket = new Map<string, TitikTren>();
  for (const d of eachDay(r.dari, r.sampai)) {
    const k = kunciBucket(d);
    const t = bucket.get(k.awal) ?? { ...k, pengeluaran_minor: 0, pemasukan_minor: 0 };
    t.pengeluaran_minor += keluarPerHari.get(d) ?? 0;
    t.pemasukan_minor += masukPerHari.get(d) ?? 0;
    bucket.set(k.awal, t);
  }
  return { granularitas, titik: [...bucket.values()].sort((a, b) => a.awal.localeCompare(b.awal)) };
}

/* ------------------------------------------------------------------ berulang vs sesuka hati */

export function recurringSplit(rows: SpendRow[]) {
  let berulang = 0;
  let sesuka = 0;
  for (const r of rows) {
    const rutin = r.service_id !== null || r.kind === 'bayar_langganan' || r.kind === 'beli_kredit_layanan';
    if (rutin) berulang += r.jumlah_minor;
    else sesuka += r.jumlah_minor;
  }
  const total = berulang + sesuka;
  return {
    berulang_minor: berulang,
    sesuka_minor: sesuka,
    persen_berulang: total > 0 ? Math.round((berulang / total) * 100) : 0,
  };
}

/* ------------------------------------------------------------------ pengeluaran tidak biasa */

export type TidakBiasa = {
  cash_event_id: number;
  tanggal: string;
  merchant: string;
  kategori: string;
  jumlah_minor: number;
  biasanya_minor: number;
  sampel: number;
  alasan: string;
};

/**
 * Pengeluaran yang jauh di atas kebiasaanmu di kategori yang sama. Murni statistik sederhana
 * dan dapat dijelaskan: lebih dari rata-rata + 2 simpangan baku, dan minimal 1,5x rata-rata,
 * dengan sedikitnya 5 transaksi pembanding dan nilai minimal Rp50.000.
 */
export function unusualExpenses(
  r: Rentang,
  rows: SpendRow[],
  peta: Map<number, CategoryRow>,
  database: DB,
): TidakBiasa[] {
  const dasar = spendRows(addDays(r.dari, -90), addDays(r.dari, -1), {}, database).filter((x) => x.jumlah_minor > 0);
  const perKategori = new Map<number | null, number[]>();
  for (const x of dasar) {
    const list = perKategori.get(x.category_id) ?? [];
    list.push(x.jumlah_minor);
    perKategori.set(x.category_id, list);
  }
  const out: TidakBiasa[] = [];
  for (const x of rows) {
    if (x.jumlah_minor < 50_000) continue;
    const sampel = perKategori.get(x.category_id);
    if (!sampel || sampel.length < 5) continue;
    const rata = sampel.reduce((a, b) => a + b, 0) / sampel.length;
    const varian = sampel.reduce((a, b) => a + (b - rata) ** 2, 0) / sampel.length;
    const sd = Math.sqrt(varian);
    if (x.jumlah_minor > rata + 2 * sd && x.jumlah_minor >= rata * 1.5) {
      const kat = x.category_id !== null ? (peta.get(x.category_id)?.name ?? 'Tanpa kategori') : 'Belum dikategorikan';
      out.push({
        cash_event_id: x.cash_event_id,
        tanggal: x.tanggal,
        merchant: x.merchant_name ?? 'Tanpa nama',
        kategori: kat,
        jumlah_minor: x.jumlah_minor,
        biasanya_minor: Math.round(rata),
        sampel: sampel.length,
        alasan: `${formatIDR(x.jumlah_minor)} di ${kat}, padahal biasanya sekitar ${formatIDR(Math.round(rata))} (dari ${sampel.length} transaksi sebelumnya).`,
      });
    }
  }
  return out.sort((a, b) => b.jumlah_minor - a.jumlah_minor).slice(0, 5);
}

/* ------------------------------------------------------------------ langganan */

export type RingkasanLangganan = {
  total_bulanan_pribadi_minor: number;
  total_bulanan_company_minor: number;
  jumlah_aktif: number;
  tanpa_nominal: number;
  per_jenis: Array<{ jenis: string; bulanan_minor: number; jumlah: number }>;
  akan_ditagih: Array<{ service_id: number; nama: string; tanggal: string | null; nominal_minor: number | null; penanggung: string }>;
  kenaikan_biaya: Array<{ service_id: number; nama: string; dari_minor: number; ke_minor: number; persen: number }>;
  /** HEURISTIK: tidak ada pembayaran terdeteksi lebih dari dua siklus. Bukan bukti layanan tidak dipakai. */
  mungkin_tidak_dibutuhkan: Array<{ service_id: number; nama: string; terakhir_dibayar: string; alasan: string }>;
};

export function subscriptionsOverview(hariIni: IsoDate, database: DB): RingkasanLangganan {
  const aktif = database
    .prepare(
      `SELECT s.*, (
          SELECT c.name FROM merchant_rule mr JOIN category c ON c.id = mr.category_id
           WHERE mr.service_id = s.id LIMIT 1
        ) AS jenis
         FROM service s
        WHERE s.status IN ('aktif','akan_perpanjang','lunas_periode_ini','perlu_verifikasi')
          AND s.billing_cycle IN ('bulanan','tahunan')
        ORDER BY s.name`,
    )
    .all() as Array<Record<string, unknown>>;

  let pribadi = 0;
  let company = 0;
  let tanpaNominal = 0;
  const jenisMap = new Map<string, { bulanan: number; jumlah: number }>();
  const akan: RingkasanLangganan['akan_ditagih'] = [];
  const kenaikan: RingkasanLangganan['kenaikan_biaya'] = [];
  const mungkin: RingkasanLangganan['mungkin_tidak_dibutuhkan'] = [];

  for (const s of aktif) {
    const id = Number(s['id']);
    const nama = String(s['name']);
    const nominal = s['amount_minor'] === null ? null : Number(s['amount_minor']);
    const siklus = String(s['billing_cycle']);
    const bulanan = nominal === null ? null : siklus === 'tahunan' ? Math.round(nominal / 12) : nominal;
    const bearer = String(s['bearer']);
    if (bulanan === null) tanpaNominal += 1;
    else if (bearer === 'company') company += bulanan;
    else {
      pribadi += bulanan;
      const j = String(s['jenis'] ?? 'Lainnya');
      const g = jenisMap.get(j) ?? { bulanan: 0, jumlah: 0 };
      g.bulanan += bulanan;
      g.jumlah += 1;
      jenisMap.set(j, g);
    }
    akan.push({ service_id: id, nama, tanggal: (s['next_due_date'] as string | null) ?? null, nominal_minor: nominal, penanggung: bearer });

    const bayar = database
      .prepare(
        `SELECT amount_minor, occurred_at FROM cash_event
          WHERE service_id = ? AND direction = 'keluar' AND status <> 'dibatalkan' AND currency = 'IDR'
          ORDER BY occurred_at DESC, id DESC LIMIT 2`,
      )
      .all(id) as Array<{ amount_minor: number; occurred_at: string }>;
    if (bayar.length === 2 && bayar[0]!.amount_minor > bayar[1]!.amount_minor) {
      kenaikan.push({
        service_id: id,
        nama,
        dari_minor: bayar[1]!.amount_minor,
        ke_minor: bayar[0]!.amount_minor,
        persen: Math.round(((bayar[0]!.amount_minor - bayar[1]!.amount_minor) / bayar[1]!.amount_minor) * 100),
      });
    }
    if (bayar.length >= 1 && String(s['status']) === 'aktif') {
      const terakhir = bayar[0]!.occurred_at.slice(0, 10);
      const batas = siklus === 'tahunan' ? 400 : 70;
      if (diffDays(terakhir, hariIni) > batas) {
        mungkin.push({
          service_id: id,
          nama,
          terakhir_dibayar: terakhir,
          alasan: `Tidak ada pembayaran tercatat sejak ${terakhir}. Ini hanya petunjuk: periksa apakah layanan masih aktif atau dibayar lewat rekening lain.`,
        });
      }
    }
  }

  return {
    total_bulanan_pribadi_minor: pribadi,
    total_bulanan_company_minor: company,
    jumlah_aktif: aktif.length,
    tanpa_nominal: tanpaNominal,
    per_jenis: [...jenisMap.entries()].map(([jenis, g]) => ({ jenis, bulanan_minor: g.bulanan, jumlah: g.jumlah })).sort((a, b) => b.bulanan_minor - a.bulanan_minor),
    akan_ditagih: akan.filter((a) => a.tanggal).sort((a, b) => (a.tanggal ?? '').localeCompare(b.tanggal ?? '')).slice(0, 8),
    kenaikan_biaya: kenaikan,
    mungkin_tidak_dibutuhkan: mungkin,
  };
}

/* ------------------------------------------------------------------ insight */

export type Insight = {
  kunci: string;
  tingkat: 'info' | 'perhatian' | 'baik';
  teks: string;
  /** Angka mentah yang dipakai menyusun kalimat, agar bisa diperiksa. */
  angka: Record<string, number | string | null>;
  rincian?: { kategori_id?: number | null; merchant_id?: number | null; tanpa_kategori?: boolean };
};

/**
 * Insight dihitung dari data nyata dan hanya muncul bila ambangnya terpenuhi.
 * Tidak ada kalimat yang ditulis tanpa angka di belakangnya.
 */
export function buildInsights(input: {
  rentang: Rentang;
  total: number;
  totalSebelumnya: number;
  kategori: KategoriBaris[];
  merchants: MerchantBaris[];
  budgets: BudgetEval[];
  goals: GoalEval[];
  tidakBiasa: TidakBiasa[];
  tagihanTujuh: { jumlah: number; total_minor: number };
  belumDikategorikan: { jumlah: number; minor: number };
  berulang: { persen_berulang: number; berulang_minor: number };
}): Insight[] {
  const out: Insight[] = [];
  const { kategori } = input;

  const terbesar = kategori.find((k) => !k.belum_dikategorikan) ?? null;
  if (terbesar && input.total > 0 && terbesar.persen >= 10) {
    out.push({
      kunci: 'kategori_terbesar',
      tingkat: 'info',
      teks: `${terbesar.nama} adalah pengeluaran terbesarmu: ${formatIDR(terbesar.jumlah_minor)} (${Math.round(terbesar.persen)}% dari semua pengeluaran).`,
      angka: { kategori: terbesar.nama, jumlah_minor: terbesar.jumlah_minor, persen: terbesar.persen },
      rincian: { kategori_id: terbesar.category_id },
    });
  }

  if (input.totalSebelumnya > 0 && input.total > 0) {
    const p = persenPerubahan(input.total, input.totalSebelumnya)!;
    if (Math.abs(p) >= 10) {
      out.push({
        kunci: 'total_berubah',
        tingkat: p > 0 ? 'perhatian' : 'baik',
        teks: `Total pengeluaranmu ${p > 0 ? 'naik' : 'turun'} ${Math.abs(p)}% dibanding ${input.rentang.sebelumnya.label} (${formatIDR(input.totalSebelumnya)} menjadi ${formatIDR(input.total)}).`,
        angka: { persen: p, sekarang_minor: input.total, sebelumnya_minor: input.totalSebelumnya },
      });
    }
  }

  for (const k of kategori) {
    if (k.belum_dikategorikan || k.perubahan_persen === null) continue;
    const selisih = k.jumlah_minor - k.sebelumnya_minor;
    if (Math.abs(k.perubahan_persen) >= 15 && Math.abs(selisih) >= 50_000) {
      out.push({
        kunci: `kategori_berubah_${k.category_id}`,
        tingkat: k.perubahan_persen > 0 ? 'perhatian' : 'baik',
        teks: `Pengeluaran ${k.nama} ${k.perubahan_persen > 0 ? 'naik' : 'turun'} ${Math.abs(k.perubahan_persen)}% dibanding ${input.rentang.sebelumnya.label} (${formatIDR(k.sebelumnya_minor)} menjadi ${formatIDR(k.jumlah_minor)}).`,
        angka: { kategori: k.nama, persen: k.perubahan_persen, sekarang_minor: k.jumlah_minor, sebelumnya_minor: k.sebelumnya_minor },
        rincian: { kategori_id: k.category_id },
      });
      if (out.filter((i) => i.kunci.startsWith('kategori_berubah')).length >= 2) break;
    }
  }

  const sering = [...input.merchants].sort((a, b) => b.jumlah_transaksi - a.jumlah_transaksi || b.total_minor - a.total_minor)[0];
  if (sering && sering.jumlah_transaksi >= 3) {
    out.push({
      kunci: 'merchant_tersering',
      tingkat: 'info',
      teks: `Kamu paling sering belanja di ${sering.nama}: ${sering.jumlah_transaksi} kali, total ${formatIDR(sering.total_minor)}.`,
      angka: { merchant: sering.nama, kali: sering.jumlah_transaksi, total_minor: sering.total_minor },
      rincian: { merchant_id: sering.merchant_id },
    });
  }

  for (const b of input.budgets) {
    if (b.status === 'lewat') {
      out.push({
        kunci: `anggaran_lewat_${b.id}`,
        tingkat: 'perhatian',
        teks: `Anggaran ${b.nama} sudah terlewati ${formatIDR(-b.sisa_minor)} (terpakai ${formatIDR(b.terpakai_minor)} dari ${formatIDR(b.dialokasikan_minor)}).`,
        angka: { anggaran: b.nama, terpakai_minor: b.terpakai_minor, batas_minor: b.dialokasikan_minor },
        rincian: { kategori_id: b.kategori_id },
      });
    } else if (b.status === 'berisiko' && b.perkiraan_akhir_minor !== null) {
      out.push({
        kunci: `anggaran_berisiko_${b.id}`,
        tingkat: 'perhatian',
        teks: `Perkiraan: anggaran ${b.nama} bisa terlewati. Dengan laju sekarang, pengeluaran akhir periode sekitar ${formatIDR(b.perkiraan_akhir_minor)} dari batas ${formatIDR(b.dialokasikan_minor)}. Ini estimasi, bukan angka pasti.`,
        angka: { anggaran: b.nama, perkiraan_minor: b.perkiraan_akhir_minor, batas_minor: b.dialokasikan_minor },
        rincian: { kategori_id: b.kategori_id },
      });
    }
  }

  for (const g of input.goals) {
    if (g.risiko === 'berisiko' || g.risiko === 'terlambat') {
      out.push({
        kunci: `tujuan_${g.risiko}_${g.id}`,
        tingkat: 'perhatian',
        teks: `Tujuan "${g.nama}": ${g.penjelasan}`,
        angka: { tujuan: g.nama, sisa_minor: g.sisa_minor, persen: g.persen },
      });
    } else if (g.risiko === 'tercapai' && g.status === 'tercapai') {
      out.push({ kunci: `tujuan_tercapai_${g.id}`, tingkat: 'baik', teks: `Tujuan "${g.nama}" sudah tercapai.`, angka: { tujuan: g.nama } });
    }
  }

  if (input.tagihanTujuh.jumlah > 0) {
    out.push({
      kunci: 'tagihan_dekat',
      tingkat: 'info',
      teks: `${input.tagihanTujuh.jumlah} tagihan jatuh tempo dalam 7 hari ke depan${input.tagihanTujuh.total_minor > 0 ? `, total ${formatIDR(input.tagihanTujuh.total_minor)}` : ''}.`,
      angka: { jumlah: input.tagihanTujuh.jumlah, total_minor: input.tagihanTujuh.total_minor },
    });
  }

  if (input.tidakBiasa.length) {
    const t = input.tidakBiasa[0]!;
    out.push({
      kunci: 'tidak_biasa',
      tingkat: 'perhatian',
      teks: `Ada pengeluaran yang tidak biasa: ${t.merchant} ${formatIDR(t.jumlah_minor)} (${t.kategori}), biasanya sekitar ${formatIDR(t.biasanya_minor)}.`,
      angka: { jumlah_minor: t.jumlah_minor, biasanya_minor: t.biasanya_minor },
    });
  }

  if (input.belumDikategorikan.jumlah > 0) {
    out.push({
      kunci: 'belum_dikategorikan',
      tingkat: 'perhatian',
      teks: `${input.belumDikategorikan.jumlah} transaksi (${formatIDR(input.belumDikategorikan.minor)}) belum dikategorikan. Rapikan supaya laporan akurat.`,
      angka: { jumlah: input.belumDikategorikan.jumlah, minor: input.belumDikategorikan.minor },
      rincian: { tanpa_kategori: true },
    });
  }

  if (input.berulang.persen_berulang >= 30 && input.berulang.berulang_minor > 0) {
    out.push({
      kunci: 'berulang_besar',
      tingkat: 'info',
      teks: `${input.berulang.persen_berulang}% pengeluaranmu adalah langganan atau tagihan berulang (${formatIDR(input.berulang.berulang_minor)}).`,
      angka: { persen: input.berulang.persen_berulang, minor: input.berulang.berulang_minor },
    });
  }

  const urut = { perhatian: 0, info: 1, baik: 2 } as const;
  return out.sort((a, b) => urut[a.tingkat] - urut[b.tingkat]).slice(0, 8);
}

/* ------------------------------------------------------------------ gabungan */

export function analitik(spec: RentangSpec = {}, database: DB = db(), hariIni: IsoDate = today()) {
  const r = resolveRange(spec, hariIni);
  const peta = categoryMap(database);
  const rows = spendRows(r.dari, r.sampai, {}, database);
  const prevRows = spendRows(r.sebelumnya.dari, r.sebelumnya.sampai, {}, database);
  const total = sumSpend(rows);
  const totalSebelumnya = sumSpend(prevRows);

  const kategori = spendingByCategory(rows, prevRows, peta);
  const merchants = merchantStats(rows, prevRows);
  const akhir = minDate(r.sampai, hariIni);

  const kas = cashFlow(r.dari, r.sampai, database);
  const kasSebelum = cashFlow(r.sebelumnya.dari, r.sebelumnya.sampai, database);
  const pemasukan = incomeTotal(r.dari, r.sampai, database);
  const pemasukanSebelum = incomeTotal(r.sebelumnya.dari, r.sebelumnya.sampai, database);

  const tabungan = database
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind='setoran_tabungan'   AND direction='keluar' THEN amount_minor ELSE 0 END),0) AS setoran,
         COALESCE(SUM(CASE WHEN kind='penarikan_tabungan' THEN amount_minor ELSE 0 END),0) AS penarikan
         FROM cash_event WHERE status <> 'dibatalkan' AND date(occurred_at) BETWEEN ? AND ?`,
    )
    .get(r.dari, r.sampai) as { setoran: number; penarikan: number };

  const saldo = balanceSummary(undefined, database);
  const budgets = listBudgets({ asOf: akhir }, database);
  const goals = listGoals({ asOf: akhir }, database);
  const tagihan = tagihanMendekat({ hari: 7, asOf: hariIni }, database);
  const belum = rows.filter((x) => x.category_id === null);
  const berulang = recurringSplit(rows);
  const tidakBiasa = unusualExpenses(r, rows, peta, database);
  const perluVerifikasi = (
    database
      .prepare(`SELECT COUNT(*) AS n FROM cash_event WHERE status = 'perlu_verifikasi' AND date(occurred_at) BETWEEN ? AND ?`)
      .get(r.dari, r.sampai) as { n: number }
  ).n;
  const tanpaMerchant = new Set(rows.filter((x) => x.merchant_id === null && !x.merchant_name).map((x) => x.cash_event_id)).size;

  const tagihanTujuh = {
    jumlah: tagihan.daftar.filter((d) => d.aktif_di_skenario && d.memotong_saldo_saya && d.tanggal <= addDays(hariIni, 7)).length,
    total_minor: tagihan.dana_perlu_disiapkan_minor,
  };

  const tren = trendSeries(r, rows, database);
  const insight = buildInsights({
    rentang: r,
    total,
    totalSebelumnya,
    kategori,
    merchants,
    budgets,
    goals,
    tidakBiasa,
    tagihanTujuh,
    belumDikategorikan: { jumlah: new Set(belum.map((x) => x.cash_event_id)).size, minor: sumSpend(belum) },
    berulang,
  });

  return {
    rentang: r,
    ringkasan: {
      pemasukan_minor: pemasukan,
      pemasukan_sebelumnya_minor: pemasukanSebelum,
      arus_kas_masuk_minor: kas.masuk_minor,
      arus_kas_keluar_minor: kas.keluar_minor,
      arus_kas_neto_minor: kas.masuk_minor - kas.keluar_minor,
      arus_kas_keluar_sebelumnya_minor: kasSebelum.keluar_minor,
      pengeluaran_pribadi_neto_minor: total,
      pengeluaran_pribadi_sebelumnya_minor: totalSebelumnya,
      perubahan_persen: persenPerubahan(total, totalSebelumnya),
      saldo_terverifikasi_minor: saldo.akun_terverifikasi > 0 ? saldo.total_terverifikasi_minor : null,
      saldo_lengkap: saldo.lengkap,
      tabungan_neto_minor: tabungan.setoran - tabungan.penarikan,
      tujuan: {
        jumlah_aktif: goals.filter((g) => g.status === 'aktif').length,
        terkumpul_minor: goals.filter((g) => g.status !== 'dibatalkan').reduce((s, g) => s + g.terkumpul_minor, 0),
        target_minor: goals.filter((g) => g.status !== 'dibatalkan').reduce((s, g) => s + g.target_minor, 0),
      },
      anggaran: {
        jumlah: budgets.length,
        aman: budgets.filter((b) => b.status === 'aman' || b.status === 'selesai').length,
        berisiko: budgets.filter((b) => b.status === 'berisiko').length,
        lewat: budgets.filter((b) => b.status === 'lewat').length,
        keseluruhan: budgets.find((b) => b.kategori_id === null) ?? null,
      },
    },
    kualitas_data: {
      belum_dikategorikan_jumlah: new Set(belum.map((x) => x.cash_event_id)).size,
      belum_dikategorikan_minor: sumSpend(belum),
      perlu_verifikasi_jumlah: perluVerifikasi,
      tanpa_merchant_jumlah: tanpaMerchant,
      jumlah_transaksi: new Set(rows.map((x) => x.cash_event_id)).size,
    },
    kategori,
    merchant: {
      paling_sering: [...merchants].sort((a, b) => b.jumlah_transaksi - a.jumlah_transaksi || b.total_minor - a.total_minor).slice(0, 8),
      paling_besar_total: [...merchants].sort((a, b) => b.total_minor - a.total_minor).slice(0, 8),
      kebiasaan_berubah: merchants
        .filter((m) => m.jumlah_transaksi >= 3 && m.perubahan_transaksi >= 2 && m.jumlah_transaksi >= m.sebelumnya_transaksi * 1.5)
        .sort((a, b) => b.perubahan_transaksi - a.perubahan_transaksi)
        .slice(0, 5),
    },
    makanan: foodAnalysis(r, hariIni, database),
    tren,
    berulang_vs_sesuka: berulang,
    tidak_biasa: tidakBiasa,
    langganan: subscriptionsOverview(hariIni, database),
    insight,
  };
}

/* ------------------------------------------------------------------ drill-down */

export type SpekRincian = {
  dari: IsoDate;
  sampai: IsoDate;
  kategori_id?: number | null;
  tanpa_kategori?: boolean;
  merchant_id?: number | null;
  makanan?: boolean;
  jenis?: 'berulang' | 'sesuka';
  proyek?: string;
  batas?: number;
};

export type BarisRincian = {
  alokasi_id: number;
  cash_event_id: number;
  tanggal: IsoDate;
  waktu: string;
  merchant: string;
  kategori: string;
  jumlah_minor: number;
  kind: string;
  project: string | null;
  status: string;
  rekening: string | null;
  refund: boolean;
};

/** Transaksi di balik sebuah angka. Memakai definisi pengeluaran yang SAMA dengan analitik. */
export function rincian(spek: SpekRincian, database: DB = db()) {
  const peta = categoryMap(database);
  let rows = spendRows(spek.dari, spek.sampai, {}, database);

  if (spek.tanpa_kategori) rows = rows.filter((r) => r.category_id === null);
  else if (spek.kategori_id !== undefined && spek.kategori_id !== null) {
    const ids = new Set(categorySubtreeIds(spek.kategori_id, database));
    rows = rows.filter((r) => r.category_id !== null && ids.has(r.category_id));
  }
  if (spek.makanan) {
    const makan = categoryBySlug('makan', database);
    const ids = new Set(makan ? categorySubtreeIds(makan.id, database) : []);
    rows = rows.filter((r) => r.category_id !== null && ids.has(r.category_id));
  }
  if (spek.merchant_id !== undefined && spek.merchant_id !== null) rows = rows.filter((r) => r.merchant_id === spek.merchant_id);
  if (spek.jenis) {
    rows = rows.filter((r) => {
      const rutin = r.service_id !== null || r.kind === 'bayar_langganan' || r.kind === 'beli_kredit_layanan';
      return spek.jenis === 'berulang' ? rutin : !rutin;
    });
  }
  if (spek.proyek) rows = rows.filter((r) => (r.project ?? '').toLowerCase() === spek.proyek!.toLowerCase());

  const ids = [...new Set(rows.map((r) => r.cash_event_id))];
  const info = new Map<number, { status: string; rekening: string | null }>();
  if (ids.length) {
    const rs = database
      .prepare(
        `SELECT ce.id, ce.status, a.name AS rekening FROM cash_event ce LEFT JOIN account a ON a.id = ce.account_id
          WHERE ce.id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as Array<{ id: number; status: string; rekening: string | null }>;
    for (const x of rs) info.set(x.id, { status: x.status, rekening: x.rekening });
  }

  const batas = Math.min(spek.batas ?? 300, 500);
  const baris: BarisRincian[] = rows
    .sort((a, b) => b.waktu.localeCompare(a.waktu))
    .slice(0, batas)
    .map((r) => ({
      alokasi_id: r.allocation_id,
      cash_event_id: r.cash_event_id,
      tanggal: r.tanggal,
      waktu: r.waktu,
      merchant: r.merchant_name ?? 'Tanpa nama',
      kategori: r.category_id !== null ? (peta.get(r.category_id)?.name ?? 'Tanpa kategori') : 'Belum dikategorikan',
      jumlah_minor: r.jumlah_minor,
      kind: r.kind,
      project: r.project,
      status: info.get(r.cash_event_id)?.status ?? 'terkonfirmasi',
      rekening: info.get(r.cash_event_id)?.rekening ?? null,
      refund: r.purpose === 'refund',
    }));

  return {
    total_minor: sumSpend(rows),
    jumlah_potongan: rows.length,
    jumlah_transaksi: ids.length,
    terpotong: rows.length > batas,
    baris,
  };
}
