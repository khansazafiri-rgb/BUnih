import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import {
  addDays, addMonths, daysInMonth, diffDays, endOfMonth, endOfWeek, isValidDate, nowIso,
  startOfMonth, startOfWeek, today, type IsoDate,
} from './time.js';
import { categoryBySlug, categorySubtreeIds, getCategory } from './categories.js';
import { spendRows, sumSpend } from './spend.js';
import { writeAudit } from './audit.js';

export class BudgetError extends Error {}

export type BudgetPeriod = 'harian' | 'mingguan' | 'bulanan' | 'kustom';

export type BudgetRow = {
  id: number;
  name: string;
  category_id: number | null;
  period: BudgetPeriod;
  amount_minor: number;
  start_date: IsoDate;
  end_date: IsoDate | null;
  recurring: number;
  rollover: number;
  active: number;
  note: string | null;
};

export type BudgetStatus = 'aman' | 'berisiko' | 'lewat' | 'belum_mulai' | 'selesai';

export type BudgetEval = {
  id: number;
  nama: string;
  kategori_id: number | null;
  kategori_nama: string | null;
  kategori_ikon: string | null;
  periode: BudgetPeriod;
  berulang: boolean;
  rollover: boolean;
  jendela: { dari: IsoDate; sampai: IsoDate; total_hari: number };
  nominal_periode_minor: number;
  carry_minor: number;
  dialokasikan_minor: number;
  terpakai_minor: number;
  sisa_minor: number;
  persen_terpakai: number;
  hari_berjalan: number;
  hari_tersisa: number;
  sisa_per_hari_minor: number;
  /** Seberapa banyak yang "seharusnya" terpakai pada hari ini bila merata sepanjang periode. */
  jadwal_minor: number;
  lebih_cepat_dari_jadwal: boolean;
  /** ESTIMASI, bukan pengeluaran sungguhan. null bila data belum cukup. */
  perkiraan_akhir_minor: number | null;
  perkiraan_terbatas: boolean;
  status: BudgetStatus;
  status_teks: string;
};

export function getBudget(id: number, database: DB = db()): BudgetRow | undefined {
  return database.prepare(`SELECT * FROM budget WHERE id = ?`).get(id) as BudgetRow | undefined;
}

/** Nominal yang berlaku pada tanggal tertentu: revisi terbaru yang sudah berlaku, atau nominal awal. */
export function amountAt(budget: BudgetRow, date: IsoDate, database: DB = db()): number {
  const rev = database
    .prepare(
      `SELECT amount_minor FROM budget_revision
        WHERE budget_id = ? AND effective_from <= ?
        ORDER BY effective_from DESC, id DESC LIMIT 1`,
    )
    .get(budget.id, date) as { amount_minor: number } | undefined;
  return rev?.amount_minor ?? budget.amount_minor;
}

type Jendela = { dari: IsoDate; sampai: IsoDate };

/** Jendela waktu anggaran yang memuat `asOf` (atau jendela tunggal untuk anggaran sekali). */
export function windowFor(b: BudgetRow, asOf: IsoDate): Jendela {
  if (b.period === 'kustom') {
    return { dari: b.start_date, sampai: b.end_date ?? b.start_date };
  }
  const acuan = b.recurring ? asOf : b.start_date;
  switch (b.period) {
    case 'harian':
      return { dari: acuan, sampai: acuan };
    case 'mingguan':
      return b.recurring
        ? { dari: startOfWeek(acuan), sampai: endOfWeek(acuan) }
        : { dari: b.start_date, sampai: addDays(b.start_date, 6) };
    case 'bulanan':
    default:
      return { dari: startOfMonth(acuan), sampai: endOfMonth(acuan) };
  }
}

function previousWindow(b: BudgetRow, w: Jendela): Jendela {
  switch (b.period) {
    case 'harian':
      return { dari: addDays(w.dari, -1), sampai: addDays(w.dari, -1) };
    case 'mingguan':
      return { dari: addDays(w.dari, -7), sampai: addDays(w.dari, -1) };
    default: {
      const dari = startOfMonth(addMonths(w.dari, -1));
      return { dari, sampai: endOfMonth(dari) };
    }
  }
}

function categoryIdsFor(b: BudgetRow, database: DB): number[] | null {
  return b.category_id === null ? null : categorySubtreeIds(b.category_id, database);
}

/** Sisa dari jendela-jendela sebelumnya (hanya yang positif), maksimal 24 jendela ke belakang. */
function carryOver(b: BudgetRow, current: Jendela, database: DB): number {
  if (!b.rollover || !b.recurring || b.period === 'kustom') return 0;
  const ids = categoryIdsFor(b, database);
  const awal = windowFor({ ...b, recurring: 1 }, b.start_date);
  let w = previousWindow(b, current);
  let total = 0;
  for (let i = 0; i < 24 && w.sampai >= awal.dari; i += 1) {
    const nominal = amountAt(b, w.sampai, database);
    const terpakai = sumSpend(spendRows(w.dari, w.sampai, { categoryIds: ids }, database));
    total += Math.max(0, nominal - terpakai);
    w = previousWindow(b, w);
  }
  return total;
}

