import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso, today, type IsoDate } from './time.js';
import type { Certainty } from './types.js';
import { writeAudit } from './audit.js';

export type AssumptionRow = {
  id: number;
  key: string;
  value_json: string;
  effective_from: string;
  effective_to: string | null;
  certainty: Certainty;
  source: string;
  note: string | null;
};

export type ResolvedAssumption<T = unknown> = {
  key: string;
  value: T;
  certainty: Certainty;
  source: string;
  effective_from: IsoDate;
  note: string | null;
};

/**
 * Nilai asumsi yang berlaku pada tanggal tertentu.
 * Laporan historis memakai asumsi yang berlaku saat itu, sehingga mengubah
 * asumsi hari ini tidak diam-diam menulis ulang masa lalu.
 */
export function assumptionAt<T = unknown>(
  key: string,
  at: IsoDate = today(),
  database: DB = db(),
): ResolvedAssumption<T> | null {
  const row = database
    .prepare(
      `SELECT * FROM assumption
        WHERE key = ?
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from DESC, id DESC
        LIMIT 1`,
    )
    .get(key, at, at) as AssumptionRow | undefined;
  if (!row) return null;
  return {
    key: row.key,
    value: JSON.parse(row.value_json) as T,
    certainty: row.certainty,
    source: row.source,
    effective_from: row.effective_from,
    note: row.note,
  };
}

export function numberAssumption(
  key: string,
  fallback: number,
  at: IsoDate = today(),
  database: DB = db(),
): { value: number; certainty: Certainty; found: boolean } {
  const resolved = assumptionAt<number>(key, at, database);
  if (!resolved || typeof resolved.value !== 'number') {
    return { value: fallback, certainty: 'perkiraan', found: false };
  }
  return { value: resolved.value, certainty: resolved.certainty, found: true };
}

/**
 * Tetapkan nilai baru mulai `effectiveFrom`. Versi lama ditutup, tidak dihapus,
 * sehingga riwayat perubahan asumsi tetap utuh.
 */
export function setAssumption(
  key: string,
  value: unknown,
  opts: {
    effectiveFrom?: IsoDate;
    certainty?: Certainty;
    source?: 'sheet' | 'manual' | 'gmail' | 'kalkulasi' | 'bawaan';
    note?: string | null;
    actor?: string;
  } = {},
  database: DB = db(),
): number {
  const effectiveFrom = opts.effectiveFrom ?? today();
  const certainty = opts.certainty ?? 'terverifikasi';
  const source = opts.source ?? 'manual';
  const at = nowIso();

  const run = database.transaction(() => {
    const previous = database
      .prepare(
        `SELECT * FROM assumption
          WHERE key = ? AND (effective_to IS NULL OR effective_to >= ?)
          ORDER BY effective_from DESC, id DESC LIMIT 1`,
      )
      .get(key, effectiveFrom) as AssumptionRow | undefined;

    if (previous) {
      // Tutup versi sebelumnya sehari sebelum versi baru berlaku.
      const closeAt = effectiveFrom;
      database
        .prepare(
          `UPDATE assumption SET effective_to = date(?, '-1 day') WHERE id = ? AND (effective_to IS NULL OR effective_to >= ?)`,
        )
        .run(closeAt, previous.id, closeAt);
    }

    const res = database
      .prepare(
        `INSERT INTO assumption (key, value_json, effective_from, effective_to, certainty, source, note, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(key, JSON.stringify(value), effectiveFrom, certainty, source, opts.note ?? null, at);

    const id = Number(res.lastInsertRowid);
    writeAudit(
      {
        entity: 'assumption',
        entity_id: id,
        action: 'set',
        actor: opts.actor ?? 'web',
        before: previous ? { value: JSON.parse(previous.value_json), certainty: previous.certainty } : null,
        after: { key, value, certainty, effective_from: effectiveFrom },
        reason: opts.note ?? null,
      },
      database,
    );
    return id;
  });
  return run();
}

export function assumptionHistory(key: string, database: DB = db()): AssumptionRow[] {
  return database
    .prepare(`SELECT * FROM assumption WHERE key = ? ORDER BY effective_from DESC, id DESC`)
    .all(key) as AssumptionRow[];
}

export function allCurrentAssumptions(
  at: IsoDate = today(),
  database: DB = db(),
): ResolvedAssumption[] {
  const keys = database
    .prepare(`SELECT DISTINCT key FROM assumption ORDER BY key`)
    .all()
    .map((r) => (r as { key: string }).key);
  const out: ResolvedAssumption[] = [];
  for (const key of keys) {
    const resolved = assumptionAt(key, at, database);
    if (resolved) out.push(resolved);
  }
  return out;
}
