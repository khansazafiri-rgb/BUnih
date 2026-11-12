import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso } from './time.js';
import { writeAudit } from './audit.js';

export type DecisionKind =
  | 'kategori_transaksi'
  | 'jenis_pembelian'
  | 'bagi_biaya'
  | 'reimburse'
  | 'pasangan_transfer'
  | 'konfirmasi_topup'
  | 'verifikasi_langganan'
  | 'harga_belanja'
  | 'konfirmasi_kuitansi'
  | 'asumsi_awal';

export type DecisionOption = {
  id: string;
  label: string;
  /** Data tambahan yang dipakai saat jawaban diterapkan. */
  payload?: Record<string, unknown>;
};

export type DecisionInput = {
  kind: DecisionKind;
  question: string;
  options?: DecisionOption[];
  dedupe_key: string;
  cash_event_id?: number | null;
  invoice_id?: number | null;
  service_id?: number | null;
  topup_plan_id?: number | null;
  purchase_id?: number | null;
  priority?: number;
};

export type DecisionRow = {
  id: number;
  kind: DecisionKind;
  cash_event_id: number | null;
  invoice_id: number | null;
  service_id: number | null;
  topup_plan_id: number | null;
  purchase_id: number | null;
  question: string;
  options_json: string;
  state: 'terbuka' | 'terkirim' | 'dijawab' | 'kedaluwarsa' | 'dibatalkan';
  priority: number;
  telegram_message_id: string | null;
  answer_json: string | null;
  dedupe_key: string;
  created_at: string;
  sent_at: string | null;
  answered_at: string | null;
};

/** Idempoten: pertanyaan yang sama tidak dibuat dua kali. */
export function createDecision(input: DecisionInput, database: DB = db()): number | null {
  const res = database
    .prepare(
      `INSERT OR IGNORE INTO pending_decision
        (kind, cash_event_id, invoice_id, service_id, topup_plan_id, purchase_id,
         question, options_json, state, priority, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'terbuka', ?, ?, ?)`,
    )
    .run(
      input.kind,
      input.cash_event_id ?? null,
      input.invoice_id ?? null,
      input.service_id ?? null,
      input.topup_plan_id ?? null,
      input.purchase_id ?? null,
      input.question,
      JSON.stringify(input.options ?? []),
      input.priority ?? 5,
      input.dedupe_key,
      nowIso(),
    );
  return res.changes ? Number(res.lastInsertRowid) : null;
}

export function listDecisions(
  opts: { state?: DecisionRow['state']; limit?: number } = {},
  database: DB = db(),
): DecisionRow[] {
  const state = opts.state;
  const limit = opts.limit ?? 50;
  if (state) {
    return database
      .prepare(
        `SELECT * FROM pending_decision WHERE state = ? ORDER BY priority, created_at LIMIT ?`,
      )
      .all(state, limit) as DecisionRow[];
  }
  return database
    .prepare(
      `SELECT * FROM pending_decision WHERE state IN ('terbuka','terkirim')
        ORDER BY priority, created_at LIMIT ?`,
    )
    .all(limit) as DecisionRow[];
}

export function countOpenDecisions(database: DB = db()): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS n FROM pending_decision WHERE state IN ('terbuka','terkirim')`)
    .get() as { n: number };
  return row.n;
}

export function getDecision(id: number, database: DB = db()): DecisionRow | undefined {
  return database.prepare(`SELECT * FROM pending_decision WHERE id = ?`).get(id) as
    | DecisionRow
    | undefined;
}

export function markSent(id: number, telegramMessageId: string, database: DB = db()): void {
  database
    .prepare(
      `UPDATE pending_decision SET state = 'terkirim', sent_at = ?, telegram_message_id = ?
        WHERE id = ? AND state = 'terbuka'`,
    )
    .run(nowIso(), telegramMessageId, id);
}

export function answerDecision(
  id: number,
  answer: unknown,
  actor = 'telegram',
  database: DB = db(),
): void {
  const before = getDecision(id, database);
  if (!before) throw new Error(`Keputusan ${id} tidak ditemukan.`);
  database
    .prepare(
      `UPDATE pending_decision SET state = 'dijawab', answer_json = ?, answered_at = ? WHERE id = ?`,
    )
    .run(JSON.stringify(answer), nowIso(), id);
  writeAudit(
    {
      entity: 'pending_decision',
      entity_id: id,
      action: 'dijawab',
      actor,
      before: { state: before.state },
      after: { answer },
    },
    database,
  );
}

export function cancelDecision(id: number, reason: string, database: DB = db()): void {
  database
    .prepare(`UPDATE pending_decision SET state = 'dibatalkan', answered_at = ? WHERE id = ?`)
    .run(nowIso(), id);
  writeAudit(
    { entity: 'pending_decision', entity_id: id, action: 'dibatalkan', actor: 'sistem', reason },
    database,
  );
}

/** Tutup pertanyaan yang sudah tidak relevan untuk sebuah transaksi. */
export function closeDecisionsFor(
  ref: { cash_event_id?: number; invoice_id?: number; topup_plan_id?: number },
  reason: string,
  database: DB = db(),
): void {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (ref.cash_event_id) {
    clauses.push('cash_event_id = ?');
    params.push(ref.cash_event_id);
  }
  if (ref.invoice_id) {
    clauses.push('invoice_id = ?');
    params.push(ref.invoice_id);
  }
  if (ref.topup_plan_id) {
    clauses.push('topup_plan_id = ?');
    params.push(ref.topup_plan_id);
  }
  if (!clauses.length) return;
  const rows = database
    .prepare(
      `SELECT id FROM pending_decision WHERE (${clauses.join(' OR ')}) AND state IN ('terbuka','terkirim')`,
    )
    .all(...params) as Array<{ id: number }>;
  for (const r of rows) cancelDecision(r.id, reason, database);
}
