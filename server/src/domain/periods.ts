import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { addDays, minDate, today, type IsoDate } from './time.js';
import { assumptionAt, numberAssumption } from './assumptions.js';
import { project, type DayRow, type Projection } from './projection.js';
import { resolveScenario } from './scenarios.js';
import type { DayRisk } from './types.js';

export type PeriodBlock = {
  index: number;
  mulai: IsoDate;
  akhir: IsoDate;
  is_berjalan: boolean;
  is_lampau: boolean;
  saldo_awal_minor: number;
  pemasukan_rencana_minor: number;
  pemasukan_aktual_minor: number;
  makan_rencana_minor: number;
  makan_aktual_minor: number;
  belanja_minor: number;
  tagihan_minor: number;
  biaya_company_minor: number;
  keluar_total_minor: number;
  saldo_akhir_minor: number;
  saldo_akhir_realisasi_minor: number | null;
  /** Rencana dikurangi realisasi untuk pos makan. Positif = masih ada sisa anggaran. */
  selisih_makan_minor: number;
  sisa_dana_minor: number;
  status: DayRisk;
  hari_rendah: IsoDate[];
  hari_defisit: IsoDate[];
  catatan: string[];
};

export type PeriodReport = {
  tersedia: boolean;
  alasan?: string;
  panjang_hari: number;
  mulai_dari: IsoDate | null;
  skenario: { slug: string; nama: string };
  blok: PeriodBlock[];
  berjalan: PeriodBlock | null;
};

/** Tanggal mulai blok yang memuat `date`, dihitung dari titik awal periode. */
export function periodStartFor(date: IsoDate, anchor: IsoDate, length: number): IsoDate {
  const diff = Math.floor(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000,
  );
  const blocks = Math.floor(diff / length);
  return addDays(anchor, blocks * length);
}

function aggregate(rows: DayRow[], index: number, hariIni: IsoDate): PeriodBlock {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const sum = (pick: (r: DayRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const makanRencana = sum((r) => r.makan_rencana_minor);
  const makanAktual = sum((r) => r.makan_aktual_minor);
  const anggaranMakan = sum((r) => r.anggaran_makan_minor);

  const hariDefisit = rows.filter((r) => r.status === 'defisit').map((r) => r.tanggal);
  const hariRendah = rows.filter((r) => r.status === 'rendah').map((r) => r.tanggal);
  const status: DayRisk = hariDefisit.length ? 'defisit' : hariRendah.length ? 'rendah' : 'aman';

  const catatan = Array.from(new Set(rows.flatMap((r) => r.catatan)));

  return {
    index,
    mulai: first.tanggal,
    akhir: last.tanggal,
    is_berjalan: first.tanggal <= hariIni && last.tanggal >= hariIni,
    is_lampau: last.tanggal < hariIni,
    saldo_awal_minor: first.saldo_awal_minor,
    pemasukan_rencana_minor: sum((r) => r.masuk_rencana_minor),
    pemasukan_aktual_minor: sum((r) => r.masuk_aktual_minor),
    makan_rencana_minor: makanRencana,
    makan_aktual_minor: makanAktual,
    belanja_minor: sum((r) => r.belanja_minor),
    tagihan_minor: sum((r) => r.tagihan_minor),
    biaya_company_minor: sum((r) => r.biaya_company_minor),
    keluar_total_minor: sum((r) => r.keluar_total_minor),
    saldo_akhir_minor: last.saldo_akhir_minor,
    saldo_akhir_realisasi_minor: last.saldo_akhir_realisasi_minor,
    selisih_makan_minor: anggaranMakan - makanAktual,
    sisa_dana_minor: last.saldo_akhir_minor,
    status,
    hari_rendah: hariRendah,
    hari_defisit: hariDefisit,
    catatan,
  };
}

/**
 * Rekap per blok lima hari (panjangnya dapat diubah di PENGATURAN).
 * Blok terbentuk otomatis dari tanggal awal periode dan intervalnya.
 */
export function periodReport(
  opts: { dari?: IsoDate; sampai?: IsoDate; skenario?: string; asOf?: IsoDate } = {},
  database: DB = db(),
): PeriodReport {
  const hariIni = opts.asOf ?? today();
  const panjang = numberAssumption('periode_panjang_hari', 5, hariIni, database).value;
  const anchorRaw =
    assumptionAt<string>('periode_mulai', hariIni, database)?.value ??
    assumptionAt<string>('topup_mulai', hariIni, database)?.value ??
    null;

  if (!anchorRaw) {
    return {
      tersedia: false,
      alasan:
        'Tanggal awal periode belum dikonfirmasi. Isi "periode_mulai" di Pengaturan agar blok ' +
        `${panjang} hari dapat dibentuk otomatis.`,
      panjang_hari: panjang,
      mulai_dari: null,
      skenario: { slug: resolveScenario(opts.skenario, database).slug, nama: resolveScenario(opts.skenario, database).name },
      blok: [],
      berjalan: null,
    };
  }

  const anchor = String(anchorRaw);
  const dari = opts.dari ?? periodStartFor(addDays(hariIni, -panjang * 2), anchor, panjang);
  const sampaiMinta = opts.sampai ?? addDays(hariIni, panjang * 6);
  // Rapikan agar blok terakhir utuh.
  const mulaiBlokTerakhir = periodStartFor(sampaiMinta, anchor, panjang);
  const sampai = addDays(mulaiBlokTerakhir, panjang - 1);

  const proj: Projection = project(
    { dari: periodStartFor(dari, anchor, panjang), sampai, skenario: opts.skenario, asOf: hariIni },
    database,
  );

  const blok: PeriodBlock[] = [];
  let index = 0;
  let cursor = proj.dari;
  while (cursor <= proj.sampai) {
    const end = minDate(addDays(cursor, panjang - 1), proj.sampai);
    const rows = proj.hari.filter((r) => r.tanggal >= cursor && r.tanggal <= end);
    if (rows.length) blok.push(aggregate(rows, index, hariIni));
    index += 1;
    cursor = addDays(cursor, panjang);
  }

  return {
    tersedia: true,
    panjang_hari: panjang,
    mulai_dari: anchor,
    skenario: { slug: proj.skenario.slug, nama: proj.skenario.nama },
    blok,
    berjalan: blok.find((b) => b.is_berjalan) ?? null,
  };
}
