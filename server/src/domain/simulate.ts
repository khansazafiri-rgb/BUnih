import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { addDays, endOfMonth, formatTanggal, maxDate, today, type IsoDate } from './time.js';
import { formatIDR } from './money.js';
import { project, type ExtraItem, type Projection, type Risiko } from './projection.js';
import { resolveScenario, SKENARIO_DASAR } from './scenarios.js';

export type JenisPembelian = 'pribadi' | 'hadiah' | 'talangan' | 'company' | 'bersama';

export type SimulasiInput = {
  label?: string;
  /** null = harga belum diketahui. Sistem tidak akan menyebutnya aman. */
  harga_minor: number | null;
  tanggal?: IsoDate;
  account_id?: number | null;
  jenis: JenisPembelian;
  /** Untuk talangan/bersama/company: bagian yang akan kembali ke saya. */
  bagian_kembali_minor?: number | null;
  bisa_ditunda?: boolean;
  skenario?: string;
  horizon_hari?: number;
};

export type SimulasiHasil = {
  pertanyaan: string;
  jawaban: string;
  verdict: 'aman' | 'hati_hati' | 'tidak_aman' | 'belum_pasti';
  tanggal: IsoDate;
  harga_minor: number | null;
  /** Beban bersih bagi saya setelah memperhitungkan bagian yang kembali. */
  beban_pribadi_minor: number | null;
  sebelum: RingkasanSim;
  sesudah: RingkasanSim;
  dampak: {
    saldo_terendah_turun_minor: number;
    saldo_akhir_turun_minor: number;
    melewati_cadangan: boolean;
    kekurangan_dari_cadangan_minor: number;
    membuat_defisit: boolean;
    tanggal_defisit: IsoDate | null;
    tagihan_terdekat: TagihanTerdekat | null;
    tagihan_masih_aman: boolean | null;
    piutang_bertambah_minor: number;
    saldo_terendah_sebelum_topup_minor: number | null;
    tanggal_topup_berikutnya: IsoDate | null;
  };
  alasan: string[];
  ketidakpastian: Risiko[];
  saran: string[];
};

type RingkasanSim = {
  saldo_akhir_minor: number;
  saldo_terendah_minor: number;
  saldo_terendah_tanggal: IsoDate;
  tanggal_defisit: IsoDate | null;
  cadangan_minimal_minor: number;
};

type TagihanTerdekat = {
  label: string;
  tanggal: IsoDate;
  nominal_minor: number | null;
  penanggung: string;
};

const RINGKAS = (p: Projection): RingkasanSim => ({
  saldo_akhir_minor: p.ringkasan.saldo_akhir_minor,
  saldo_terendah_minor: p.ringkasan.saldo_terendah_minor,
  saldo_terendah_tanggal: p.ringkasan.saldo_terendah_tanggal,
  tanggal_defisit: p.ringkasan.tanggal_defisit,
  cadangan_minimal_minor: p.ringkasan.cadangan_minimal_minor,
});

const JENIS_LABEL: Record<JenisPembelian, string> = {
  pribadi: 'pengeluaran pribadi',
  hadiah: 'hadiah (tetap biaya pribadi saya)',
  talangan: 'talangan (akan dibayar kembali)',
  company: 'biaya company',
  bersama: 'pembayaran bersama',
};

const TIPE_KETIDAKPASTIAN = new Set<Risiko['tipe']>([
  'harga_belum_diketahui',
  'nominal_belum_terverifikasi',
  'saldo_belum_terverifikasi',
  'topup_belum_dikonfirmasi',
]);

function tagihanTerdekat(
  dari: IsoDate,
  sampai: IsoDate,
  database: DB,
  tagAktif: Set<string> = new Set(),
): TagihanTerdekat | null {
  const daftarTag = [...tagAktif];
  const klausaTag = daftarTag.length
    ? `(o.scenario_tag IS NULL OR o.scenario_tag IN (${daftarTag.map(() => '?').join(',')}))`
    : 'o.scenario_tag IS NULL';
  const row = database
    .prepare(
      `SELECT o.label, o.due_date, o.amount_minor, o.bearer, o.paid_by
         FROM obligation o
        WHERE o.status = 'rencana'
          AND o.kind IN ('langganan','tagihan')
          AND o.affects_my_cash = 1
          AND ${klausaTag}
          AND o.due_date >= ?
          AND o.due_date <= ?
        ORDER BY o.due_date, o.amount_minor DESC
        LIMIT 1`,
    )
    .get(...daftarTag, dari, sampai) as
    | { label: string; due_date: string; amount_minor: number | null; bearer: string; paid_by: string }
    | undefined;
  if (!row) return null;
  return {
    label: row.label,
    tanggal: row.due_date,
    nominal_minor: row.amount_minor,
    penanggung: row.paid_by === 'company' ? 'company' : row.bearer === 'company' ? 'company (pembayar belum jelas)' : 'pribadi',
  };
}

