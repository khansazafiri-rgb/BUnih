import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { setDatabase } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { recordReconciliation } from '../src/domain/balances.js';
import { setAssumption } from '../src/domain/assumptions.js';
import { addDays, today } from '../src/domain/time.js';

/** Database bersih di memori untuk setiap pengujian. */
export function dbUji(): DB {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  migrate(database);
  seed(database);
  setDatabase(database);
  return database;
}

export function akun(database: DB, nama: string): number {
  const row = database.prepare(`SELECT id FROM account WHERE name LIKE ?`).get(`%${nama}%`) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`Rekening ${nama} tidak ada`);
  return row.id;
}

export function kategori(database: DB, slug: string): number {
  const row = database.prepare(`SELECT id FROM category WHERE slug = ?`).get(slug) as { id: number };
  return row.id;
}

/** Pasang titik tambat saldo supaya saldo dapat diverifikasi. */
export function pasangSaldo(database: DB, nama: string, minor: number, offsetHari = -30): void {
  recordReconciliation(
    {
      account_id: akun(database, nama),
      as_of: `${addDays(today(), offsetHari)}T23:59:59+07:00`,
      statement_balance_minor: minor,
      source: 'manual',
      note: 'uji',
    },
    database,
  );
}

export function pasangPeriode(database: DB, mulaiOffset = -10): void {
  setAssumption(
    'periode_mulai',
    addDays(today(), mulaiOffset),
    { effectiveFrom: '1970-01-01', certainty: 'terverifikasi', source: 'manual', actor: 'uji' },
    database,
  );
}

/** Jumlah alokasi untuk satu transaksi, dikelompokkan menurut tujuan. */
export function alokasiPer(database: DB, cashEventId: number): Record<string, number> {
  const rows = database
    .prepare(`SELECT purpose, SUM(amount_minor) AS total FROM allocation WHERE cash_event_id = ? GROUP BY purpose`)
    .all(cashEventId) as Array<{ purpose: string; total: number }>;
  return Object.fromEntries(rows.map((r) => [r.purpose, r.total]));
}

export function jumlahTransaksi(database: DB): number {
  return (database.prepare(`SELECT COUNT(*) AS n FROM cash_event`).get() as { n: number }).n;
}
