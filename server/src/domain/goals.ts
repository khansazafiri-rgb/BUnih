import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { addDays, diffDays, isValidDate, nowIso, today, type IsoDate } from './time.js';
import { formatIDR } from './money.js';
import { writeAudit } from './audit.js';

export class GoalError extends Error {}

export type GoalStatus = 'aktif' | 'dijeda' | 'tercapai' | 'dibatalkan';

export type GoalRow = {
  id: number;
  name: string;
  target_minor: number;
  start_minor: number;
  target_date: IsoDate | null;
  account_id: number | null;
  status: GoalStatus;
  reminder: number;
  icon: string | null;
  note: string | null;
  created_at: string;
};

export type GoalRisk =
  | 'tercapai'
  | 'tepat'
  | 'berisiko'
  | 'terlambat'
  | 'belum_ada_setoran'
  | 'tanpa_tanggal'
  | 'dijeda'
  | 'dibatalkan';

export type GoalEval = {
  id: number;
  nama: string;
  ikon: string | null;
  status: GoalStatus;
  target_minor: number;
  mulai_minor: number;
  terkumpul_minor: number;
  /** Bagian yang menunjuk transfer tabungan sungguhan. */
  dari_transfer_tercatat_minor: number;
  /** Bagian yang hanya disisihkan sebagai penanda (uangnya tetap di rekening asalnya). */
  disisihkan_minor: number;
  sisa_minor: number;
  persen: number;
  target_date: IsoDate | null;
  hari_tersisa: number | null;
  perlu_per_bulan_minor: number | null;
  perlu_per_minggu_minor: number | null;
  laju_bulanan_minor: number;
  perkiraan_tercapai: IsoDate | null;
  risiko: GoalRisk;
  penjelasan: string;
  rekening_nama: string | null;
  pengingat: boolean;
  catatan: string | null;
};

const HARI_PER_BULAN = 30.4375;

export function getGoal(id: number, database: DB = db()): GoalRow | undefined {
  return database.prepare(`SELECT * FROM goal WHERE id = ?`).get(id) as GoalRow | undefined;
}

function totals(goalId: number, database: DB) {
  const row = database
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'transfer_tercatat' THEN amount_minor ELSE 0 END), 0) AS transfer,
         COALESCE(SUM(CASE WHEN kind = 'disisihkan' THEN amount_minor ELSE 0 END), 0) AS sisih
         FROM goal_contribution WHERE goal_id = ?`,
    )
    .get(goalId) as { transfer: number; sisih: number };
  return row;
}

export function evaluateGoal(g: GoalRow, asOf: IsoDate = today(), database: DB = db()): GoalEval {
  const t = totals(g.id, database);
  const terkumpul = Math.max(0, g.start_minor + t.transfer + t.sisih);
  const sisa = Math.max(0, g.target_minor - terkumpul);
  const persen = Math.min(100, Math.floor((terkumpul / g.target_minor) * 100));

  // Laju menabung: setoran bersih 90 hari terakhir, tetapi tidak lebih pendek dari 30 hari.
  const awalJendela = addDays(asOf, -90);
  const net = database
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS n FROM goal_contribution
        WHERE goal_id = ? AND occurred_on > ? AND occurred_on <= ?`,
    )
    .get(g.id, awalJendela, asOf) as { n: number };
  const umurHari = Math.max(30, Math.min(90, diffDays(g.created_at.slice(0, 10), asOf) + 1));
  const laju = Math.max(0, Math.round(net.n / (umurHari / HARI_PER_BULAN)));

  const rekening = g.account_id
    ? ((database.prepare(`SELECT name FROM account WHERE id = ?`).get(g.account_id) as { name: string } | undefined)?.name ?? null)
    : null;

  const hariTersisa = g.target_date ? diffDays(asOf, g.target_date) : null;
  let perluBulan: number | null = null;
  let perluMinggu: number | null = null;
  if (sisa > 0 && hariTersisa !== null && hariTersisa > 0) {
    perluBulan = Math.ceil(sisa / (hariTersisa / HARI_PER_BULAN));
    perluMinggu = Math.ceil(sisa / (hariTersisa / 7));
  }
  const perkiraan = sisa > 0 && laju > 0 ? addDays(asOf, Math.ceil((sisa / laju) * HARI_PER_BULAN)) : null;

  let risiko: GoalRisk;
  let penjelasan: string;
  if (g.status === 'dibatalkan') {
    risiko = 'dibatalkan';
    penjelasan = 'Tujuan ini dibatalkan.';
  } else if (g.status === 'dijeda') {
    risiko = 'dijeda';
    penjelasan = 'Tujuan ini sedang dijeda, jadi tidak dihitung risikonya.';
  } else if (sisa === 0) {
    risiko = 'tercapai';
    penjelasan = 'Target tercapai. Selamat!';
  } else if (hariTersisa === null) {
    risiko = 'tanpa_tanggal';
    penjelasan =
      laju > 0 && perkiraan
        ? `Belum ada tanggal target. Dengan laju sekarang (${formatIDR(laju)} per bulan), target tercapai sekitar ${perkiraan}.`
        : 'Belum ada tanggal target dan belum ada setoran, jadi belum bisa diperkirakan.';
  } else if (hariTersisa <= 0) {
    risiko = 'terlambat';
    penjelasan = `Tanggal target sudah lewat dan masih kurang ${formatIDR(sisa)}.`;
  } else if (laju <= 0) {
    risiko = 'belum_ada_setoran';
    penjelasan = `Belum ada setoran dalam 90 hari terakhir. Butuh ${formatIDR(perluBulan ?? 0)} per bulan agar tercapai tepat waktu.`;
  } else if (laju >= (perluBulan ?? 0) * 0.95) {
    risiko = 'tepat';
    penjelasan = `Laju ${formatIDR(laju)} per bulan sudah cukup (butuh ${formatIDR(perluBulan ?? 0)}).`;
  } else {
    risiko = 'berisiko';
    penjelasan =
      `Laju ${formatIDR(laju)} per bulan kurang dari kebutuhan ${formatIDR(perluBulan ?? 0)}. ` +
      `Dengan laju ini target baru tercapai sekitar ${perkiraan}, padahal tenggatnya ${g.target_date}.`;
  }

  return {
    id: g.id,
    nama: g.name,
    ikon: g.icon,
    status: g.status,
    target_minor: g.target_minor,
    mulai_minor: g.start_minor,
    terkumpul_minor: terkumpul,
    dari_transfer_tercatat_minor: t.transfer,
    disisihkan_minor: t.sisih,
    sisa_minor: sisa,
    persen,
    target_date: g.target_date,
    hari_tersisa: hariTersisa,
    perlu_per_bulan_minor: perluBulan,
    perlu_per_minggu_minor: perluMinggu,
    laju_bulanan_minor: laju,
    perkiraan_tercapai: perkiraan,
    risiko,
    penjelasan,
    rekening_nama: rekening,
    pengingat: g.reminder === 1,
    catatan: g.note,
  };
}

