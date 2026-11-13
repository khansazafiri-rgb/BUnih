/**
 * Status percakapan Telegram yang disimpan di SQLite supaya bertahan setelah restart,
 * plus pencatat callback untuk mencegah pemrosesan ganda.
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso } from '../domain/time.js';

const TTL_MENIT = 45;

function kedaluwarsa(menit: number): string {
  return new Date(Date.now() + menit * 60_000).toISOString();
}

/** Status percakapan. `t` adalah penanda alur; isi lainnya bebas per alur. */
export type TgState = { t: string; [kunci: string]: unknown };

export function getState<T extends TgState = TgState>(chatId: string, slot = 'utama', database: DB = db()): T | null {
  const row = database
    .prepare(`SELECT state_json, expires_at FROM tg_state WHERE chat_id = ? AND slot = ?`)
    .get(chatId, slot) as { state_json: string; expires_at: string } | undefined;
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    clearState(chatId, slot, database);
    return null;
  }
  try {
    return JSON.parse(row.state_json) as T;
  } catch {
    clearState(chatId, slot, database);
    return null;
  }
}

export function setState(chatId: string, state: TgState, slot = 'utama', ttlMenit = TTL_MENIT, database: DB = db()): void {
  database
    .prepare(
      `INSERT INTO tg_state (chat_id, slot, state_json, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, slot) DO UPDATE SET state_json = excluded.state_json,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    )
    .run(chatId, slot, JSON.stringify(state), kedaluwarsa(ttlMenit), nowIso());
}

export function clearState(chatId: string, slot = 'utama', database: DB = db()): void {
  database.prepare(`DELETE FROM tg_state WHERE chat_id = ? AND slot = ?`).run(chatId, slot);
}

/**
 * Tandai callback sebagai sudah dilihat. Mengembalikan false bila id yang sama sudah pernah diproses
 * (tekan dua kali, atau Telegram mengirim ulang update).
 */
export function tandaiCallback(callbackId: string, database: DB = db()): boolean {
  const res = database
    .prepare(`INSERT OR IGNORE INTO tg_callback_seen (callback_id, seen_at) VALUES (?, ?)`)
    .run(callbackId, new Date().toISOString());
  if (res.changes === 0) return false;
  // Bersihkan catatan lama agar tabel tidak membengkak.
  if (Math.random() < 0.02) {
    database
      .prepare(`DELETE FROM tg_callback_seen WHERE seen_at < ?`)
      .run(new Date(Date.now() - 3 * 86_400_000).toISOString());
  }
  return true;
}

/* ------------------------------------------------------------------ pesan interaktif */

export type TgMessageRow = {
  id: number;
  chat_id: string;
  message_id: string | null;
  kind: string;
  cash_event_id: number | null;
  decision_id: number | null;
  state: 'aktif' | 'selesai' | 'kedaluwarsa';
  outcome: string | null;
  created_at: string;
  resolved_at: string | null;
};

export function getTgMessage(id: number, database: DB = db()): TgMessageRow | undefined {
  return database.prepare(`SELECT * FROM tg_message WHERE id = ?`).get(id) as TgMessageRow | undefined;
}

/** Notifikasi transaksi: satu baris per transaksi (dijamin indeks unik). Idempoten. */
export function ambilAtauBuatNotifTransaksi(
  chatId: string,
  cashEventId: number,
  decisionId: number | null,
  database: DB = db(),
): { row: TgMessageRow; baru: boolean } {
  const ada = database
    .prepare(`SELECT * FROM tg_message WHERE kind = 'transaksi' AND cash_event_id = ?`)
    .get(cashEventId) as TgMessageRow | undefined;
  if (ada) return { row: ada, baru: false };
  const res = database
    .prepare(
      `INSERT INTO tg_message (chat_id, kind, cash_event_id, decision_id, state, created_at) VALUES (?, 'transaksi', ?, ?, 'aktif', ?)`,
    )
    .run(chatId, cashEventId, decisionId, nowIso());
  return { row: getTgMessage(Number(res.lastInsertRowid), database)!, baru: true };
}

export function setMessageId(id: number, messageId: string | number, database: DB = db()): void {
  database.prepare(`UPDATE tg_message SET message_id = ? WHERE id = ?`).run(String(messageId), id);
}

/** Tutup pesan interaktif. Mengembalikan false bila sudah ditutup sebelumnya (callback ganda). */
export function selesaikanPesan(id: number, outcome: string, database: DB = db()): boolean {
  const res = database
    .prepare(`UPDATE tg_message SET state = 'selesai', outcome = ?, resolved_at = ? WHERE id = ? AND state = 'aktif'`)
    .run(outcome, nowIso(), id);
  return res.changes > 0;
}
