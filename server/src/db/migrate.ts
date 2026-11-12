import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import type { Database as DB } from 'better-sqlite3';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** Direktori migrasi; saat dijalankan dari dist, file .sql ikut dikopi oleh skrip build. */
export function migrationsDir(): string {
  const candidates = [
    path.join(here, 'migrations'),
    path.join(here, '..', '..', 'src', 'db', 'migrations'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Direktori migrasi tidak ditemukan');
}

export function migrate(database: DB, dir = migrationsDir()): string[] {
  database.exec(`CREATE TABLE IF NOT EXISTS _migration (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    database
      .prepare(`SELECT name FROM _migration`)
      .all()
      .map((r) => (r as { name: string }).name),
  );
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const run: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const apply = database.transaction(() => {
      database.exec(sql);
      database
        .prepare(`INSERT INTO _migration (name, applied_at) VALUES (?, ?)`)
        .run(file, new Date().toISOString());
    });
    apply();
    run.push(file);
  }
  return run;
}
