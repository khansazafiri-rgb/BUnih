/**
 * Menyambungkan perutean UI (ui/router.ts) ke grammY: perintah, callback, dan teks.
 * Menangani otorisasi (sudah dilakukan penjaga di bot.ts), callback ganda, dan pesan yang tidak bisa disunting.
 */
import type { Bot, Context } from 'grammy';
import { db } from '../db/index.js';
import { ruteCallback, ruteCommand, ruteTeks } from './ui/router.js';
import { keKeyboard, type Hasil, type Konteks, type Layar } from './ui/layar.js';
import { tandaiCallback } from './state.js';

export const NAMA_PERINTAH = ['start', 'mulai', 'menu', 'catat', 'transaksi', 'kategori', 'anggaran', 'target', 'tujuan', 'laporan', 'rekening', 'rencana', 'tagihan', 'pengaturan', 'bantuan', 'help', 'batal'];

function tanpaTag(teks: string): string {
  return teks.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function kirim(ctx: Context, layar: Layar): Promise<void> {
  const opsi = { parse_mode: 'HTML' as const, reply_markup: keKeyboard(layar.tombol), link_preview_options: { is_disabled: true } };
  try {
    await ctx.reply(layar.teks, opsi);
  } catch (err) {
    if (/parse entities/i.test(String((err as Error).message))) {
      await ctx.reply(tanpaTag(layar.teks), { reply_markup: keKeyboard(layar.tombol) });
      return;
    }
    throw err;
  }
}

async function sunting(ctx: Context, layar: Layar): Promise<void> {
  const opsi = { parse_mode: 'HTML' as const, reply_markup: keKeyboard(layar.tombol) ?? { inline_keyboard: [] }, link_preview_options: { is_disabled: true } };
  try {
    await ctx.editMessageText(layar.teks, opsi);
  } catch (err) {
    const pesan = String((err as Error).message);
    if (/message is not modified/i.test(pesan)) return;
    if (/parse entities/i.test(pesan)) {
      await ctx.editMessageText(tanpaTag(layar.teks), { reply_markup: keKeyboard(layar.tombol) ?? { inline_keyboard: [] } });
      return;
    }
    // Pesan terlalu tua atau sudah dihapus: kirim sebagai pesan baru supaya pengguna tidak buntu.
    await kirim(ctx, layar);
  }
}

export async function tampilkan(ctx: Context, hasil: Hasil, dariCallback: boolean): Promise<void> {
  if (dariCallback) {
    await ctx.answerCallbackQuery(hasil.toast ? { text: hasil.toast.slice(0, 190) } : undefined).catch(() => undefined);
    if (hasil.hapusTombol && !hasil.layar) {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    } else if (hasil.layar) {
      if (hasil.baru) await kirim(ctx, hasil.layar);
      else await sunting(ctx, hasil.layar);
    }
  } else if (hasil.layar) {
    await kirim(ctx, hasil.layar);
  }
  for (const p of hasil.pesanBaru ?? []) await kirim(ctx, p);
}

function konteks(ctx: Context): Konteks | null {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return null;
  return { chatId: String(chatId), messageId: ctx.callbackQuery?.message?.message_id };
}

export function pasangUi(b: Bot): void {
  b.command(NAMA_PERINTAH, async (ctx) => {
    const k = konteks(ctx);
    if (!k) return;
    const nama = (ctx.msg?.text ?? '').split(/[\s@]/)[0]!.replace(/^\//, '').toLowerCase();
    const argumen = (ctx.match ?? '').toString();
    try {
      const hasil = ruteCommand(nama, argumen, k, db());
      if (hasil) await tampilkan(ctx, hasil, false);
    } catch (err) {
      console.error('[telegram] perintah gagal:', nama, (err as Error).message);
      await ctx.reply('Maaf, ada yang salah saat memproses perintah itu. Tidak ada data yang diubah.').catch(() => undefined);
    }
  });

  b.on('callback_query:data', async (ctx, next) => {
    const k = konteks(ctx);
    if (!k) return;
    // Callback yang sama (tekan dua kali / dikirim ulang Telegram) diproses sekali saja.
    if (!tandaiCallback(ctx.callbackQuery.id, db())) {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return;
    }
    let hasil: Hasil | null;
    try {
      hasil = ruteCallback(ctx.callbackQuery.data, k, db());
    } catch (err) {
      console.error('[telegram] callback gagal:', ctx.callbackQuery.data.split(':')[0], (err as Error).message);
      await ctx.answerCallbackQuery({ text: 'Maaf, gagal memproses. Tidak ada data yang diubah.' }).catch(() => undefined);
      return;
    }
    if (!hasil) return next(); // callback lama (d:, cat:, x:, kk:, an:)
    await tampilkan(ctx, hasil, true);
  });

  b.on('message:text', async (ctx, next) => {
    const teks = ctx.message.text.trim();
    if (teks.startsWith('/')) return next();
    const k = konteks(ctx);
    if (!k) return;
    let hasil: Hasil | null;
    try {
      hasil = ruteTeks(teks, k, db());
    } catch (err) {
      console.error('[telegram] teks gagal:', (err as Error).message);
      await ctx.reply('Maaf, ada yang salah saat memprosesnya. Tidak ada data yang diubah.').catch(() => undefined);
      return;
    }
    if (!hasil) return next();
    await tampilkan(ctx, { ...hasil, baru: true }, false);
  });
}
