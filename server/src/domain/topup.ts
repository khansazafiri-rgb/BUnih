import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso, today, type IsoDate } from './time.js';
import { writeAudit } from './audit.js';
import { closeDecisionsFor, createDecision } from './decisions.js';
import { formatIDR } from './money.js';
import type { TopupStatus } from './types.js';

export type TopupRow = {
  id: number;
  plan_date: string;
  plan_amount_minor: number;
  account_id: number | null;
  source_label: string | null;
  status: TopupStatus;
  actual_amount_minor: number | null;
  actual_date: string | null;
  cash_event_id: number | null;
  note: string | null;
};

export function listTopups(
  opts: { dari?: IsoDate; sampai?: IsoDate } = {},
  database: DB = db(),
): TopupRow[] {
  const dari = opts.dari ?? '1970-01-01';
  const sampai = opts.sampai ?? '2999-12-31';
  return database
    .prepare(`SELECT * FROM topup_plan WHERE plan_date BETWEEN ? AND ? ORDER BY plan_date`)
    .all(dari, sampai) as TopupRow[];
}

/**
 * Rencana top-up baru menjadi pemasukan setelah ada bukti masuk atau konfirmasi.
 * Nilai aktual dipakai untuk masa lalu; nilai rencana tetap dipakai untuk masa depan.
 */
export function setTopupStatus(
  id: number,
  status: TopupStatus,
  opts: { actual_amount_minor?: number | null; actual_date?: IsoDate | null; cash_event_id?: number | null; note?: string | null; actor?: string } = {},
  database: DB = db(),
): void {
  const before = database.prepare(`SELECT * FROM topup_plan WHERE id = ?`).get(id) as
    | TopupRow
    | undefined;
  if (!before) throw new Error(`Rencana top-up ${id} tidak ditemukan.`);

  const at = nowIso();
  const aktual = opts.actual_amount_minor ?? before.actual_amount_minor;
  const statusFinal: TopupStatus =
    status === 'diterima' && aktual !== null && aktual < before.plan_amount_minor
      ? 'sebagian'
      : status;

  database
    .prepare(
      `UPDATE topup_plan SET status = ?, actual_amount_minor = ?, actual_date = ?,
         cash_event_id = COALESCE(?, cash_event_id), note = COALESCE(?, note), updated_at = ?
       WHERE id = ?`,
    )
    .run(
      statusFinal,
      aktual,
      opts.actual_date ?? before.actual_date ?? (statusFinal === 'diterima' || statusFinal === 'sebagian' ? today() : null),
      opts.cash_event_id ?? null,
      opts.note ?? null,
      at,
      id,
    );

  writeAudit(
    {
      entity: 'topup_plan',
      entity_id: id,
      action: `status_${statusFinal}`,
      actor: opts.actor ?? 'telegram',
      before: { status: before.status, actual_amount_minor: before.actual_amount_minor },
      after: { status: statusFinal, actual_amount_minor: aktual },
    },
    database,
  );
  closeDecisionsFor({ topup_plan_id: id }, 'Status top-up sudah ditentukan.', database);
}

/** Buat pertanyaan untuk rencana top-up yang tanggalnya sudah lewat tetapi belum dikonfirmasi. */
export function tanyakanTopupLewat(database: DB = db()): number {
  const hariIni = today();
  const rows = database
    .prepare(
      `SELECT * FROM topup_plan WHERE status = 'rencana' AND plan_date < ? ORDER BY plan_date`,
    )
    .all(hariIni) as TopupRow[];
  let dibuat = 0;
  for (const r of rows) {
    const id = createDecision(
      {
        kind: 'konfirmasi_topup',
        topup_plan_id: r.id,
        question:
          `Rencana top-up ${formatIDR(r.plan_amount_minor)} tanggal ${r.plan_date} sudah lewat. ` +
          'Uangnya masuk?',
        options: [
          { id: 'diterima_penuh', label: `Ya, masuk ${formatIDR(r.plan_amount_minor)}` },
          { id: 'diterima_sebagian', label: 'Masuk tapi jumlahnya beda' },
          { id: 'tidak_diterima', label: 'Tidak diterima' },
        ],
        dedupe_key: `topup-lewat:${r.id}`,
        priority: 2,
      },
      database,
    );
    if (id) dibuat += 1;
  }
  return dibuat;
}