function topupBerikutnya(dari: IsoDate, database: DB): IsoDate | null {
  const row = database
    .prepare(
      `SELECT plan_date FROM topup_plan
        WHERE plan_date >= ? AND status IN ('rencana')
        ORDER BY plan_date LIMIT 1`,
    )
    .get(dari) as { plan_date: string } | undefined;
  return row?.plan_date ?? null;
}

/**
 * "Bolehkah aku beli ini?" — menghitung dampak konkret sebuah pembelian
 * terhadap saldo terendah, tagihan terdekat, cadangan minimal, dan piutang.
 *
 * Tidak pernah menjawab "aman" bila ada harga atau pemasukan penting yang belum pasti.
 */
export function simulasiPembelian(input: SimulasiInput, database: DB = db()): SimulasiHasil {
  const hariIni = today();
  const tanggal = input.tanggal ?? hariIni;
  const horizon = input.horizon_hari ?? 45;
  const sampai = maxDate(endOfMonth(tanggal), addDays(hariIni, horizon));
  const dari = hariIni;
  const skenario = input.skenario ?? SKENARIO_DASAR;
  const label = input.label ?? 'Pembelian baru';

  // Beban bersih bagi saya: hadiah ditanggung penuh, talangan/company kembali sebagian.
  let bebanPribadi: number | null = input.harga_minor;
  const kembali = input.bagian_kembali_minor ?? null;
  if (input.harga_minor !== null) {
    if (input.jenis === 'talangan' || input.jenis === 'company') {
      bebanPribadi = kembali === null ? 0 : Math.max(0, input.harga_minor - kembali);
      if (kembali === null) bebanPribadi = 0;
    } else if (input.jenis === 'bersama') {
      bebanPribadi = kembali === null ? input.harga_minor : Math.max(0, input.harga_minor - kembali);
    }
  }
  const piutangBertambah =
    input.harga_minor === null
      ? 0
      : input.jenis === 'talangan' || input.jenis === 'company'
        ? (kembali ?? input.harga_minor)
        : input.jenis === 'bersama'
          ? (kembali ?? 0)
          : 0;

  const extras: ExtraItem[] = [
    {
      tanggal,
      nominal_minor: input.harga_minor,
      label: `${label} (${JENIS_LABEL[input.jenis]})`,
      direction: 'keluar',
      bucket: 'belanja',
      certainty: 'perkiraan',
    },
  ];
  // Uang yang akan kembali dicatat sebagai perkiraan masuk, bukan pengurang pengeluaran.
  if (piutangBertambah > 0) {
    const lagRow = database
      .prepare(
        `SELECT value_json FROM assumption WHERE key = 'reimburse_lag_hari'
          AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
          ORDER BY effective_from DESC LIMIT 1`,
      )
      .get(tanggal, tanggal) as { value_json: string } | undefined;
    const lag = lagRow ? Number(JSON.parse(lagRow.value_json)) : 14;
    extras.push({
      tanggal: addDays(tanggal, lag),
      nominal_minor: piutangBertambah,
      label: `Perkiraan uang kembali dari ${input.jenis === 'company' ? 'company' : 'teman'}`,
      direction: 'masuk',
      bucket: 'reimburse_masuk',
      certainty: 'perkiraan',
    });
  }

  const sebelumProj = project({ dari, sampai, skenario }, database);
  const sesudahProj = project({ dari, sampai, skenario, tambahan: extras }, database);

  const sebelum = RINGKAS(sebelumProj);
  const sesudah = RINGKAS(sesudahProj);

  const tagihan = tagihanTerdekat(tanggal, sampai, database, resolveScenario(skenario, database).enabledTags);
  const topup = topupBerikutnya(tanggal, database);

  let terendahSebelumTopup: number | null = null;
  if (topup) {
    const rows = sesudahProj.hari.filter((r) => r.tanggal >= tanggal && r.tanggal < topup);
    if (rows.length) terendahSebelumTopup = Math.min(...rows.map((r) => r.saldo_akhir_minor));
  }

  const ketidakpastian = sesudahProj.risiko.filter((r) => TIPE_KETIDAKPASTIAN.has(r.tipe));
  const hargaTidakPasti = input.harga_minor === null;

  const melewatiCadangan = sesudah.saldo_terendah_minor < sesudah.cadangan_minimal_minor;
  const kekurangan = Math.max(0, sesudah.cadangan_minimal_minor - sesudah.saldo_terendah_minor);
  const membuatDefisit = sesudah.tanggal_defisit !== null && sebelum.tanggal_defisit === null;

  let tagihanMasihAman: boolean | null = null;
  if (tagihan) {
    if (tagihan.nominal_minor === null) tagihanMasihAman = null;
    else {
      const hariTagihan = sesudahProj.hari.find((r) => r.tanggal === tagihan.tanggal);
      tagihanMasihAman = hariTagihan ? hariTagihan.saldo_akhir_minor >= 0 : null;
    }
  }

  const alasan: string[] = [];
  const saran: string[] = [];

  alasan.push(
    `Tanpa pembelian ini, saldo terendah sampai ${formatTanggal(sampai)} adalah ` +
      `${formatIDR(sebelum.saldo_terendah_minor)} pada ${formatTanggal(sebelum.saldo_terendah_tanggal)}.`,
  );
  if (!hargaTidakPasti) {
    alasan.push(
      `Dengan pembelian ini, saldo terendah menjadi ${formatIDR(sesudah.saldo_terendah_minor)} ` +
        `pada ${formatTanggal(sesudah.saldo_terendah_tanggal)}.`,
    );
  }
  if (tagihan) {
    alasan.push(
      `Tagihan terdekat: ${tagihan.label} ${formatIDR(tagihan.nominal_minor)} pada ` +
        `${formatTanggal(tagihan.tanggal)} (penanggung ${tagihan.penanggung}).`,
    );
  }
  if (piutangBertambah > 0) {
    alasan.push(
      `Piutang bertambah ${formatIDR(piutangBertambah)}; uang itu baru kembali bila benar-benar dibayar.`,
    );
  }

  let verdict: SimulasiHasil['verdict'];
  if (hargaTidakPasti) {
    verdict = 'belum_pasti';
    saran.push('Cari harga pastinya dulu — tanpa harga, dampaknya tidak dapat dihitung.');
  } else if (sesudah.tanggal_defisit !== null) {
    verdict = 'tidak_aman';
  } else if (melewatiCadangan) {
    verdict = 'hati_hati';
  } else if (ketidakpastian.length > 0) {
    verdict = 'belum_pasti';
  } else {
    verdict = 'aman';
  }

  if (verdict !== 'aman' && input.bisa_ditunda) {
    saran.push(
      topup
        ? `Pertimbangkan menunda sampai setelah top-up ${formatTanggal(topup)}.`
        : 'Pertimbangkan menundanya sampai ada pemasukan yang sudah pasti.',
    );
  }
  if (melewatiCadangan && !hargaTidakPasti) {
    saran.push(
      `Perlu tambahan ${formatIDR(kekurangan)} agar saldo tetap di atas cadangan minimal ` +
        `${formatIDR(sesudah.cadangan_minimal_minor)}.`,
    );
  }
  if (ketidakpastian.length) {
    saran.push('Ada angka yang belum pasti, jadi hasil ini belum bisa disebut aman.');
  }

  let jawaban: string;
  if (hargaTidakPasti) {
    jawaban =
      `Harga ${label} belum diketahui, jadi saya belum bisa menghitung dampaknya. ` +
      'Ini dicatat sebagai risiko anggaran yang belum terhitung, bukan sebagai gratis.';
  } else if (sesudah.tanggal_defisit) {
    jawaban =
      `Kalau dibeli ${formatTanggal(tanggal)}, saldo akan defisit pada ` +
      `${formatTanggal(sesudah.tanggal_defisit)}. Saldo terendah ${formatIDR(sesudah.saldo_terendah_minor)}.`;
  } else if (melewatiCadangan) {
    jawaban =
      `Kalau dibeli ${formatTanggal(tanggal)}, saldo terendah ` +
      `${topup ? `sebelum top-up ${formatTanggal(topup)}` : `sampai ${formatTanggal(sampai)}`} ` +
      `menjadi ${formatIDR(terendahSebelumTopup ?? sesudah.saldo_terendah_minor)}, ` +
      `di bawah batas ${formatIDR(sesudah.cadangan_minimal_minor)} sebesar ${formatIDR(kekurangan)}.`;
  } else if (ketidakpastian.length) {
    jawaban =
      `Secara angka masih cukup: saldo terendah ${formatIDR(sesudah.saldo_terendah_minor)} pada ` +
      `${formatTanggal(sesudah.saldo_terendah_tanggal)}. Tetapi ada ${ketidakpastian.length} angka ` +
      'yang belum pasti, jadi belum bisa disebut aman.';
  } else {
    jawaban =
      `Masih aman: saldo terendah ${formatIDR(sesudah.saldo_terendah_minor)} pada ` +
      `${formatTanggal(sesudah.saldo_terendah_tanggal)}, masih di atas cadangan minimal ` +
      `${formatIDR(sesudah.cadangan_minimal_minor)}.`;
  }

  return {
    pertanyaan: `Bolehkah saya beli ${label} ${formatIDR(input.harga_minor)} pada ${formatTanggal(tanggal)}?`,
    jawaban,
    verdict,
    tanggal,
    harga_minor: input.harga_minor,
    beban_pribadi_minor: bebanPribadi,
    sebelum,
    sesudah,
    dampak: {
      saldo_terendah_turun_minor: sebelum.saldo_terendah_minor - sesudah.saldo_terendah_minor,
      saldo_akhir_turun_minor: sebelum.saldo_akhir_minor - sesudah.saldo_akhir_minor,
      melewati_cadangan: melewatiCadangan,
      kekurangan_dari_cadangan_minor: kekurangan,
      membuat_defisit: membuatDefisit,
      tanggal_defisit: sesudah.tanggal_defisit,
      tagihan_terdekat: tagihan,
      tagihan_masih_aman: tagihanMasihAman,
      piutang_bertambah_minor: piutangBertambah,
      saldo_terendah_sebelum_topup_minor: terendahSebelumTopup,
      tanggal_topup_berikutnya: topup,
    },
    alasan,
    ketidakpastian,
    saran,
  };
}

