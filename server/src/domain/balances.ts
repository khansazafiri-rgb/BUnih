import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { today, type IsoDate } from './time.js';

export type AccountRow = {
  id: number;
  name: string;
  bank: string;
  last4: string | null;
  kind: string;
  currency: string;
  is_mine: number;
  is_savings_target: number;
  verified: number;
  active: number;
  note: string | null;
};

export type AccountBalance = {
  account_id: number;
  name: string;
  bank: string;
  last4: string | null;
  is_savings_target: boolean;
  /** null = saldo belum dapat diverifikasi (tidak ada titik tambat rekonsiliasi). */
  balance_minor: number | null;
  anchor_at: string | null;
  anchor_source: string | null;
  movement_since_anchor_minor: number;
  event_count_since_anchor: number;
  verified: boolean;
  /** Alasan saldo tidak dapat dipastikan, dalam bahasa manusia. */
  catatan: string[];
};

export type BalanceSummary = {
  as_of: string;
  /** Hanya menjumlahkan rekening yang punya titik tambat rekonsiliasi. */
  total_terverifikasi_minor: number;
  akun_terverifikasi: number;
  akun_belum_terverifikasi: string[];
  /** Transfer antar rekening saya yang baru terlihat satu sisinya. */
  dalam_perjalanan_minor: number;
  dalam_perjalanan_jumlah: number;
  rekening: AccountBalance[];
  lengkap: boolean;
  catatan: string[];
};

export function listAccounts(database: DB = db(), onlyMine = true): AccountRow[] {
  const where = onlyMine ? `WHERE is_mine = 1 AND active = 1` : `WHERE active = 1`;
  return database.prepare(`SELECT * FROM account ${where} ORDER BY id`).all() as AccountRow[];
}

/** Tampilkan rekening tanpa pernah membocorkan nomor penuh. */
export function accountLabel(acc: Pick<AccountRow, 'name' | 'last4'>): string {
  return acc.last4 ? `${acc.name} ••${acc.last4}` : `${acc.name} (4 digit belum dikonfirmasi)`;
}

/**
 * Saldo sebuah rekening pada suatu waktu.
 *
 * Saldo HANYA diklaim bila ada titik tambat (rekonsiliasi dari mutasi/PDF/CSV/input manual).
 * Kumpulan email saja tidak cukup untuk mengklaim saldo bank, jadi tanpa titik tambat
 * nilainya null dan antarmuka menjelaskan alasannya.
 */
export function accountBalance(
  accountId: number,
  asOf: string = `${today()}T23:59:59+07:00`,
  database: DB = db(),
): AccountBalance {
  const acc = database.prepare(`SELECT * FROM account WHERE id = ?`).get(accountId) as
    | AccountRow
    | undefined;
  if (!acc) throw new Error(`Rekening ${accountId} tidak ditemukan`);

  const anchor = database
    .prepare(
      `SELECT * FROM reconciliation WHERE account_id = ? AND as_of <= ?
        ORDER BY as_of DESC, id DESC LIMIT 1`,
    )
    .get(accountId, asOf) as
    | { as_of: string; statement_balance_minor: number; source: string }
    | undefined;

  const catatan: string[] = [];
  const since = anchor?.as_of ?? '0000-01-01T00:00:00+07:00';

  const movement = database
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'masuk' THEN amount_minor ELSE -amount_minor END), 0) AS delta,
         COUNT(*) AS n
       FROM cash_event
       WHERE account_id = ?
         AND status <> 'dibatalkan'
         AND occurred_at > ?
         AND occurred_at <= ?`,
    )
    .get(accountId, since, asOf) as { delta: number; n: number };

  if (!anchor) {
    catatan.push(
      'Belum ada rekonsiliasi untuk rekening ini, jadi saldo tidak dapat dipastikan. ' +
        'Impor mutasi atau masukkan saldo terkonfirmasi di Pengaturan.',
    );
  }
  if (!acc.verified) {
    catatan.push('Rekening ini belum dikonfirmasi (4 digit terakhir belum diisi).');
  }

  return {
    account_id: acc.id,
    name: acc.name,
    bank: acc.bank,
    last4: acc.last4,
    is_savings_target: acc.is_savings_target === 1,
    balance_minor: anchor ? anchor.statement_balance_minor + movement.delta : null,
    anchor_at: anchor?.as_of ?? null,
    anchor_source: anchor?.source ?? null,
    movement_since_anchor_minor: movement.delta,
    event_count_since_anchor: movement.n,
    verified: acc.verified === 1,
    catatan,
  };
}

/** Uang yang sudah keluar dari satu rekening saya tetapi sisi masuknya belum terlihat. */
export function inFlightInternal(
  asOf: string = `${today()}T23:59:59+07:00`,
  database: DB = db(),
): { minor: number; count: number } {
  const row = database
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS minor, COUNT(*) AS count
         FROM cash_event
        WHERE status = 'menunggu_pasangan'
          AND direction = 'keluar'
          AND kind IN ('transfer_internal','setoran_tabungan')
          AND transfer_group_id IS NULL
          AND occurred_at <= ?`,
    )
    .get(asOf) as { minor: number; count: number };
  return { minor: row.minor, count: row.count };
}

