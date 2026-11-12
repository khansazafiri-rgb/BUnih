import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { addDays, dateOf, eachDay, maxDate, today, type IsoDate } from './time.js';
import { assumptionAt, numberAssumption } from './assumptions.js';
import { resolveScenario, SKENARIO_DASAR, type ResolvedScenario } from './scenarios.js';
import { balanceSummary } from './balances.js';
import type { Certainty, DayRisk } from './types.js';

export type Bucket =
  | 'pemasukan'
  | 'reimburse_masuk'
  | 'refund_masuk'
  | 'makan'
  | 'rutin_lain'
  | 'belanja'
  | 'tagihan'
  | 'talangan_keluar'
  | 'transfer_keluar'
  | 'transfer_masuk'
  | 'biaya_company'
  | 'koreksi';

export type DayDriver = {
  label: string;
  /** null = nominal belum diketahui; tidak ikut mengubah saldo. */
  amount_minor: number | null;
  direction: 'masuk' | 'keluar' | 'netral';
  bucket: Bucket;
  certainty: Certainty;
  jenis: 'aktual' | 'rencana';
  terlambat?: boolean;
  ref?: { tipe: string; id: number };
};

export type DayRow = {
  tanggal: IsoDate;
  is_masa_lalu: boolean;
  is_hari_ini: boolean;
  saldo_awal_minor: number;
  masuk_aktual_minor: number;
  masuk_rencana_minor: number;
  reimburse_rencana_minor: number;
  makan_aktual_minor: number;
  makan_rencana_minor: number;
  rutin_lain_minor: number;
  belanja_minor: number;
  tagihan_minor: number;
  talangan_keluar_minor: number;
  transfer_keluar_minor: number;
  transfer_masuk_minor: number;
  biaya_company_minor: number;
  keluar_total_minor: number;
  saldo_akhir_minor: number;
  /** null untuk hari di masa depan — realisasi hanya ada sampai hari ini. */
  saldo_akhir_realisasi_minor: number | null;
  saldo_akhir_tanpa_reimburse_minor: number;
  status: DayRisk;
  anggaran_makan_minor: number;
  selisih_makan_minor: number;
  drivers: DayDriver[];
  catatan: string[];
  risiko_belum_terhitung: string[];
};

export type Risiko = {
  tipe:
    | 'harga_belum_diketahui'
    | 'nominal_belum_terverifikasi'
    | 'saldo_belum_terverifikasi'
    | 'topup_belum_dikonfirmasi'
    | 'tagihan_terlambat'
    | 'reimburse_terlambat'
    | 'penanggung_belum_jelas'
    | 'data_makan_kosong';
  pesan: string;
  tanggal?: IsoDate;
  nominal_minor?: number | null;
  ref?: { tipe: string; id: number };
};

export type Projection = {
  dari: IsoDate;
  sampai: IsoDate;
  hari_ini: IsoDate;
  skenario: { slug: string; nama: string; deskripsi: string | null };
  dasar_saldo: {
    minor: number;
    certainty: Certainty;
    sumber: string;
    catatan: string[];
  };
  hari: DayRow[];
  ringkasan: {
    saldo_akhir_minor: number;
    saldo_akhir_realisasi_minor: number | null;
    saldo_terendah_minor: number;
    saldo_terendah_tanggal: IsoDate;
    saldo_terendah_tanpa_reimburse_minor: number;
    saldo_terendah_tanpa_reimburse_tanggal: IsoDate;
    tanggal_defisit: IsoDate | null;
    cadangan_minimal_minor: number;
    kekurangan_agar_tidak_defisit_minor: number;
    kekurangan_agar_cadangan_aman_minor: number;
    total_masuk_aktual_minor: number;
    total_masuk_rencana_minor: number;
    total_keluar_aktual_minor: number;
    total_keluar_rencana_minor: number;
    total_makan_aktual_minor: number;
    total_makan_rencana_minor: number;
    total_tagihan_minor: number;
    total_belanja_minor: number;
    total_biaya_company_minor: number;
    hari_rendah: IsoDate[];
    hari_defisit: IsoDate[];
  };
  risiko: Risiko[];
  asumsi_dipakai: Array<{ key: string; value: unknown; certainty: Certainty; dari_skenario: boolean }>;
  peringatan: string[];
};