/** Bandingkan beberapa skenario sekaligus (mis. tanpa vs dengan Claude pribadi). */
export function bandingkanSkenario(
  slugs: string[],
  opts: { dari?: IsoDate; sampai?: IsoDate } = {},
  database: DB = db(),
) {
  const hariIni = today();
  const dari = opts.dari ?? hariIni;
  const sampai = opts.sampai ?? addDays(hariIni, 45);
  return slugs.map((slug) => {
    const p = project({ dari, sampai, skenario: slug }, database);
    return {
      slug: p.skenario.slug,
      nama: p.skenario.nama,
      deskripsi: p.skenario.deskripsi,
      saldo_akhir_minor: p.ringkasan.saldo_akhir_minor,
      saldo_terendah_minor: p.ringkasan.saldo_terendah_minor,
      saldo_terendah_tanggal: p.ringkasan.saldo_terendah_tanggal,
      tanggal_defisit: p.ringkasan.tanggal_defisit,
      cadangan_minimal_minor: p.ringkasan.cadangan_minimal_minor,
      kekurangan_agar_tidak_defisit_minor: p.ringkasan.kekurangan_agar_tidak_defisit_minor,
      kekurangan_agar_cadangan_aman_minor: p.ringkasan.kekurangan_agar_cadangan_aman_minor,
      total_tagihan_minor: p.ringkasan.total_tagihan_minor,
      total_biaya_company_minor: p.ringkasan.total_biaya_company_minor,
      asumsi_dipakai: p.asumsi_dipakai,
      risiko: p.risiko,
    };
  });
}
