import type { Database as DB } from 'better-sqlite3';
import type { IsoDate } from './time.js';
import { analitik, type Insight } from './analytics.js';

/** Insight untuk dashboard memakai perhitungan analitik yang sama persis dengan halaman Analitik. */
export function buildInsightsUntukDashboard(database: DB, hariIni: IsoDate): Insight[] {
  return analitik({ preset: 'bulan_ini' }, database, hariIni).insight;
}
