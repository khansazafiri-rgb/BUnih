import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { config } from '../config.js';

let instance: DB | null = null;

export function openDatabase(file?: string): DB {
  const db = new Database(file ?? config.dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function db(): DB {
  if (!instance) instance = openDatabase();
  return instance;
}

export function setDatabase(next: DB): void {
  instance = next;
}

export function closeDatabase(): void {
  instance?.close();
  instance = null;
}

/** Jalankan fn di dalam satu transaksi. Semua tulis-menulis domain memakai ini. */
export function tx<T>(fn: (database: DB) => T, database: DB = db()): T {
  const run = database.transaction(fn as (d: DB) => T);
  return run(database);
}
