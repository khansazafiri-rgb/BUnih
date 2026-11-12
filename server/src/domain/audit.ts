import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso } from './time.js';

export type AuditInput = {
  entity: string;
  entity_id: number | null;
  action: string;
  actor: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
};

/** Setiap perubahan data historis wajib meninggalkan jejak di sini. */
export function writeAudit(input: AuditInput, database: DB = db()): void {
  database
    .prepare(
      `INSERT INTO audit_log (entity, entity_id, action, actor, before_json, after_json, reason, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.entity,
      input.entity_id,
      input.action,
      input.actor,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.reason ?? null,
      nowIso(),
    );
}

export function auditFor(entity: string, entityId: number, database: DB = db()) {
  return database
    .prepare(`SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY at DESC, id DESC`)
    .all(entity, entityId);
}