export type ExtraItem = {
  tanggal: IsoDate;
  nominal_minor: number | null;
  label: string;
  direction?: 'masuk' | 'keluar';
  bucket?: Bucket;
  certainty?: Certainty;
};

export type ProjectionOptions = {
  dari?: IsoDate;
  sampai?: IsoDate;
  skenario?: string;
  /** Rekening yang diperhitungkan. Bawaan: semua rekening milik saya (transfer internal jadi netral). */
  account_ids?: number[];
  asOf?: IsoDate;
  /** Barang/biaya hipotetis untuk simulasi "Bolehkah aku beli ini?". */
  tambahan?: ExtraItem[];
  /** Jangan masukkan perkiraan reimburse ke saldo proyeksi. */
  tanpa_reimburse?: boolean;
};

const NEUTRAL_PURPOSES = new Set(['transfer_internal', 'tabungan']);

type EventRow = {
  id: number;
  occurred_at: string;
  direction: 'masuk' | 'keluar';
  amount_minor: number;
  kind: string;
  account_id: number | null;
  is_cash: number;
  merchant_raw: string | null;
  service_id: number | null;
  status: string;
  alloc_id: number;
  alloc_amount: number;
  purpose: string;
  category_slug: string | null;
  is_routine: number | null;
};

function readNumber(
  key: string,
  fallback: number,
  at: IsoDate,
  scenario: ResolvedScenario,
  database: DB,
): { value: number; certainty: Certainty; dari_skenario: boolean } {
  const override = scenario.overrides[key];
  if (typeof override === 'number') {
    return { value: override, certainty: 'perkiraan', dari_skenario: true };
  }
  const resolved = numberAssumption(key, fallback, at, database);
  return { value: resolved.value, certainty: resolved.certainty, dari_skenario: false };
}

function bucketFor(row: EventRow): { bucket: Bucket; neutral: boolean } {
  const isLangganan =
    row.kind === 'bayar_langganan' || row.kind === 'beli_kredit_layanan' || row.service_id !== null;
  switch (row.purpose) {
    case 'pemasukan':
      return { bucket: 'pemasukan', neutral: false };
    case 'pelunasan_piutang':
      return { bucket: 'reimburse_masuk', neutral: false };
    case 'refund':
      return { bucket: 'refund_masuk', neutral: false };
    case 'transfer_internal':
      return { bucket: row.direction === 'keluar' ? 'transfer_keluar' : 'transfer_masuk', neutral: true };
    case 'tabungan':
      return { bucket: 'transfer_keluar', neutral: true };
    case 'piutang_teman':
    case 'piutang_company':
      return { bucket: 'talangan_keluar', neutral: false };
    case 'biaya_company_langsung':
      return { bucket: 'biaya_company', neutral: true };
    case 'kredit_layanan':
      return { bucket: 'tagihan', neutral: false };
    case 'penyesuaian':
      return { bucket: 'koreksi', neutral: false };
    case 'biaya_pribadi':
    default:
      if (isLangganan) return { bucket: 'tagihan', neutral: false };
      if (row.category_slug === 'makan') return { bucket: 'makan', neutral: false };
      if (row.is_routine === 1) return { bucket: 'rutin_lain', neutral: false };
      return { bucket: 'belanja', neutral: false };
  }
}

function openingBalance(
  from: IsoDate,
  database: DB,
): { minor: number; certainty: Certainty; sumber: string; catatan: string[] } {
  const asOf = `${addDays(from, -1)}T23:59:59+07:00`;
  const summary = balanceSummary(asOf, database);
  if (summary.akun_terverifikasi > 0) {
    return {
      minor: summary.total_terverifikasi_minor,
      certainty: 'terverifikasi',
      sumber: `Rekonsiliasi ${summary.akun_terverifikasi} rekening per ${asOf.slice(0, 10)}`,
      catatan: summary.catatan,
    };
  }
  const sheet = assumptionAt<number>('saldo_awal_sheet', from, database);
  if (sheet && typeof sheet.value === 'number') {
    return {
      minor: sheet.value,
      certainty: 'asumsi_sheet',
      sumber: 'Asumsi saldo awal dari Sheet (belum dikonfirmasi sebagai saldo bank)',
      catatan: [
        'Belum ada rekonsiliasi rekening, jadi proyeksi ini memakai asumsi saldo awal dari Sheet. ' +
          'Angka ini BUKAN saldo bank.',
      ],
    };
  }
  return {
    minor: 0,
    certainty: 'perkiraan',
    sumber: 'Tidak ada data saldo',
    catatan: ['Belum ada saldo awal maupun rekonsiliasi, jadi proyeksi dimulai dari nol.'],
  };
}