export function evaluateBudget(
  b: BudgetRow,
  asOf: IsoDate = today(),
  database: DB = db(),
): BudgetEval {
  const w = windowFor(b, asOf);
  const totalHari = diffDays(w.dari, w.sampai) + 1;
  const kategori = b.category_id !== null ? getCategory(b.category_id, database) : undefined;

  const nominal = amountAt(b, asOf < w.sampai ? asOf : w.sampai, database);
  const carry = carryOver(b, w, database);
  const dialokasikan = nominal + carry;
  const terpakai = sumSpend(
    spendRows(w.dari, w.sampai, { categoryIds: categoryIdsFor(b, database) }, database),
  );
  const sisa = dialokasikan - terpakai;

  const belumMulai = asOf < w.dari || (!b.recurring && asOf < b.start_date);
  const selesai = asOf > w.sampai && (!b.recurring || (b.end_date !== null && asOf > b.end_date));
  const hariBerjalan = belumMulai ? 0 : Math.min(totalHari, Math.max(0, diffDays(w.dari, asOf) + 1));
  const hariTersisa = asOf > w.sampai ? 0 : Math.max(0, diffDays(asOf < w.dari ? w.dari : asOf, w.sampai) + 1);
  const jadwal = Math.round((dialokasikan * hariBerjalan) / totalHari);

  // Perkiraan akhir periode adalah ESTIMASI linear dari laju pemakaian sejauh ini.
  let perkiraan: number | null = null;
  let terbatas = false;
  if (asOf > w.sampai) {
    perkiraan = terpakai;
  } else if (totalHari === 1) {
    perkiraan = terpakai;
  } else if (hariBerjalan >= 3 || hariBerjalan / totalHari >= 0.25) {
    perkiraan = Math.round((terpakai / hariBerjalan) * totalHari);
  } else {
    terbatas = true;
  }

  let status: BudgetStatus;
  let teks: string;
  if (belumMulai) {
    status = 'belum_mulai';
    teks = 'Belum dimulai';
  } else if (selesai && terpakai <= dialokasikan) {
    status = 'selesai';
    teks = 'Periode selesai, masih di bawah batas';
  } else if (terpakai > dialokasikan) {
    status = 'lewat';
    teks = 'Sudah melewati batas';
  } else if (perkiraan !== null && perkiraan > dialokasikan) {
    status = 'berisiko';
    teks = 'Berisiko melewati batas';
  } else {
    status = 'aman';
    teks = 'Masih di bawah batas';
  }

  return {
    id: b.id,
    nama: b.name,
    kategori_id: b.category_id,
    kategori_nama: kategori?.name ?? null,
    kategori_ikon: kategori?.icon ?? null,
    periode: b.period,
    berulang: b.recurring === 1,
    rollover: b.rollover === 1,
    jendela: { ...w, total_hari: totalHari },
    nominal_periode_minor: nominal,
    carry_minor: carry,
    dialokasikan_minor: dialokasikan,
    terpakai_minor: terpakai,
    sisa_minor: sisa,
    persen_terpakai: dialokasikan > 0 ? Math.round((terpakai / dialokasikan) * 100) : 0,
    hari_berjalan: hariBerjalan,
    hari_tersisa: hariTersisa,
    sisa_per_hari_minor: sisa > 0 && hariTersisa > 0 ? Math.floor(sisa / hariTersisa) : 0,
    jadwal_minor: jadwal,
    lebih_cepat_dari_jadwal: !belumMulai && totalHari > 1 && terpakai > jadwal * 1.1 && jadwal > 0,
    perkiraan_akhir_minor: perkiraan,
    perkiraan_terbatas: terbatas,
    status,
    status_teks: teks,
  };
}

export function listBudgets(
  opts: { termasukNonaktif?: boolean; asOf?: IsoDate } = {},
  database: DB = db(),
): BudgetEval[] {
  const rows = database
    .prepare(`SELECT * FROM budget ${opts.termasukNonaktif ? '' : 'WHERE active = 1'} ORDER BY id`)
    .all() as BudgetRow[];
  return rows.map((b) => evaluateBudget(b, opts.asOf ?? today(), database));
}

export type BudgetInput = {
  name: string;
  category_id?: number | null;
  period: BudgetPeriod;
  amount_minor: number;
  start_date?: IsoDate;
  end_date?: IsoDate | null;
  recurring?: boolean;
  rollover?: boolean;
  note?: string | null;
};

function validasi(input: BudgetInput, database: DB): void {
  if (!input.name.trim()) throw new BudgetError('Nama anggaran wajib diisi.');
  if (!Number.isInteger(input.amount_minor) || input.amount_minor <= 0) {
    throw new BudgetError('Nominal anggaran harus lebih dari nol.');
  }
  if (input.category_id !== undefined && input.category_id !== null && !getCategory(input.category_id, database)) {
    throw new BudgetError('Kategori tidak ditemukan.');
  }
  if (input.period === 'kustom') {
    if (!input.start_date || !input.end_date) throw new BudgetError('Anggaran kustom butuh tanggal mulai dan akhir.');
    if (!isValidDate(input.start_date) || !isValidDate(input.end_date)) throw new BudgetError('Tanggal tidak valid.');
    if (input.end_date < input.start_date) throw new BudgetError('Tanggal akhir tidak boleh sebelum tanggal mulai.');
  }
}