export function listGoals(
  opts: { termasukSelesai?: boolean; asOf?: IsoDate } = {},
  database: DB = db(),
): GoalEval[] {
  const rows = database
    .prepare(
      `SELECT * FROM goal ${opts.termasukSelesai ? '' : "WHERE status IN ('aktif','dijeda','tercapai')"} ORDER BY
         CASE status WHEN 'aktif' THEN 0 WHEN 'dijeda' THEN 1 WHEN 'tercapai' THEN 2 ELSE 3 END, id`,
    )
    .all() as GoalRow[];
  return rows.map((g) => evaluateGoal(g, opts.asOf ?? today(), database));
}

export type GoalInput = {
  name: string;
  target_minor: number;
  start_minor?: number;
  target_date?: IsoDate | null;
  account_id?: number | null;
  icon?: string | null;
  reminder?: boolean;
  note?: string | null;
};

export function createGoal(input: GoalInput, actor = 'web', database: DB = db()): number {
  if (!input.name.trim()) throw new GoalError('Nama tujuan wajib diisi.');
  if (!Number.isInteger(input.target_minor) || input.target_minor <= 0) {
    throw new GoalError('Target harus lebih dari nol.');
  }
  const mulai = input.start_minor ?? 0;
  if (!Number.isInteger(mulai) || mulai < 0) throw new GoalError('Jumlah awal tidak boleh negatif.');
  if (input.target_date && !isValidDate(input.target_date)) throw new GoalError('Tanggal target tidak valid.');
  if (input.account_id && !database.prepare(`SELECT 1 FROM account WHERE id = ?`).get(input.account_id)) {
    throw new GoalError('Rekening tidak ditemukan.');
  }
  const at = nowIso();
  const status: GoalStatus = mulai >= input.target_minor ? 'tercapai' : 'aktif';
  const res = database
    .prepare(
      `INSERT INTO goal (name, target_minor, start_minor, target_date, account_id, status, reminder, icon, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name.trim(),
      input.target_minor,
      mulai,
      input.target_date ?? null,
      input.account_id ?? null,
      status,
      input.reminder === false ? 0 : 1,
      input.icon ?? null,
      input.note ?? null,
      at,
      at,
    );
  const id = Number(res.lastInsertRowid);
  writeAudit({ entity: 'goal', entity_id: id, action: 'buat', actor, after: input }, database);
  return id;
}

export function updateGoal(
  id: number,
  patch: Partial<GoalInput> & { status?: GoalStatus },
  actor = 'web',
  database: DB = db(),
): void {
  const before = getGoal(id, database);
  if (!before) throw new GoalError('Tujuan tidak ditemukan.');
  const kolom: string[] = [];
  const nilai: unknown[] = [];
  const set = (k: string, v: unknown) => {
    kolom.push(`${k} = ?`);
    nilai.push(v);
  };
  if (patch.name !== undefined) set('name', patch.name.trim());
  if (patch.target_minor !== undefined) {
    if (!Number.isInteger(patch.target_minor) || patch.target_minor <= 0) throw new GoalError('Target harus lebih dari nol.');
    set('target_minor', patch.target_minor);
  }
  if (patch.start_minor !== undefined) set('start_minor', Math.max(0, patch.start_minor));
  if (patch.target_date !== undefined) {
    if (patch.target_date && !isValidDate(patch.target_date)) throw new GoalError('Tanggal target tidak valid.');
    set('target_date', patch.target_date);
  }
  if (patch.account_id !== undefined) set('account_id', patch.account_id);
  if (patch.icon !== undefined) set('icon', patch.icon);
  if (patch.reminder !== undefined) set('reminder', patch.reminder ? 1 : 0);
  if (patch.note !== undefined) set('note', patch.note);
  if (patch.status !== undefined) set('status', patch.status);
  if (!kolom.length) return;
  set('updated_at', nowIso());
  database.prepare(`UPDATE goal SET ${kolom.join(', ')} WHERE id = ?`).run(...nilai, id);
  writeAudit({ entity: 'goal', entity_id: id, action: 'ubah', actor, before, after: patch }, database);
  if (patch.target_minor !== undefined || patch.start_minor !== undefined) syncGoalStatus(id, database);
}

/** Aktif <-> tercapai mengikuti saldo. Status dijeda/dibatalkan tidak diubah otomatis. */
export function syncGoalStatus(id: number, database: DB = db()): void {
  const g = getGoal(id, database);
  if (!g || (g.status !== 'aktif' && g.status !== 'tercapai')) return;
  const e = evaluateGoal(g, today(), database);
  const baru: GoalStatus = e.sisa_minor === 0 ? 'tercapai' : 'aktif';
  if (baru !== g.status) {
    database.prepare(`UPDATE goal SET status = ?, updated_at = ? WHERE id = ?`).run(baru, nowIso(), id);
  }
}

/**
 * Catat setoran ke sebuah tujuan.
 *  - 'disisihkan'        : penanda saja. TIDAK menggerakkan uang dan tidak menyentuh cash_event.
 *  - 'transfer_tercatat' : menunjuk transfer tabungan nyata (cash_event) yang sudah ada.
 */
export function addContribution(
  goalId: number,
  input: {
    amount_minor: number;
    kind?: 'disisihkan' | 'transfer_tercatat';
    occurred_on?: IsoDate;
    cash_event_id?: number | null;
    note?: string | null;
  },
  actor = 'web',
  database: DB = db(),
): number {
  const g = getGoal(goalId, database);
  if (!g) throw new GoalError('Tujuan tidak ditemukan.');
  if (g.status === 'dibatalkan') throw new GoalError('Tujuan yang dibatalkan tidak bisa diisi.');
  if (!Number.isInteger(input.amount_minor) || input.amount_minor === 0) {
    throw new GoalError('Nominal setoran tidak boleh nol.');
  }
  const kind = input.kind ?? 'disisihkan';
  if (kind === 'transfer_tercatat') {
    if (!input.cash_event_id) throw new GoalError('Transfer tercatat harus menunjuk transaksi.');
    const ev = database.prepare(`SELECT id, kind FROM cash_event WHERE id = ?`).get(input.cash_event_id) as
      | { id: number; kind: string }
      | undefined;
    if (!ev) throw new GoalError('Transaksi tidak ditemukan.');
    const sudah = database
      .prepare(`SELECT 1 FROM goal_contribution WHERE goal_id = ? AND cash_event_id = ?`)
      .get(goalId, input.cash_event_id);
    if (sudah) throw new GoalError('Transaksi itu sudah dihitung untuk tujuan ini.');
  }
  const efektif = input.occurred_on ?? today();
  if (!isValidDate(efektif)) throw new GoalError('Tanggal tidak valid.');

  const run = database.transaction(() => {
    const res = database
      .prepare(
        `INSERT INTO goal_contribution (goal_id, amount_minor, kind, occurred_on, cash_event_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(goalId, input.amount_minor, kind, efektif, kind === 'transfer_tercatat' ? input.cash_event_id : null, input.note ?? null, nowIso());
    const id = Number(res.lastInsertRowid);
    writeAudit(
      { entity: 'goal', entity_id: goalId, action: 'setoran', actor, after: { id, ...input, kind } },
      database,
    );
    syncGoalStatus(goalId, database);
    return id;
  });
  return run();
}

export function goalContributions(goalId: number, database: DB = db()) {
  return database
    .prepare(`SELECT * FROM goal_contribution WHERE goal_id = ? ORDER BY occurred_on DESC, id DESC`)
    .all(goalId);
}