/**
 * Proyeksi arus kas harian.
 *
 * Aturan penting:
 * - Rencana makan tidak ditambahkan di atas realisasi makan pada hari yang sama.
 * - Top-up rencana baru menjadi pemasukan bila statusnya 'diterima'.
 * - Tagihan yang sudah dibayar (ada transaksi kas tertaut) tidak lagi memotong saldo.
 * - Transfer antar rekening saya netral terhadap total uang saya.
 * - Biaya yang dibayar langsung company tidak mengubah saldo saya.
 * - Nominal yang belum diketahui tidak dianggap nol; ia muncul sebagai risiko.
 */
export function project(opts: ProjectionOptions = {}, database: DB = db()): Projection {
  const hariIni = opts.asOf ?? today();
  const dari = opts.dari ?? hariIni;
  const sampai = opts.sampai ?? addDays(dari, 30);
  const scenario = resolveScenario(opts.skenario ?? SKENARIO_DASAR, database);

  const myAccounts = (
    database.prepare(`SELECT id FROM account WHERE is_mine = 1 AND active = 1`).all() as Array<{
      id: number;
    }>
  ).map((r) => r.id);
  const accountIds = opts.account_ids?.length ? opts.account_ids : myAccounts;
  const perspektifTotal = !opts.account_ids?.length || opts.account_ids.length === myAccounts.length;

  const risiko: Risiko[] = [];
  const peringatan: string[] = [];
  /** Risiko berulang (mis. langganan bulanan) hanya dilaporkan sekali, pada kemunculan terawal. */
  const risikoTerlihat = new Set<string>();
  const tambahRisiko = (r: Risiko, kunciUnik?: string): void => {
    if (kunciUnik) {
      if (risikoTerlihat.has(kunciUnik)) return;
      risikoTerlihat.add(kunciUnik);
    }
    risiko.push(r);
  };
  const asumsiDipakai: Projection['asumsi_dipakai'] = [];

  const cadangan = readNumber('cadangan_minimal', 0, hariIni, scenario, database);
  asumsiDipakai.push({
    key: 'cadangan_minimal',
    value: cadangan.value,
    certainty: cadangan.certainty,
    dari_skenario: cadangan.dari_skenario,
  });

  const reimburseLag = readNumber('reimburse_lag_hari', 14, hariIni, scenario, database);
  asumsiDipakai.push({
    key: 'reimburse_lag_hari',
    value: reimburseLag.value,
    certainty: reimburseLag.certainty,
    dari_skenario: reimburseLag.dari_skenario,
  });

  // --- Transaksi aktual -----------------------------------------------------
  const placeholders = accountIds.length ? accountIds.map(() => '?').join(',') : 'NULL';
  const events = database
    .prepare(
      `SELECT ce.id, ce.occurred_at, ce.direction, ce.amount_minor, ce.kind, ce.account_id, ce.is_cash,
              ce.merchant_raw, ce.service_id, ce.status,
              a.id AS alloc_id, a.amount_minor AS alloc_amount, a.purpose,
              c.slug AS category_slug, c.is_routine
         FROM cash_event ce
         JOIN allocation a ON a.cash_event_id = ce.id
         LEFT JOIN category c ON c.id = COALESCE(a.category_id, ce.category_id)
        WHERE ce.status <> 'dibatalkan'
          AND date(ce.occurred_at) BETWEEN ? AND ?
          AND (ce.account_id IN (${placeholders}) OR ce.is_cash = 1)
        ORDER BY ce.occurred_at, ce.id, a.id`,
    )
    .all(dari, sampai, ...accountIds) as EventRow[];

  // Biaya yang dibayar langsung company: tidak lewat rekening saya.
  const companyDirect = database
    .prepare(
      `SELECT ce.id, ce.occurred_at, ce.amount_minor, ce.merchant_raw
         FROM cash_event ce
        WHERE ce.status <> 'dibatalkan'
          AND ce.kind = 'pengeluaran_company_langsung'
          AND ce.account_id IS NULL
          AND ce.is_cash = 0
          AND date(ce.occurred_at) BETWEEN ? AND ?`,
    )
    .all(dari, sampai) as Array<{
    id: number;
    occurred_at: string;
    amount_minor: number;
    merchant_raw: string | null;
  }>;

  // --- Rencana --------------------------------------------------------------
  const obligations = database
    .prepare(
      `SELECT o.*, s.name AS service_name
         FROM obligation o LEFT JOIN service s ON s.id = o.service_id
        WHERE o.status = 'rencana'
          AND o.due_date <= ?`,
    )
    .all(sampai) as Array<Record<string, unknown>>;

  const topups = database
    .prepare(`SELECT * FROM topup_plan WHERE plan_date <= ? AND status <> 'dibatalkan'`)
    .all(sampai) as Array<Record<string, unknown>>;

  const receivables = database
    .prepare(
      `SELECT r.*, p.name AS debtor_name
         FROM receivable r LEFT JOIN person p ON p.id = r.debtor_person_id
        WHERE r.status NOT IN ('lunas','dihapuskan')`,
    )
    .all() as Array<Record<string, unknown>>;

  // --- Kelompokkan per hari -------------------------------------------------
  const days = eachDay(dari, sampai);
  const byDay = new Map<IsoDate, DayRow>();
  for (const d of days) {
    byDay.set(d, {
      tanggal: d,
      is_masa_lalu: d < hariIni,
      is_hari_ini: d === hariIni,
      saldo_awal_minor: 0,
      masuk_aktual_minor: 0,
      masuk_rencana_minor: 0,
      reimburse_rencana_minor: 0,
      makan_aktual_minor: 0,
      makan_rencana_minor: 0,
      rutin_lain_minor: 0,
      belanja_minor: 0,
      tagihan_minor: 0,
      talangan_keluar_minor: 0,
      transfer_keluar_minor: 0,
      transfer_masuk_minor: 0,
      biaya_company_minor: 0,
      keluar_total_minor: 0,
      saldo_akhir_minor: 0,
      saldo_akhir_realisasi_minor: null,
      saldo_akhir_tanpa_reimburse_minor: 0,
      status: 'aman',
      anggaran_makan_minor: 0,
      selisih_makan_minor: 0,
      drivers: [],
      catatan: [],
      risiko_belum_terhitung: [],
    });
  }

  /** Delta saldo aktual dan proyeksi per hari, dihitung terpisah. */
  const deltaAktual = new Map<IsoDate, number>();
  const deltaRencana = new Map<IsoDate, number>();
  const deltaReimburse = new Map<IsoDate, number>();
  const bump = (m: Map<IsoDate, number>, d: IsoDate, v: number) => m.set(d, (m.get(d) ?? 0) + v);

  // Transaksi aktual
  for (const row of events) {
    const d = dateOf(row.occurred_at);
    const day = byDay.get(d);
    if (!day) continue;
    const { bucket, neutral } = bucketFor(row);
    const netral = neutral && (perspektifTotal || bucket === 'biaya_company');
    const amount = row.alloc_amount;

    switch (bucket) {
      case 'pemasukan':
        day.masuk_aktual_minor += amount;
        break;
      case 'reimburse_masuk':
        day.masuk_aktual_minor += amount;
        break;
      case 'refund_masuk':
        day.masuk_aktual_minor += amount;
        break;
      case 'makan':
        day.makan_aktual_minor += amount;
        break;
      case 'rutin_lain':
        day.rutin_lain_minor += amount;
        break;
      case 'belanja':
        day.belanja_minor += amount;
        break;
      case 'tagihan':
        day.tagihan_minor += amount;
        break;
      case 'talangan_keluar':
        day.talangan_keluar_minor += amount;
        break;
      case 'transfer_keluar':
        day.transfer_keluar_minor += amount;
        break;
      case 'transfer_masuk':
        day.transfer_masuk_minor += amount;
        break;
      case 'biaya_company':
        day.biaya_company_minor += amount;
        break;
      case 'koreksi':
        if (row.direction === 'masuk') day.masuk_aktual_minor += amount;
        else day.belanja_minor += amount;
        break;
    }

    if (!netral) bump(deltaAktual, d, row.direction === 'masuk' ? amount : -amount);

    day.drivers.push({
      label: row.merchant_raw ?? `Transaksi #${row.id}`,
      amount_minor: amount,
      direction: netral ? 'netral' : row.direction,
      bucket,
      certainty: 'terverifikasi',
      jenis: 'aktual',
      ref: { tipe: 'cash_event', id: row.id },
    });

    if (row.status === 'menunggu_pasangan') {
      day.catatan.push(
        'Ada transfer antar rekening saya yang baru terlihat satu sisinya (menunggu pasangan).',
      );
    }
  }

  for (const cd of companyDirect) {
    const d = dateOf(cd.occurred_at);
    const day = byDay.get(d);
    if (!day) continue;
    day.biaya_company_minor += cd.amount_minor;
    day.drivers.push({
      label: `${cd.merchant_raw ?? 'Biaya company'} (dibayar company)`,
      amount_minor: cd.amount_minor,
      direction: 'netral',
      bucket: 'biaya_company',
      certainty: 'terverifikasi',
      jenis: 'aktual',
      ref: { tipe: 'cash_event', id: cd.id },
    });
  }

  // Rencana makan
  for (const d of days) {
    const day = byDay.get(d);
    if (!day) continue;
    const makan = readNumber('anggaran_makan_harian', 0, d, scenario, database);
    day.anggaran_makan_minor = makan.value;

    if (d < hariIni) {
      day.makan_rencana_minor = 0;
      if (day.makan_aktual_minor === 0 && makan.value > 0) {
        day.catatan.push('Belum ada catatan makan untuk hari ini (data belum lengkap).');
      }
    } else if (d === hariIni) {
      day.makan_rencana_minor = Math.max(0, makan.value - day.makan_aktual_minor);
    } else {
      day.makan_rencana_minor = makan.value;
    }
    day.selisih_makan_minor = makan.value - (day.makan_aktual_minor + day.makan_rencana_minor);

    if (day.makan_rencana_minor > 0) {
      bump(deltaRencana, d, -day.makan_rencana_minor);
      day.drivers.push({
        label: 'Anggaran makan',
        amount_minor: day.makan_rencana_minor,
        direction: 'keluar',
        bucket: 'makan',
        certainty: makan.certainty,
        jenis: 'rencana',
      });
    }
  }
  const makanHariIni = readNumber('anggaran_makan_harian', 0, hariIni, scenario, database);
  asumsiDipakai.push({
    key: 'anggaran_makan_harian',
    value: makanHariIni.value,
    certainty: makanHariIni.certainty,
    dari_skenario: makanHariIni.dari_skenario,
  });

  // Top-up
  const geser = typeof scenario.overrides['topup_geser_hari'] === 'number'
    ? (scenario.overrides['topup_geser_hari'] as number)
    : 0;
  for (const t of topups) {
    const status = String(t['status']);
    const planDateAsli = String(t['plan_date']);
    const planDate = geser ? addDays(planDateAsli, geser) : planDateAsli;
    const day = byDay.get(planDate);
    const planNominalRaw = scenario.overrides['topup_nominal'];
    const nominal =
      typeof planNominalRaw === 'number' ? planNominalRaw : Number(t['plan_amount_minor']);

    if (status === 'diterima' || status === 'sebagian') continue; // sudah jadi transaksi aktual
    if (status === 'tidak_diterima') {
      if (day) day.catatan.push('Top-up rencana ditandai tidak diterima, jadi tidak dihitung.');
      continue;
    }
    if (planDate < hariIni) {
      risiko.push({
        tipe: 'topup_belum_dikonfirmasi',
        tanggal: planDate,
        nominal_minor: nominal,
        pesan: `Rencana top-up ${planDate} sudah lewat tetapi belum dikonfirmasi diterima atau tidak.`,
        ref: { tipe: 'topup_plan', id: Number(t['id']) },
      });
      if (day) day.catatan.push('Rencana top-up hari ini sudah lewat dan belum dikonfirmasi.');
      continue;
    }
    if (!day) continue;
    day.masuk_rencana_minor += nominal;
    bump(deltaRencana, planDate, nominal);
    day.drivers.push({
      label: `Top-up rencana${geser ? ` (digeser ${geser} hari)` : ''}`,
      amount_minor: nominal,
      direction: 'masuk',
      bucket: 'pemasukan',
      certainty: 'perkiraan',
      jenis: 'rencana',
      ref: { tipe: 'topup_plan', id: Number(t['id']) },
    });
  }

  // Kewajiban (langganan, tagihan, belanja rencana)
  for (const o of obligations) {
    const tag = (o['scenario_tag'] as string | null) ?? null;
    if (tag && !scenario.enabledTags.has(tag)) continue;

    const dueAsli = String(o['due_date']);
    const terlambat = dueAsli < hariIni;
    const target = terlambat ? maxDate(dari, hariIni) : dueAsli;
    const day = byDay.get(target);
    if (!day) continue;

    const amount = o['amount_minor'] === null ? null : Number(o['amount_minor']);
    const affects = Number(o['affects_my_cash']) === 1;
    const label = String(o['label']);
    const certainty = String(o['amount_certainty']) as Certainty;

    if (amount === null) {
      const pesan = `${label} (${dueAsli}) belum punya nominal, jadi dampaknya belum dapat dihitung.`;
      day.risiko_belum_terhitung.push(pesan);
      risiko.push({
        tipe: 'harga_belum_diketahui',
        tanggal: dueAsli,
        nominal_minor: null,
        pesan,
        ref: { tipe: 'obligation', id: Number(o['id']) },
      });
      day.drivers.push({
        label,
        amount_minor: null,
        direction: 'keluar',
        bucket: o['kind'] === 'belanja_rencana' ? 'belanja' : 'tagihan',
        certainty,
        jenis: 'rencana',
        terlambat,
        ref: { tipe: 'obligation', id: Number(o['id']) },
      });
      continue;
    }

    if (!affects) {
      day.biaya_company_minor += amount;
      day.drivers.push({
        label: `${label} (dibayar company)`,
        amount_minor: amount,
        direction: 'netral',
        bucket: 'biaya_company',
        certainty,
        jenis: 'rencana',
        terlambat,
        ref: { tipe: 'obligation', id: Number(o['id']) },
      });
      continue;
    }

    if (o['kind'] === 'belanja_rencana') day.belanja_minor += amount;
    else day.tagihan_minor += amount;
    bump(deltaRencana, target, -amount);

    day.drivers.push({
      label: terlambat ? `${label} (terlambat, jatuh tempo ${dueAsli})` : label,
      amount_minor: amount,
      direction: 'keluar',
      bucket: o['kind'] === 'belanja_rencana' ? 'belanja' : 'tagihan',
      certainty,
      jenis: 'rencana',
      terlambat,
      ref: { tipe: 'obligation', id: Number(o['id']) },
    });

    if (terlambat) {
      tambahRisiko({
        tipe: 'tagihan_terlambat',
        tanggal: dueAsli,
        nominal_minor: amount,
        pesan: `${label} jatuh tempo ${dueAsli} dan belum tercatat dibayar.`,
        ref: { tipe: 'obligation', id: Number(o['id']) },
      });
    }
    if (o['paid_by'] === 'belum_jelas') {
      tambahRisiko(
        {
          tipe: 'penanggung_belum_jelas',
          tanggal: dueAsli,
          nominal_minor: amount,
          pesan: `${label}: belum ditentukan company bayar langsung atau saya menalangi lalu direimburse.`,
          ref: { tipe: 'obligation', id: Number(o['id']) },
        },
        `penanggung:${o['service_id'] ?? label}`,
      );
    }
    if (certainty !== 'terverifikasi') {
      tambahRisiko(
        {
          tipe: 'nominal_belum_terverifikasi',
          tanggal: dueAsli,
          nominal_minor: amount,
          pesan: `Nominal ${label} masih ${certainty === 'asumsi_sheet' ? 'asumsi Sheet' : 'perkiraan'}.`,
          ref: { tipe: 'obligation', id: Number(o['id']) },
        },
        `nominal:${o['service_id'] ?? label}`,
      );
    }
  }

  // Perkiraan reimburse masuk
  if (!opts.tanpa_reimburse) {
    for (const r of receivables) {
      const sisa = Number(r['origin_amount_minor']) - Number(r['settled_minor']);
      if (sisa <= 0) continue;
      const expected =
        (r['expected_on'] as string | null) ??
        addDays(String(r['occurred_on']), reimburseLag.value);
      const terlambat = expected < hariIni;
      const target = terlambat ? maxDate(dari, hariIni) : expected;
      const day = byDay.get(target);
      if (terlambat) {
        risiko.push({
          tipe: 'reimburse_terlambat',
          tanggal: expected,
          nominal_minor: sisa,
          pesan: `Reimburse dari ${r['debtor_name'] ?? r['debtor_type']} sebesar ${sisa} sudah lewat perkiraan ${expected}.`,
          ref: { tipe: 'receivable', id: Number(r['id']) },
        });
      }
      if (!day) continue;
      day.masuk_rencana_minor += sisa;
      day.reimburse_rencana_minor += sisa;
      bump(deltaRencana, target, sisa);
      bump(deltaReimburse, target, sisa);
      day.drivers.push({
        label: `Perkiraan reimburse ${r['debtor_name'] ?? r['debtor_type']}`,
        amount_minor: sisa,
        direction: 'masuk',
        bucket: 'reimburse_masuk',
        certainty: 'perkiraan',
        jenis: 'rencana',
        terlambat,
        ref: { tipe: 'receivable', id: Number(r['id']) },
      });
    }
  }

  // Item tambahan (simulasi)
  for (const extra of opts.tambahan ?? []) {
    const day = byDay.get(extra.tanggal);
    if (!day) continue;
    const dir = extra.direction ?? 'keluar';
    const bucket = extra.bucket ?? 'belanja';
    if (extra.nominal_minor === null) {
      day.risiko_belum_terhitung.push(`${extra.label}: harga belum diketahui.`);
      risiko.push({
        tipe: 'harga_belum_diketahui',
        tanggal: extra.tanggal,
        nominal_minor: null,
        pesan: `${extra.label}: harga belum diketahui, jadi dampaknya belum dapat dihitung.`,
      });
    } else {
      if (dir === 'keluar') day.belanja_minor += extra.nominal_minor;
      else day.masuk_rencana_minor += extra.nominal_minor;
      bump(deltaRencana, extra.tanggal, dir === 'masuk' ? extra.nominal_minor : -extra.nominal_minor);
    }
    day.drivers.push({
      label: extra.label,
      amount_minor: extra.nominal_minor,
      direction: dir,
      bucket,
      certainty: extra.certainty ?? 'perkiraan',
      jenis: 'rencana',
    });
  }

  // --- Jalankan saldo -------------------------------------------------------
  const dasar = openingBalance(dari, database);
  if (dasar.certainty !== 'terverifikasi') {
    risiko.push({
      tipe: 'saldo_belum_terverifikasi',
      pesan: dasar.catatan[0] ?? 'Saldo awal belum terverifikasi.',
    });
  }
  peringatan.push(...dasar.catatan);

  let saldoProyeksi = dasar.minor;
  let saldoRealisasi = dasar.minor;
  let saldoTanpaReimburse = dasar.minor;
  let terendah = Number.POSITIVE_INFINITY;
  let terendahTanggal: IsoDate = dari;
  let terendahTR = Number.POSITIVE_INFINITY;
  let terendahTRTanggal: IsoDate = dari;
  let tanggalDefisit: IsoDate | null = null;
  const hariRendah: IsoDate[] = [];
  const hariDefisit: IsoDate[] = [];

  for (const d of days) {
    const day = byDay.get(d)!;
    day.saldo_awal_minor = saldoProyeksi;

    const dA = deltaAktual.get(d) ?? 0;
    const dR = deltaRencana.get(d) ?? 0;
    const dRe = deltaReimburse.get(d) ?? 0;

    saldoProyeksi += dA + dR;
    saldoRealisasi += dA;
    saldoTanpaReimburse += dA + dR - dRe;

    day.saldo_akhir_minor = saldoProyeksi;
    day.saldo_akhir_realisasi_minor = d <= hariIni ? saldoRealisasi : null;
    day.saldo_akhir_tanpa_reimburse_minor = saldoTanpaReimburse;

    day.keluar_total_minor =
      day.makan_aktual_minor +
      day.makan_rencana_minor +
      day.rutin_lain_minor +
      day.belanja_minor +
      day.tagihan_minor +
      day.talangan_keluar_minor;

    if (saldoProyeksi < 0) {
      day.status = 'defisit';
      hariDefisit.push(d);
      if (!tanggalDefisit) tanggalDefisit = d;
    } else if (saldoProyeksi < cadangan.value) {
      day.status = 'rendah';
      hariRendah.push(d);
    } else {
      day.status = 'aman';
    }

    if (saldoProyeksi < terendah) {
      terendah = saldoProyeksi;
      terendahTanggal = d;
    }
    if (saldoTanpaReimburse < terendahTR) {
      terendahTR = saldoTanpaReimburse;
      terendahTRTanggal = d;
    }

    for (const r of day.risiko_belum_terhitung) {
      if (!day.catatan.includes(r)) day.catatan.push(r);
    }
  }

  const hariList = days.map((d) => byDay.get(d)!);
  const sum = (pick: (r: DayRow) => number) => hariList.reduce((s, r) => s + pick(r), 0);

  const dataMakanKosong = hariList.filter(
    (r) => r.is_masa_lalu && r.makan_aktual_minor === 0 && r.anggaran_makan_minor > 0,
  );
  if (dataMakanKosong.length) {
    risiko.push({
      tipe: 'data_makan_kosong',
      pesan: `${dataMakanKosong.length} hari di masa lalu belum punya catatan makan, jadi perbandingan rencana vs realisasi belum lengkap.`,
    });
  }

  return {
    dari,
    sampai,
    hari_ini: hariIni,
    skenario: { slug: scenario.slug, nama: scenario.name, deskripsi: scenario.description },
    dasar_saldo: dasar,
    hari: hariList,
    ringkasan: {
      saldo_akhir_minor: saldoProyeksi,
      saldo_akhir_realisasi_minor: sampai >= hariIni ? saldoRealisasi : null,
      saldo_terendah_minor: Number.isFinite(terendah) ? terendah : dasar.minor,
      saldo_terendah_tanggal: terendahTanggal,
      saldo_terendah_tanpa_reimburse_minor: Number.isFinite(terendahTR) ? terendahTR : dasar.minor,
      saldo_terendah_tanpa_reimburse_tanggal: terendahTRTanggal,
      tanggal_defisit: tanggalDefisit,
      cadangan_minimal_minor: cadangan.value,
      kekurangan_agar_tidak_defisit_minor: Math.max(0, -terendah),
      kekurangan_agar_cadangan_aman_minor: Math.max(0, cadangan.value - terendah),
      total_masuk_aktual_minor: sum((r) => r.masuk_aktual_minor),
      total_masuk_rencana_minor: sum((r) => r.masuk_rencana_minor),
      total_keluar_aktual_minor: sum(
        (r) => r.makan_aktual_minor + r.rutin_lain_minor + r.belanja_minor + r.tagihan_minor + r.talangan_keluar_minor,
      ),
      total_keluar_rencana_minor: sum((r) => r.makan_rencana_minor),
      total_makan_aktual_minor: sum((r) => r.makan_aktual_minor),
      total_makan_rencana_minor: sum((r) => r.makan_rencana_minor),
      total_tagihan_minor: sum((r) => r.tagihan_minor),
      total_belanja_minor: sum((r) => r.belanja_minor),
      total_biaya_company_minor: sum((r) => r.biaya_company_minor),
      hari_rendah: hariRendah,
      hari_defisit: hariDefisit,
    },
    risiko,
    asumsi_dipakai: asumsiDipakai,
    peringatan,
  };
}