export function createBudget(input: BudgetInput, actor = 'web', database: DB = db()): number {
  validasi(input, database);
  const at = nowIso();
  const kustom = input.period === 'kustom';
  const res = database
    .prepare(
      `INSERT INTO budget (name, category_id, period, amount_minor, start_date, end_date, recurring, rollover,
                           active, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      input.name.trim(),
      input.category_id ?? null,
      input.period,
      input.amount_minor,
      input.start_date ?? today(),
      kustom ? (input.end_date ?? null) : (input.end_date ?? null),
      kustom ? 0 : input.recurring === false ? 0 : 1,
      !kustom && input.rollover ? 1 : 0,
      input.note ?? null,
      at,
      at,
    );
  const id = Number(res.lastInsertRowid);
  writeAudit({ entity: 'budget', entity_id: id, action: 'buat', actor, after: input }, database);
  return id;
}

export function updateBudget(
  id: number,
  patch: Partial<Pick<BudgetInput, 'name' | 'category_id' | 'end_date' | 'rollover' | 'note'>> & { active?: boolean },
  actor = 'web',
  database: DB = db(),
): void {
  const before = getBudget(id, database);
  if (!before) throw new BudgetError('Anggaran tidak ditemukan.');
  const kolom: string[] = [];
  const nilai: unknown[] = [];
  const set = (k: string, v: unknown) => {
    kolom.push(`${k} = ?`);
    nilai.push(v);
  };
  if (patch.name !== undefined) set('name', patch.name.trim());
  if (patch.category_id !== undefined) {
    if (patch.category_id !== null && !getCategory(patch.category_id, database)) {
      throw new BudgetError('Kategori tidak ditemukan.');
    }
    set('category_id', patch.category_id);
  }
  if (patch.end_date !== undefined) set('end_date', patch.end_date);
  if (patch.rollover !== undefined) set('rollover', patch.rollover ? 1 : 0);
  if (patch.note !== undefined) set('note', patch.note);
  if (patch.active !== undefined) set('active', patch.active ? 1 : 0);
  if (!kolom.length) return;
  set('updated_at', nowIso());
  database.prepare(`UPDATE budget SET ${kolom.join(', ')} WHERE id = ?`).run(...nilai, id);
  writeAudit({ entity: 'budget', entity_id: id, action: 'ubah', actor, before, after: patch }, database);
}

/** Ubah nominal mulai tanggal tertentu. Nominal masa lalu tidak berubah. */
export function reviseBudget(
  id: number,
  amountMinor: number,
  opts: { effective_from?: IsoDate; note?: string | null } = {},
  actor = 'web',
  database: DB = db(),
): void {
  const b = getBudget(id, database);
  if (!b) throw new BudgetError('Anggaran tidak ditemukan.');
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new BudgetError('Nominal harus lebih dari nol.');
  const efektif = opts.effective_from ?? today();
  database
    .prepare(
      `INSERT INTO budget_revision (budget_id, amount_minor, effective_from, note, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, amountMinor, efektif, opts.note ?? null, nowIso());
  writeAudit(
    {
      entity: 'budget',
      entity_id: id,
      action: 'revisi_nominal',
      actor,
      before: { amount_minor: amountAt(b, efektif, database) },
      after: { amount_minor: amountMinor, effective_from: efektif },
    },
    database,
  );
}

export function budgetRevisions(id: number, database: DB = db()) {
  return database
    .prepare(`SELECT * FROM budget_revision WHERE budget_id = ? ORDER BY effective_from DESC, id DESC`)
    .all(id);
}

/**
 * Setara harian dari anggaran aktif untuk satu kategori pada tanggal tertentu.
 * Dipakai proyeksi arus kas supaya SATU anggaran makan menjadi sumber kebenaran, bukan asumsi terpisah.
 * null bila tidak ada anggaran yang cocok.
 */
export function dailyEquivalentForCategory(
  slug: string,
  date: IsoDate,
  database: DB = db(),
): number | null {
  const cat = categoryBySlug(slug, database);
  if (!cat) return null;
  const rows = database
    .prepare(`SELECT * FROM budget WHERE active = 1 AND category_id = ? ORDER BY id`)
    .all(cat.id) as BudgetRow[];
  for (const b of rows) {
    if (date < b.start_date && !b.recurring) continue;
    const w = windowFor(b, date);
    if (date < w.dari || date > w.sampai) continue;
    if (b.end_date && date > b.end_date) continue;
    const nominal = amountAt(b, date, database);
    const hari = b.period === 'bulanan' ? daysInMonth(date) : diffDays(w.dari, w.sampai) + 1;
    return Math.round(nominal / hari);
  }
  return null;
}
