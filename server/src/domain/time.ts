/**
 * Semua logika kalender memakai zona Asia/Jakarta (WIB, UTC+7, tanpa DST).
 * Tanggal sipil disimpan sebagai string "YYYY-MM-DD"; waktu sebagai
 * "YYYY-MM-DDTHH:mm:ss+07:00". Tidak ada ketergantungan pada zona waktu server.
 */

export const JAKARTA_OFFSET_MINUTES = 7 * 60;
export type IsoDate = string; // YYYY-MM-DD
export type IsoInstant = string; // YYYY-MM-DDTHH:mm:ss+07:00

const DAY_MS = 86_400_000;

export function nowJakarta(base: Date = new Date()): Date {
  return new Date(base.getTime() + JAKARTA_OFFSET_MINUTES * 60_000);
}

function pad(n: number, len = 2): string {
  return String(Math.abs(n)).padStart(len, '0');
}

/** Waktu sekarang sebagai instan beroffset Jakarta. */
export function nowIso(base: Date = new Date()): IsoInstant {
  const d = nowJakarta(base);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+07:00`
  );
}

export function today(base: Date = new Date()): IsoDate {
  return nowIso(base).slice(0, 10);
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

function toUtcMidnight(date: IsoDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtcMidnight(ms: number): IsoDate {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMidnight(toUtcMidnight(date) + days * DAY_MS);
}

export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtcMidnight(to) - toUtcMidnight(from)) / DAY_MS);
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}
export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  if (to < from) return [];
  const out: IsoDate[] = [];
  for (let cur = from; cur <= to; cur = addDays(cur, 1)) out.push(cur);
  return out;
}

export function dateOf(instant: string): IsoDate {
  return instant.slice(0, 10);
}

export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: IsoDate): IsoDate {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const nextMonth = m === 12 ? Date.UTC(y + 1, 0, 1) : Date.UTC(y, m, 1);
  return fromUtcMidnight(nextMonth - DAY_MS);
}

export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, lastDay))}`;
}

export function startOfWeek(date: IsoDate): IsoDate {
  // Minggu dimulai hari Senin.
  const dow = new Date(toUtcMidnight(date)).getUTCDay(); // 0 = Minggu
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(date, -back);
}

const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];
const BULAN_SINGKAT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

/** 2026-11-23 -> "23 November 2026" */
export function formatTanggal(date: IsoDate): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${BULAN[m - 1]} ${y}`;
}

/** 2026-11-23 -> "23 Nov" */
export function formatTanggalSingkat(date: IsoDate): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${BULAN_SINGKAT[m - 1]}`;
}

/** 2026-11-23 -> "Senin, 23 November 2026" */
export function formatTanggalHari(date: IsoDate): string {
  const dow = new Date(toUtcMidnight(date)).getUTCDay();
  return `${HARI[dow]}, ${formatTanggal(date)}`;
}

export function namaBulan(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${BULAN[m - 1]} ${y}`;
}

/** Jam:menit dari instan, mis. "14:05". */
export function formatJam(instant: string): string {
  const m = instant.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

/**
 * Ubah instan apa pun (UTC, beroffset, atau tanpa zona) menjadi instan Jakarta.
 * Teks tanpa zona dianggap SUDAH waktu Jakarta.
 */
export function toJakartaInstant(input: string | Date): IsoInstant {
  if (input instanceof Date) return nowIso(input);
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(input);
  if (!hasZone) {
    const cleaned = input.replace(' ', 'T');
    const withSeconds = /T\d{2}:\d{2}$/.test(cleaned) ? `${cleaned}:00` : cleaned;
    return /T/.test(withSeconds) ? `${withSeconds}+07:00` : `${withSeconds}T00:00:00+07:00`;
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Waktu tidak valid: ${input}`);
  return nowIso(parsed);
}

/** Jumlah hari dalam bulan dari tanggal tertentu. */
export function daysInMonth(date: IsoDate): number {
  return diffDays(startOfMonth(date), endOfMonth(date)) + 1;
}

/** Hari Minggu penutup pekan (pekan berjalan Senin-Minggu) yang memuat tanggal ini. */
export function endOfWeek(date: IsoDate): IsoDate {
  return addDays(startOfWeek(date), 6);
}
