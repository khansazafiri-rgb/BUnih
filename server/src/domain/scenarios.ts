import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso } from './time.js';

export type ScenarioRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  is_baseline: number;
  enabled_tags: string;
  overrides_json: string;
};

export type ResolvedScenario = {
  slug: string;
  name: string;
  description: string | null;
  is_baseline: boolean;
  enabledTags: Set<string>;
  overrides: Record<string, unknown>;
};

export const SKENARIO_DASAR = 'tanpa-claude-pribadi';

export function listScenarios(database: DB = db()): ScenarioRow[] {
  return database
    .prepare(`SELECT * FROM scenario ORDER BY is_baseline DESC, id`)
    .all() as ScenarioRow[];
}

export function resolveScenario(
  slug: string = SKENARIO_DASAR,
  database: DB = db(),
): ResolvedScenario {
  const row = (database.prepare(`SELECT * FROM scenario WHERE slug = ?`).get(slug) ??
    database.prepare(`SELECT * FROM scenario WHERE is_baseline = 1 LIMIT 1`).get()) as
    | ScenarioRow
    | undefined;
  if (!row) {
    return {
      slug: SKENARIO_DASAR,
      name: 'Skenario dasar',
      description: null,
      is_baseline: true,
      enabledTags: new Set(),
      overrides: {},
    };
  }
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    is_baseline: row.is_baseline === 1,
    enabledTags: new Set(JSON.parse(row.enabled_tags) as string[]),
    overrides: JSON.parse(row.overrides_json) as Record<string, unknown>,
  };
}

export function upsertScenario(
  input: {
    slug: string;
    name: string;
    description?: string | null;
    enabledTags?: string[];
    overrides?: Record<string, unknown>;
  },
  database: DB = db(),
): number {
  const at = nowIso();
  const res = database
    .prepare(
      `INSERT INTO scenario (slug, name, description, is_baseline, enabled_tags, overrides_json, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         enabled_tags = excluded.enabled_tags,
         overrides_json = excluded.overrides_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.slug,
      input.name,
      input.description ?? null,
      JSON.stringify(input.enabledTags ?? []),
      JSON.stringify(input.overrides ?? {}),
      at,
      at,
    );
  const id = Number(res.lastInsertRowid);
  if (id) return id;
  const row = database.prepare(`SELECT id FROM scenario WHERE slug = ?`).get(input.slug) as {
    id: number;
  };
  return row.id;
}

export function deleteScenario(slug: string, database: DB = db()): void {
  database.prepare(`DELETE FROM scenario WHERE slug = ? AND is_baseline = 0`).run(slug);
}
