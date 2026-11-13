/**
 * Pengiriman notifikasi transaksi baru ke Telegram.
 *
 * Satu transaksi = satu notifikasi (dijamin indeks unik di tg_message). Mengirim ulang untuk transaksi
 * yang sudah pernah dikirim tidak membuat pesan baru, dan tombol hanya merujuk ke id transaksi yang tepat.
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { cancelDecision, markSent, type DecisionRow } from '../domain/decisions.js';
import { getCashEvent } from '../domain/ledger.js';
import { ambilAtauBuatNotifTransaksi, setMessageId } from './state.js';
import { keKeyboard } from './ui/layar.js';
import { layarNotifikasi } from './ui/transaksiUi.js';

export type PengirimPesan = {
  sendMessage: (chatId: string, teks: string, opsi: Record<string, unknown>) => Promise<{ message_id: number }>;
};

export function notifikasiTransaksiAktif(database: DB = db()): boolean {
  const row = database.prepare(`SELECT enabled FROM notification_setting WHERE type = 'transaksi_baru'`).get() as { enabled: number } | undefined;
  return !row || row.enabled === 1;
}

/** Mengembalikan true bila notifikasi (sudah) terkirim untuk keputusan ini. */
export async function kirimNotifikasiTransaksi(
  api: PengirimPesan,
  chatId: string,
  keputusan: DecisionRow,
  database: DB = db(),
): Promise<boolean> {
  const eventId = keputusan.cash_event_id;
  if (!eventId) return false;
  const ev = getCashEvent(eventId, database);
  if (!ev || ev.status === 'dibatalkan') {
    cancelDecision(keputusan.id, 'Transaksi sudah tidak ada atau dibatalkan.', database);
    return false;
  }
  const { row } = ambilAtauBuatNotifTransaksi(chatId, eventId, keputusan.id, database);
  if (row.message_id) {
    // Sudah pernah terkirim (mis. proses sebelumnya berhenti sebelum menandai keputusan).
    markSent(keputusan.id, row.message_id, database);
    return true;
  }
  const layar = layarNotifikasi(row, database);
  const msg = await api.sendMessage(chatId, layar.teks, {
    parse_mode: 'HTML',
    reply_markup: keKeyboard(layar.tombol),
    link_preview_options: { is_disabled: true },
  });
  setMessageId(row.id, msg.message_id, database);
  markSent(keputusan.id, String(msg.message_id), database);
  return true;
}
