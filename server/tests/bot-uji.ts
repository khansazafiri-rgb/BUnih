/**
 * Harness pengujian bot Telegram: bot grammY sungguhan, tetapi semua panggilan API Telegram
 * ditangkap oleh transformer palsu (tanpa jaringan). Update dikirim lewat bot.handleUpdate().
 */
import type { Bot } from 'grammy';
import { buatBot } from '../src/telegram/bot.js';

export const CHAT = 1001; // sama dengan TELEGRAM_ALLOWED_CHAT_ID di vitest.config.ts
export const ASING = 999;

export type Panggilan = { method: string; payload: Record<string, any> };

export type BotUji = {
  bot: Bot;
  keluar: Panggilan[];
  kirimTeks: (teks: string, chat?: number) => Promise<void>;
  tekan: (data: string, opsi?: { pesan?: number; chat?: number; id?: string }) => Promise<void>;
  /** Pesan yang dikirim/disunting setelah indeks tertentu. */
  sejak: (n: number) => Panggilan[];
  terakhirTeks: () => string;
  terakhirTombol: () => string[];
  terakhirTombolLabel: () => string[];
};

let seq = 1;

export function pasangBot(): BotUji {
  const keluar: Panggilan[] = [];
  let pesanId = 500;
  const bot = buatBot('123456:TEST', {
    id: 123456, is_bot: true, first_name: 'BUnih', username: 'bunih_uji_bot',
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false,
  } as never);
  bot.api.config.use(async (_prev, method, payload) => {
    keluar.push({ method, payload: payload as Record<string, any> });
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: ++pesanId, date: 0, chat: { id: (payload as any).chat_id, type: 'private' }, text: (payload as any).text } } as never;
    }
    if (method === 'editMessageText') {
      return { ok: true, result: { message_id: (payload as any).message_id ?? pesanId, date: 0, chat: { id: (payload as any).chat_id, type: 'private' }, text: (payload as any).text } } as never;
    }
    return { ok: true, result: true } as never;
  });

  const dari = (chat: number) => ({ id: chat, is_bot: false, first_name: 'Uji' });
  const tombolRata = (p: Panggilan | undefined): any[] =>
    ((p?.payload['reply_markup']?.inline_keyboard ?? []) as any[][]).flat();

  return {
    bot,
    keluar,
    async kirimTeks(teks, chat = CHAT) {
      const perintah = teks.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: teks.split(/\s/)[0]!.length }] : undefined;
      await bot.handleUpdate({
        update_id: ++seq,
        message: { message_id: ++seq, date: 0, chat: { id: chat, type: 'private', first_name: 'Uji' }, from: dari(chat), text: teks, entities: perintah },
      } as never);
    },
    async tekan(data, opsi = {}) {
      const chat = opsi.chat ?? CHAT;
      await bot.handleUpdate({
        update_id: ++seq,
        callback_query: {
          id: opsi.id ?? `cb-${++seq}`,
          from: dari(chat),
          chat_instance: 'uji',
          data,
          message: { message_id: opsi.pesan ?? 501, date: 0, chat: { id: chat, type: 'private', first_name: 'Uji' }, text: 'x' },
        },
      } as never);
    },
    sejak: (n) => keluar.slice(n),
    terakhirTeks: () => String([...keluar].reverse().find((k) => k.method === 'sendMessage' || k.method === 'editMessageText')?.payload['text'] ?? ''),
    terakhirTombol: () => tombolRata([...keluar].reverse().find((k) => k.method === 'sendMessage' || k.method === 'editMessageText')).map((b) => String(b.callback_data ?? b.url)),
    terakhirTombolLabel: () => tombolRata([...keluar].reverse().find((k) => k.method === 'sendMessage' || k.method === 'editMessageText')).map((b) => String(b.text)),
  };
}
