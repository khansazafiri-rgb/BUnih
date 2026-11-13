import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso } from './time.js';

/** Cari atau buat orang. Company adalah satu entitas; teman dicocokkan menurut nama tanpa membedakan huruf besar-kecil. */
export function ensurePerson(
  kind: 'company' | 'teman',
  nama: string | null,
  database: DB = db(),
): number | null {
  if (kind === 'company') {
    const row = database.prepare(`SELECT id FROM person WHERE kind = 'company' LIMIT 1`).get() as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }
  if (!nama) return null;
  const existing = database
    .prepare(`SELECT id FROM person WHERE kind = 'teman' AND lower(name) = lower(?)`)
    .get(nama.trim()) as { id: number } | undefined;
  if (existing) return existing.id;
  const res = database
    .prepare(`INSERT INTO person (kind, name, note, created_at) VALUES ('teman', ?, NULL, ?)`)
    .run(nama.trim(), nowIso());
  return Number(res.lastInsertRowid);
}