export function balanceSummary(
  asOf: string = `${today()}T23:59:59+07:00`,
  database: DB = db(),
): BalanceSummary {
  const accounts = listAccounts(database, true);
  const rekening = accounts.map((a) => accountBalance(a.id, asOf, database));
  const verified = rekening.filter((r) => r.balance_minor !== null);
  const unverified = rekening.filter((r) => r.balance_minor === null);
  const flight = inFlightInternal(asOf, database);

  const catatan: string[] = [];
  if (unverified.length) {
    catatan.push(
      `Saldo ${unverified.map((r) => r.name).join(', ')} belum dapat diverifikasi, ` +
        'jadi angka total di bawah ini belum mencakup rekening tersebut.',
    );
  }
  if (flight.count > 0) {
    catatan.push(
      `${flight.count} transfer antar rekening saya baru terlihat satu sisinya. ` +
        'Uangnya tidak hilang, tetapi belum tampak di rekening tujuan.',
    );
  }

  return {
    as_of: asOf,
    total_terverifikasi_minor: verified.reduce((s, r) => s + (r.balance_minor ?? 0), 0),
    akun_terverifikasi: verified.length,
    akun_belum_terverifikasi: unverified.map((r) => r.name),
    dalam_perjalanan_minor: flight.minor,
    dalam_perjalanan_jumlah: flight.count,
    rekening,
    lengkap: unverified.length === 0 && flight.count === 0,
    catatan,
  };
}

export function recordReconciliation(
  input: {
    account_id: number;
    as_of: string;
    statement_balance_minor: number;
    source: 'manual' | 'csv' | 'pdf' | 'gmail' | 'telegram';
    evidence_id?: number | null;
    note?: string | null;
  },
  database: DB = db(),
): number {
  const res = database
    .prepare(
      `INSERT INTO reconciliation (account_id, as_of, statement_balance_minor, source, evidence_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      input.account_id,
      input.as_of,
      input.statement_balance_minor,
      input.source,
      input.evidence_id ?? null,
      input.note ?? null,
    );
  return Number(res.lastInsertRowid);
}

/** Kapan setiap rekening terakhir direkonsiliasi — indikator kelengkapan data. */
export function reconciliationStatus(database: DB = db()): Array<{
  account_id: number;
  name: string;
  last_reconciled_at: string | null;
  umur_hari: number | null;
}> {
  const rows = listAccounts(database, true).map((a) => {
    const last = database
      .prepare(`SELECT as_of FROM reconciliation WHERE account_id = ? ORDER BY as_of DESC LIMIT 1`)
      .get(a.id) as { as_of: string } | undefined;
    let umur: number | null = null;
    if (last) {
      const d: IsoDate = last.as_of.slice(0, 10);
      const now: IsoDate = today();
      umur = Math.round(
        (Date.parse(`${now}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000,
      );
    }
    return {
      account_id: a.id,
      name: a.name,
      last_reconciled_at: last?.as_of ?? null,
      umur_hari: umur,
    };
  });
  return rows;
}
