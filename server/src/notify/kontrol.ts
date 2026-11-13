/**
 * Kendali pengingat: bisukan (mute), tunda (snooze), dan kebijakan peringatan defisit.
 *
 * Masalah yang diperbaiki: kunci deduplikasi lama memuat saldo terendah
 * (`defisit:<tanggal>:<saldo terendah>`), sehingga setiap transaksi baru mengubah angka itu dan
 * memicu peringatan baru dengan tanggal yang sama. Sekarang keputusan kirim dibuat dari kebijakan
 * di bawah, bukan dari angka yang selalu berubah.
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso } from '../domain/time.js';

/* ------------------------------------------------------------------ penyimpanan kecil */

function baca<T>(key: string, database: DB): T | null {
  const row = database.prepare(`SELECT value_json FROM app_setting WHERE key = ?`).get(key) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

function tulis(key: string, value: unknown, database: DB): void {
  database
    .prepare(
      `INSERT INTO app_setting (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), nowIso());
}

/* ------------------------------------------------------------------ mute & tunda */

export const MUTE_HARI = 7;
export const TUNDA_JAM = 6;

/** ISO waktu berakhirnya mute bila masih berlaku, selain itu null. */
export function dapatkanPengaturanMute(type: string, database: DB = db()): string | null {
  const sampai = baca<string>(`mute:${type}`, database);
  return sampai && sampai > new Date().toISOString() ? sampai : null;
}

export function setMute(type: string, sampaiIso: string | null, database: DB = db()): void {
  if (sampaiIso === null) database.prepare(`DELETE FROM app_setting WHERE key = ?`).run(`mute:${type}`);
  else tulis(`mute:${type}`, sampaiIso, database);
}

export function setTunda(type: string, sampaiIso: string | null, database: DB = db()): void {
  if (sampaiIso === null) database.prepare(`DELETE FROM app_setting WHERE key = ?`).run(`tunda:${type}`);
  else tulis(`tunda:${type}`, sampaiIso, database);
}

export function sedangDitahan(type: string, database: DB = db()): boolean {
  const sekarang = new Date().toISOString();
  const tunda = baca<string>(`tunda:${type}`, database);
  return dapatkanPengaturanMute(type, database) !== null || (tunda !== null && tunda > sekarang);
}

/* ------------------------------------------------------------------ kebijakan defisit */

export type SnapshotDefisit = {
  /** Tanggal kalender (zona Jakarta) pengiriman terakhir. */
  hari: string;
  /** Waktu pengiriman terakhir (ISO UTC). */
  at: string;
  jenis: 'defisit' | 'rendah';
  tanggalDefisit: string | null;
  kekurangan_minor: number;
  terverifikasi: boolean;
  /** Berapa kali dikirim pada `hari`. */
  jumlahHariIni: number;
};

export type KondisiDefisit = {
  hari: string;
  jenis: 'defisit' | 'rendah';
  tanggalDefisit: string | null;
  kekurangan_minor: number;
  terverifikasi: boolean;
};

export type Keputusan = { kirim: boolean; alasan: 'pertama' | 'harian' | 'material' | 'eskalasi' | 'tahan' };

const MIN_JEDA_MATERIAL_JAM = 3;
const MAKS_PER_HARI = 3;
const BATAS_NAIK_PERSEN = 25;
const BATAS_NAIK_MINOR = 250_000;
const GESER_TANGGAL_HARI = 3;

function selisihHari(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * Putuskan apakah peringatan defisit/saldo-rendah perlu dikirim.
 *
 *  - Maksimal satu per hari kalender, KECUALI ada perubahan material:
 *      · tingkat naik (saldo rendah → defisit), atau
 *      · kekurangan naik ≥25% dan ≥ Rp250.000, atau
 *      · tanggal defisit maju ≥3 hari,
 *    dengan jeda minimal 3 jam dan maksimal 3 kali sehari.
 *  - Bila saldo dasar belum terverifikasi, angkanya hanyalah perkiraan: tidak ada pengecualian material,
 *    dan pengingat diulang paling cepat tiap 3 hari.
 *  - Perubahan kecil pada nilai proyeksi TIDAK pernah memicu pengiriman baru.
 */
export function putuskanKirimDefisit(sekarang: KondisiDefisit, terakhir: SnapshotDefisit | null, nowMs = Date.now()): Keputusan {
  if (!terakhir) return { kirim: true, alasan: 'pertama' };
  const jamSejak = (nowMs - Date.parse(terakhir.at)) / 3_600_000;
  const hariSejak = selisihHari(sekarang.hari, terakhir.hari);

  if (!sekarang.terverifikasi) {
    return hariSejak >= 3 ? { kirim: true, alasan: 'harian' } : { kirim: false, alasan: 'tahan' };
  }
  if (hariSejak >= 1) return { kirim: true, alasan: 'harian' };

  // Hari yang sama.
  if (terakhir.jumlahHariIni >= MAKS_PER_HARI || jamSejak < MIN_JEDA_MATERIAL_JAM) return { kirim: false, alasan: 'tahan' };
  if (terakhir.jenis === 'rendah' && sekarang.jenis === 'defisit') return { kirim: true, alasan: 'eskalasi' };
  if (!terakhir.terverifikasi) return { kirim: true, alasan: 'eskalasi' };
  const naik = sekarang.kekurangan_minor - terakhir.kekurangan_minor;
  if (terakhir.kekurangan_minor > 0 && naik >= BATAS_NAIK_MINOR && (naik / terakhir.kekurangan_minor) * 100 >= BATAS_NAIK_PERSEN) {
    return { kirim: true, alasan: 'material' };
  }
  if (sekarang.tanggalDefisit && terakhir.tanggalDefisit && selisihHari(terakhir.tanggalDefisit, sekarang.tanggalDefisit) >= GESER_TANGGAL_HARI) {
    return { kirim: true, alasan: 'material' };
  }
  return { kirim: false, alasan: 'tahan' };
}

export function ambilSnapshotDefisit(database: DB = db()): SnapshotDefisit | null {
  return baca<SnapshotDefisit>('notif:defisit', database);
}

export function catatSnapshotDefisit(k: KondisiDefisit, database: DB = db()): void {
  const lama = ambilSnapshotDefisit(database);
  tulis(
    'notif:defisit',
    {
      hari: k.hari,
      at: new Date().toISOString(),
      jenis: k.jenis,
      tanggalDefisit: k.tanggalDefisit,
      kekurangan_minor: k.kekurangan_minor,
      terverifikasi: k.terverifikasi,
      jumlahHariIni: lama && lama.hari === k.hari ? lama.jumlahHariIni + 1 : 1,
    } satisfies SnapshotDefisit,
    database,
  );
}
