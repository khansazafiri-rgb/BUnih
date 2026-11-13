import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { Database as DB } from 'better-sqlite3';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { formatIDR } from '../domain/money.js';
import { addDays, dateOf, formatTanggalSingkat, nowIso, today } from '../domain/time.js';
import { recordCashEvent } from '../domain/ledger.js';
import { simulasiPembelian } from '../domain/simulate.js';
import {
  applyDecision, bagiBiaya, jadikanCompanyLangsung, jadikanHadiah, jadikanReimburseCompany,
  jadikanTalangan, jadikanTransferSendiri, type Lanjutan,
} from '../domain/applyDecision.js';
import { listDecisions, markSent, type DecisionRow } from '../domain/decisions.js';
import { setTopupStatus } from '../domain/topup.js';
import { detectIntent, parseRupiah } from './nlu.js';
import {
  bandingSkenario, bantuan, daftarTagihan, esc, hasilSimulasi, ringkasan5Hari, ringkasanAnggaran,
  ringkasanBulan, ringkasanHari, ringkasanMinggu, ringkasanReimburse, ringkasanTabungan,
} from './format.js';

type Percakapan =
  | { tipe: 'input_bagi_biaya'; cash_event_id: number; nominal_minor: number }
  | { tipe: 'input_nominal'; topup_plan_id: number }
  | { tipe: 'input_belanja' }
  | { tipe: 'konfirmasi_foto'; evidence_id: number };

const percakapan = new Map<string, Percakapan>();
let bot: Bot | null = null;

export function getBot(): Bot | null {
  return bot;
}

function allowedChatId(): string | null {
  return config.TELEGRAM_ALLOWED_CHAT_ID ? config.TELEGRAM_ALLOWED_CHAT_ID.trim() : null;
}

/** Bot hanya merespons akun Telegram yang sudah diverifikasi. */
function isAllowed(ctx: Context): boolean {
  const allowed = allowedChatId();
  const chatId = ctx.chat?.id;
  if (!allowed || chatId === undefined) return false;
  return String(chatId) === allowed;
}

function keyboardDariOpsi(decision: DecisionRow): InlineKeyboard {
  const kb = new InlineKeyboard();
  const opsi = JSON.parse(decision.options_json) as Array<{ id: string; label: string }>;
  opsi.forEach((o, i) => {
    kb.text(o.label, `d:${decision.id}:${o.id}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  return kb;
}

function kategoriKeyboard(cashEventId: number, database: DB): InlineKeyboard {
  const rows = database
    .prepare(`SELECT id, name FROM category ORDER BY group_name, name`)
    .all() as Array<{ id: number; name: string }>;
  const kb = new InlineKeyboard();
  rows.forEach((r, i) => {
    kb.text(r.name, `cat:${cashEventId}:${r.id}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  return kb;
}

function opsiBebasKeyboard(cashEventId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('Talangan', `x:${cashEventId}:talangan`)
    .text('Company bayar langsung', `x:${cashEventId}:company_langsung`)
    .row()
    .text('Setoran tabungan', `x:${cashEventId}:setoran`)
    .text('Reimburse company', `x:${cashEventId}:reimburse`);
}

async function balasLanjutan(ctx: Context, pesan: string, lanjutan: Lanjutan | undefined, database: DB) {
  if (!lanjutan) {
    await ctx.reply(pesan, { parse_mode: 'HTML' });
    return;
  }
  const chatKey = String(ctx.chat?.id ?? '');
  switch (lanjutan.tipe) {
    case 'pilih_kategori':
      await ctx.reply(pesan, { reply_markup: kategoriKeyboard(lanjutan.cash_event_id, database) });
      break;
    case 'input_bagi_biaya':
      percakapan.set(chatKey, lanjutan);
      await ctx.reply(pesan, { parse_mode: 'HTML' });
      break;
    case 'input_nominal':
      percakapan.set(chatKey, lanjutan);
      await ctx.reply(pesan, { parse_mode: 'HTML' });
      break;
    case 'pilih_opsi_bebas':
      await ctx.reply(pesan, { reply_markup: opsiBebasKeyboard(lanjutan.cash_event_id) });
      break;
  }
}

/** Kirim pertanyaan yang masih terbuka ke Telegram, satu kali saja per pertanyaan. */
export async function sendPendingDecisions(limit = 5, database: DB = db()): Promise<number> {
  const b = bot;
  const chatId = allowedChatId();
  if (!b || !chatId) return 0;
  const daftar = listDecisions({ state: 'terbuka', limit }, database);
  let terkirim = 0;
  for (const d of daftar) {
    try {
      const msg = await b.api.sendMessage(chatId, `❓ ${esc(d.question)}`, {
        parse_mode: 'HTML',
        reply_markup: keyboardDariOpsi(d),
      });
      markSent(d.id, String(msg.message_id), database);
      terkirim += 1;
    } catch {
      // Jangan hentikan antrean karena satu pesan gagal.
    }
  }
  return terkirim;
}

export async function kirimPesan(text: string, database: DB = db()): Promise<boolean> {
  const b = bot;
  const chatId = allowedChatId();
  if (!b || !chatId) return false;
  try {
    await b.api.sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    return true;
  } catch {
    return false;
  }
}

function catatPengeluaranCepat(
  nominal: number,
  kategoriSlug: string | null,
  label: string,
  tanggalRelatif: 'hari_ini' | 'kemarin' | null,
  database: DB,
): { id: number; pesan: string } {
  const akun = database
    .prepare(`SELECT id, name FROM account WHERE is_mine = 1 AND is_savings_target = 0 ORDER BY id LIMIT 1`)
    .get() as { id: number; name: string } | undefined;
  const kategori = kategoriSlug
    ? (database.prepare(`SELECT id FROM category WHERE slug = ?`).get(kategoriSlug) as
        | { id: number }
        | undefined)
    : undefined;
  const tanggal = tanggalRelatif === 'kemarin' ? addDays(today(), -1) : today();

  const res = recordCashEvent(
    {
      occurred_at: `${tanggal}T${nowIso().slice(11, 19)}+07:00`,
      direction: 'keluar',
      amount_minor: nominal,
      account_id: akun?.id ?? null,
      is_cash: !akun,
      kind: 'pengeluaran_pribadi',
      merchant_raw: label || null,
      category_id: kategori?.id ?? null,
      source: 'telegram',
      note: 'Dicatat manual lewat Telegram.',
      actor: 'telegram',
    },
    database,
  );
  return {
    id: res.id,
    pesan:
      `Dicatat: ${formatIDR(nominal)}${label ? ` — ${label}` : ''} pada ${formatTanggalSingkat(tanggal)}` +
      `${akun ? ` dari ${akun.name}` : ' (tunai)'}.`,
  };
}

export function createBot(): Bot | null {
  if (config.TELEGRAM_MODE === 'off' || !config.TELEGRAM_BOT_TOKEN) return null;
  const b = new Bot(config.TELEGRAM_BOT_TOKEN);

  // ---- Penjaga akses --------------------------------------------------
  b.use(async (ctx, next) => {
    if (!allowedChatId()) {
      if (ctx.chat?.id) {
        await ctx.reply(
          'Bot ini belum dipasangkan ke akun mana pun.\n\n' +
            `Chat ID kamu: <code>${ctx.chat.id}</code>\n` +
            'Masukkan nilai itu ke TELEGRAM_ALLOWED_CHAT_ID di .env server, lalu mulai ulang bot.',
          { parse_mode: 'HTML' },
        );
      }
      return;
    }
    if (!isAllowed(ctx)) return; // diam saja untuk akun lain
    await next();
  });

  // ---- Perintah -------------------------------------------------------
  b.command(['start', 'mulai'], async (ctx) => {
    await ctx.reply(
      'Halo. Aku BUnih, pencatat keuangan pribadimu.\n\n' +
        'Kirim /hari untuk posisi hari ini, atau /bantuan untuk daftar kemampuan.',
    );
  });
  b.command(['bantuan', 'help'], (ctx) => ctx.reply(bantuan(), { parse_mode: 'HTML' }));
  b.command('hari', (ctx) => ctx.reply(ringkasanHari(db()), { parse_mode: 'HTML' }));
  b.command('minggu', (ctx) => ctx.reply(ringkasanMinggu(db()), { parse_mode: 'HTML' }));
  b.command('bulan', (ctx) => ctx.reply(ringkasanBulan(undefined, db()), { parse_mode: 'HTML' }));
  b.command(['5hari', 'lima'], (ctx) => ctx.reply(ringkasan5Hari(db()), { parse_mode: 'HTML' }));
  b.command('tagihan', (ctx) => ctx.reply(daftarTagihan(30, db()), { parse_mode: 'HTML' }));
  b.command('anggaran', (ctx) => ctx.reply(ringkasanAnggaran(db()), { parse_mode: 'HTML' }));
  b.command('tabungan', (ctx) => ctx.reply(ringkasanTabungan(db()), { parse_mode: 'HTML' }));
  b.command('reimburse', (ctx) => ctx.reply(ringkasanReimburse(db()), { parse_mode: 'HTML' }));
  b.command('skenario', (ctx) => ctx.reply(bandingSkenario(db()), { parse_mode: 'HTML' }));

  b.command('belanja', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (!arg) {
      percakapan.set(String(ctx.chat.id), { tipe: 'input_belanja' });
      await ctx.reply(
        'Tulis belanjanya, misalnya:\n' +
          '• "keyboard 350rb"\n' +
          '• "monitor harga belum tahu"\n' +
          '• "kabel 2 x 25rb"',
      );
      return;
    }
    await tanganiBelanja(ctx, arg);
  });

  b.command('simulasi', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    const nominal = arg ? parseRupiah(arg) : null;
    if (!arg) {
      await ctx.reply(
        'Tulis rencana pembeliannya, misalnya /simulasi hp 3 juta — atau "kalau aku beli hp 3 juta hari ini gimana?".',
      );
      return;
    }
    const label = arg.replace(/[\d.,]+\s*(jt|juta|rb|ribu|k)?/gi, '').trim() || 'pembelian';
    const hasil = simulasiPembelian({ label, harga_minor: nominal, jenis: 'pribadi', bisa_ditunda: true }, db());
    await ctx.reply(hasilSimulasi(hasil), { parse_mode: 'HTML' });
  });

  b.command('koreksi', async (ctx) => {
    const rows = db()
      .prepare(
        `SELECT ce.id, ce.occurred_at, ce.direction, ce.amount_minor, ce.merchant_raw, ce.kind
           FROM cash_event ce WHERE ce.status <> 'dibatalkan'
          ORDER BY ce.occurred_at DESC, ce.id DESC LIMIT 10`,
      )
      .all() as Array<{
      id: number;
      occurred_at: string;
      direction: string;
      amount_minor: number;
      merchant_raw: string | null;
      kind: string;
    }>;
    if (!rows.length) {
      await ctx.reply('Belum ada transaksi yang bisa dikoreksi.');
      return;
    }
    const kb = new InlineKeyboard();
    for (const r of rows) {
      kb.text(
        `${formatTanggalSingkat(dateOf(r.occurred_at))} ${r.direction === 'keluar' ? '−' : '+'}${formatIDR(r.amount_minor)} ${r.merchant_raw ?? r.kind}`.slice(0, 60),
        `k:${r.id}`,
      ).row();
    }
    await ctx.reply('Transaksi mana yang mau dikoreksi?', { reply_markup: kb });
  });

  // ---- Tombol ---------------------------------------------------------
  b.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const database = db();
    try {
      if (data.startsWith('d:')) {
        const [, idRaw, optId] = data.split(':');
        const hasil = applyDecision(Number(idRaw), optId ?? '', {}, 'telegram', database);
        await ctx.answerCallbackQuery({ text: hasil.ok ? 'Oke' : 'Gagal' });
        await balasLanjutan(ctx, hasil.pesan, hasil.lanjutan, database);
        return;
      }
      if (data.startsWith('cat:')) {
        const [, evId, catId] = data.split(':');
        database
          .prepare(`UPDATE cash_event SET category_id = ?, status = 'terkonfirmasi', updated_at = ? WHERE id = ?`)
          .run(Number(catId), nowIso(), Number(evId));
        database
          .prepare(`UPDATE allocation SET category_id = ? WHERE cash_event_id = ? AND purpose = 'biaya_pribadi'`)
          .run(Number(catId), Number(evId));
        await ctx.answerCallbackQuery({ text: 'Kategori diubah' });
        await ctx.reply('Kategori sudah diperbarui.');
        return;
      }
      if (data.startsWith('x:')) {
        const [, evIdRaw, aksi] = data.split(':');
        const evId = Number(evIdRaw);
        let pesan = '';
        if (aksi === 'talangan') pesan = jadikanTalangan(evId, null, 'telegram', database).pesan;
        else if (aksi === 'company_langsung') {
          jadikanCompanyLangsung(evId, 'telegram', database);
          pesan = 'Dicatat sebagai biaya company yang dibayar langsung company — saldoku tidak berubah.';
        } else if (aksi === 'setoran') {
          pesan = jadikanTransferSendiri(evId, { ke_tabungan: true, actor: 'telegram' }, database).pesan;
        } else if (aksi === 'reimburse') {
          jadikanReimburseCompany(evId, { actor: 'telegram' }, database);
          pesan = 'Dicatat sebagai klaim reimburse company.';
        } else if (aksi === 'hadiah') {
          pesan = jadikanHadiah(evId, 'telegram', database).pesan;
        }
        await ctx.answerCallbackQuery({ text: 'Oke' });
        await ctx.reply(pesan || 'Selesai.');
        return;
      }
      if (data.startsWith('k:')) {
        const evId = Number(data.split(':')[1]);
        const kb = new InlineKeyboard()
          .text('Ganti kategori', `kk:${evId}:kategori`)
          .text('Bagi biaya', `kk:${evId}:bagi`)
          .row()
          .text('Reimburse company', `x:${evId}:reimburse`)
          .text('Company bayar langsung', `x:${evId}:company_langsung`)
          .row()
          .text('Transfer sendiri', `x:${evId}:setoran`)
          .text('Hadiah', `x:${evId}:hadiah`)
          .row()
          .text('Talangan', `x:${evId}:talangan`);
        await ctx.answerCallbackQuery();
        await ctx.reply(`Transaksi #${evId}: mau diubah jadi apa?`, { reply_markup: kb });
        return;
      }
      if (data.startsWith('kk:')) {
        const [, evIdRaw, aksi] = data.split(':');
        const evId = Number(evIdRaw);
        await ctx.answerCallbackQuery();
        if (aksi === 'kategori') {
          await ctx.reply('Pilih kategorinya:', { reply_markup: kategoriKeyboard(evId, database) });
        } else {
          const ev = database.prepare(`SELECT amount_minor FROM cash_event WHERE id = ?`).get(evId) as
            | { amount_minor: number }
            | undefined;
          percakapan.set(String(ctx.chat?.id), {
            tipe: 'input_bagi_biaya',
            cash_event_id: evId,
            nominal_minor: ev?.amount_minor ?? 0,
          });
          await ctx.reply(
            `Total ${formatIDR(ev?.amount_minor ?? 0)}. Tulis pembagiannya, misalnya "aku 30rb, 3 teman" atau "berempat".`,
          );
        }
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Tombol itu belum dikenali.' });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: 'Gagal' });
      await ctx.reply(`Maaf, gagal: ${(err as Error).message}`);
    }
  });

  // ---- Foto kuitansi --------------------------------------------------
  b.on('message:photo', async (ctx) => {
    const database = db();
    const caption = ctx.message.caption ?? '';
    const nominal = caption ? parseRupiah(caption) : null;
    const fileId = ctx.message.photo[ctx.message.photo.length - 1]?.file_id ?? 'tanpa-file';

    const res = database
      .prepare(
        `INSERT OR IGNORE INTO evidence
          (source, external_id, kind, received_at, from_email, subject, permalink, body_hash,
           parsed_json, parser, confidence, is_promo, needs_review, created_at)
         VALUES ('telegram', ?, 'foto_kuitansi', ?, NULL, ?, NULL, ?, ?, 'telegram-foto', ?, 0, 1, ?)`,
      )
      .run(
        fileId,
        nowIso(),
        caption || 'Foto kuitansi',
        `tg:${fileId}`,
        JSON.stringify({ caption, nominal_minor: nominal }),
        nominal ? 0.5 : 0.2,
        nowIso(),
      );

    if (nominal) {
      await ctx.reply(
        `Dari keterangan foto aku baca: <b>${formatIDR(nominal)}</b>.\n` +
          'Betul? Balas "ya" untuk mencatatnya, atau tulis nominal yang benar.',
        { parse_mode: 'HTML' },
      );
      percakapan.set(String(ctx.chat.id), {
        tipe: 'konfirmasi_foto',
        evidence_id: Number(res.lastInsertRowid),
      });
    } else {
      await ctx.reply(
        'Foto kuitansi sudah kusimpan sebagai bukti. Aku belum bisa membaca angkanya otomatis — ' +
          'tulis nominal dan keterangannya, misalnya "makan 45rb", dan aku tautkan ke bukti ini.',
      );
      percakapan.set(String(ctx.chat.id), {
        tipe: 'konfirmasi_foto',
        evidence_id: Number(res.lastInsertRowid),
      });
    }
  });

  // ---- Teks bebas -----------------------------------------------------
  b.on('message:text', async (ctx) => {
    const database = db();
    const chatKey = String(ctx.chat.id);
    const teks = ctx.message.text.trim();
    if (teks.startsWith('/')) return;

    const state = percakapan.get(chatKey);
    if (state) {
      percakapan.delete(chatKey);
      try {
        if (state.tipe === 'input_bagi_biaya') {
          const nlu = detectIntent(teks);
          const hasil = bagiBiaya(
            state.cash_event_id,
            {
              bagian_saya_minor: nlu.bagian_saya_minor ?? nlu.nominal_minor,
              jumlah_orang: nlu.jumlah_orang,
              actor: 'telegram',
            },
            database,
          );
          await ctx.reply(hasil.pesan);
          return;
        }
        if (state.tipe === 'input_nominal') {
          const nominal = parseRupiah(teks);
          if (!nominal) {
            await ctx.reply('Aku belum menangkap nominalnya. Tulis misalnya "300 ribu".');
            return;
          }
          setTopupStatus(
            state.topup_plan_id,
            'diterima',
            { actual_amount_minor: nominal, actor: 'telegram' },
            database,
          );
          await ctx.reply(`Ditandai masuk ${formatIDR(nominal)}. Proyeksi sudah dihitung ulang.`);
          return;
        }
        if (state.tipe === 'input_belanja') {
          await tanganiBelanja(ctx, teks);
          return;
        }
        if (state.tipe === 'konfirmasi_foto') {
          const nlu = detectIntent(teks);
          if (!nlu.nominal_minor && !/^ya\b/i.test(teks)) {
            await ctx.reply('Belum ada nominal yang jelas, jadi belum kucatat sebagai transaksi.');
            return;
          }
          const ev = database
            .prepare(`SELECT parsed_json FROM evidence WHERE id = ?`)
            .get(state.evidence_id) as { parsed_json: string } | undefined;
          const dariFoto = ev ? (JSON.parse(ev.parsed_json) as { nominal_minor: number | null }) : null;
          const nominal = nlu.nominal_minor ?? dariFoto?.nominal_minor ?? null;
          if (!nominal) {
            await ctx.reply('Nominalnya masih belum jelas. Tulis angkanya ya.');
            return;
          }
          const hasil = catatPengeluaranCepat(
            nominal,
            nlu.kategori_tebakan,
            nlu.teks.replace(/^ya[,.\s]*/i, '').slice(0, 80),
            nlu.tanggal_relatif,
            database,
          );
          database
            .prepare(
              `INSERT OR IGNORE INTO cash_event_evidence (cash_event_id, evidence_id, role) VALUES (?, ?, 'foto')`,
            )
            .run(hasil.id, state.evidence_id);
          await ctx.reply(`${hasil.pesan} Foto kuitansi sudah ditautkan.`);
          return;
        }
      } catch (err) {
        await ctx.reply(`Maaf, gagal: ${(err as Error).message}`);
        return;
      }
    }

    const nlu = detectIntent(teks);
    try {
      switch (nlu.intent) {
        case 'bantuan':
          await ctx.reply(bantuan(), { parse_mode: 'HTML' });
          return;
        case 'tanya_hari':
          await ctx.reply(ringkasanHari(database), { parse_mode: 'HTML' });
          return;
        case 'tanya_tagihan':
          await ctx.reply(daftarTagihan(30, database), { parse_mode: 'HTML' });
          return;
        case 'tanya_anggaran':
          await ctx.reply(ringkasanAnggaran(database), { parse_mode: 'HTML' });
          return;
        case 'tanya_reimburse':
          await ctx.reply(ringkasanReimburse(database), { parse_mode: 'HTML' });
          return;
        case 'simulasi': {
          const hasil = simulasiPembelian(
            {
              label: nlu.teks.slice(0, 60),
              harga_minor: nlu.nominal_minor,
              jenis: 'pribadi',
              bisa_ditunda: true,
            },
            database,
          );
          await ctx.reply(hasilSimulasi(hasil), { parse_mode: 'HTML' });
          return;
        }
        case 'topup_tidak_diterima': {
          const rencana = database
            .prepare(
              `SELECT id, plan_date, plan_amount_minor FROM topup_plan WHERE status = 'rencana'
                ORDER BY abs(julianday(plan_date) - julianday(?)) LIMIT 1`,
            )
            .get(today()) as { id: number; plan_date: string; plan_amount_minor: number } | undefined;
          if (!rencana) {
            await ctx.reply('Tidak ada rencana top-up yang menunggu konfirmasi.');
            return;
          }
          setTopupStatus(rencana.id, 'tidak_diterima', { actor: 'telegram' }, database);
          await ctx.reply(
            `Rencana top-up ${formatIDR(rencana.plan_amount_minor)} tanggal ${rencana.plan_date} ` +
              'ditandai tidak diterima. Proyeksi sudah dihitung ulang.',
          );
          return;
        }
        case 'topup_diterima': {
          const rencana = database
            .prepare(
              `SELECT id, plan_amount_minor FROM topup_plan WHERE status = 'rencana'
                ORDER BY abs(julianday(plan_date) - julianday(?)) LIMIT 1`,
            )
            .get(today()) as { id: number; plan_amount_minor: number } | undefined;
          if (!rencana) {
            await ctx.reply('Tidak ada rencana top-up yang menunggu konfirmasi.');
            return;
          }
          setTopupStatus(
            rencana.id,
            'diterima',
            { actual_amount_minor: nlu.nominal_minor ?? rencana.plan_amount_minor, actor: 'telegram' },
            database,
          );
          await ctx.reply('Top-up ditandai diterima. Terima kasih.');
          return;
        }
        case 'bagi_biaya':
        case 'set_reimburse':
        case 'set_hadiah':
        case 'set_talangan':
        case 'set_company_langsung':
        case 'transfer_sendiri':
        case 'setoran_tabungan':
        case 'koreksi': {
          // Terapkan ke transaksi yang dibalas, atau ke transaksi terakhir.
          const balasanId = ctx.message.reply_to_message?.message_id;
          let evId: number | null = null;
          if (balasanId) {
            const d = database
              .prepare(`SELECT cash_event_id FROM pending_decision WHERE telegram_message_id = ?`)
              .get(String(balasanId)) as { cash_event_id: number | null } | undefined;
            evId = d?.cash_event_id ?? null;
          }
          if (!evId) {
            const last = database
              .prepare(
                `SELECT id FROM cash_event WHERE status <> 'dibatalkan' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
              )
              .get() as { id: number } | undefined;
            evId = last?.id ?? null;
          }
          if (!evId) {
            await ctx.reply('Belum ada transaksi yang bisa diubah.');
            return;
          }

          if (nlu.intent === 'bagi_biaya') {
            const hasil = bagiBiaya(
              evId,
              {
                bagian_saya_minor: nlu.bagian_saya_minor,
                jumlah_orang: nlu.jumlah_orang,
                actor: 'telegram',
              },
              database,
            );
            await ctx.reply(hasil.pesan);
          } else if (nlu.intent === 'set_reimburse') {
            jadikanReimburseCompany(evId, { actor: 'telegram' }, database);
            await ctx.reply('Dicatat sebagai klaim reimburse company. Saldoku turun sampai uangnya kembali.');
          } else if (nlu.intent === 'set_company_langsung') {
            jadikanCompanyLangsung(evId, 'telegram', database);
            await ctx.reply('Dicatat sebagai biaya company yang dibayar langsung — saldoku tidak berubah.');
          } else if (nlu.intent === 'set_hadiah') {
            await ctx.reply(jadikanHadiah(evId, 'telegram', database).pesan);
          } else if (nlu.intent === 'set_talangan') {
            await ctx.reply(jadikanTalangan(evId, null, 'telegram', database).pesan);
          } else if (nlu.intent === 'transfer_sendiri' || nlu.intent === 'setoran_tabungan') {
            const hasil = jadikanTransferSendiri(
              evId,
              { ke_tabungan: nlu.intent === 'setoran_tabungan', actor: 'telegram' },
              database,
            );
            await ctx.reply(hasil.pesan);
          } else {
            const kb = new InlineKeyboard().text('Pilih tindakan', `k:${evId}`);
            await ctx.reply(`Transaksi terakhir #${evId}. Mau diubah apa?`, { reply_markup: kb });
          }
          return;
        }
        case 'catat_pemasukan': {
          if (!nlu.nominal_minor) break;
          const akun = database
            .prepare(`SELECT id FROM account WHERE is_mine = 1 AND is_savings_target = 0 ORDER BY id LIMIT 1`)
            .get() as { id: number } | undefined;
          const res = recordCashEvent(
            {
              occurred_at: nowIso(),
              direction: 'masuk',
              amount_minor: nlu.nominal_minor,
              account_id: akun?.id ?? null,
              is_cash: !akun,
              kind: 'pemasukan_luar',
              merchant_raw: nlu.teks.slice(0, 80),
              source: 'telegram',
              actor: 'telegram',
            },
            database,
          );
          await ctx.reply(
            `Pemasukan ${formatIDR(nlu.nominal_minor)} dicatat (#${res.id}).\n` +
              'Kalau ini sebenarnya pelunasan piutang, balas "itu pelunasan piutang".',
          );
          return;
        }
        case 'catat_pengeluaran': {
          if (!nlu.nominal_minor) break;
          const hasil = catatPengeluaranCepat(
            nlu.nominal_minor,
            nlu.kategori_tebakan,
            nlu.teks.slice(0, 80),
            nlu.tanggal_relatif,
            database,
          );
          const kb = new InlineKeyboard()
            .text('Benar', `x:${hasil.id}:none`)
            .text('Bagi biaya', `kk:${hasil.id}:bagi`)
            .row()
            .text('Reimburse company', `x:${hasil.id}:reimburse`)
            .text('Hadiah', `x:${hasil.id}:hadiah`);
          await ctx.reply(hasil.pesan, { reply_markup: kb });
          return;
        }
        default:
          break;
      }
      await ctx.reply(
        'Aku belum yakin maksudnya. Coba tulis nominalnya, misalnya "makan 25 ribu", ' +
          'atau kirim /bantuan untuk contoh lain.',
      );
    } catch (err) {
      await ctx.reply(`Maaf, gagal: ${(err as Error).message}`);
    }
  });

  b.catch((err) => {
    console.error('[telegram] kesalahan tidak tertangani:', err.message);
  });

  bot = b;
  return b;
}

async function tanganiBelanja(ctx: Context, teks: string): Promise<void> {
  const database = db();
  const hargaTidakTahu = /(belum tahu|belum diketahui|gak tahu|tidak tahu|\?)/i.test(teks);
  const nominal = hargaTidakTahu ? null : parseRupiah(teks);
  const qtyMatch = teks.match(/\b(\d{1,3})\s*(?:x|buah|pcs)\b/i);
  const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
  const nama =
    teks
      .replace(/\b\d+(?:[.,]\d+)?\s*(jt|juta|rb|ribu|k)\b/gi, '')
      .replace(/\b(\d{1,3})\s*(?:x|buah|pcs)\b/gi, '')
      .replace(/(rp\.?\s?[\d.]+)/gi, '')
      .replace(/(belum tahu|belum diketahui|gak tahu|tidak tahu|\?)/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || 'Belanja tanpa nama';

  const total = nominal === null ? null : nominal * qty;
  const res = database
    .prepare(
      `INSERT INTO purchase
        (name, qty, unit_price_minor, total_minor, price_unknown, currency, planned, wanted_on,
         category_id, final_bearer, payment_status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'IDR', 1, ?, NULL, 'saya', 'belum_dibayar', ?, ?, ?)`,
    )
    .run(
      nama,
      qty,
      nominal,
      total,
      nominal === null ? 1 : 0,
      today(),
      'Ditambahkan lewat Telegram.',
      nowIso(),
      nowIso(),
    );

  if (nominal === null) {
    await ctx.reply(
      `"${nama}" dicatat sebagai rencana belanja <b>tanpa harga</b>.\n` +
        'Ini TIDAK dianggap gratis — muncul sebagai risiko anggaran yang belum dapat dihitung. ' +
        'Kirim harganya kalau sudah tahu.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const hasil = simulasiPembelian(
    { label: nama, harga_minor: total, jenis: 'pribadi', bisa_ditunda: true },
    database,
  );
  await ctx.reply(
    `"${nama}" ${qty > 1 ? `${qty} × ${formatIDR(nominal)} = ` : ''}${formatIDR(total)} ` +
      `dicatat sebagai rencana belanja (#${res.lastInsertRowid}).\n\n${hasilSimulasi(hasil)}`,
    { parse_mode: 'HTML' },
  );
}

export async function startBot(): Promise<void> {
  const b = createBot();
  if (!b) {
    console.log('[telegram] bot tidak dijalankan (TELEGRAM_MODE=off atau token kosong).');
    return;
  }
  await b.api.setMyCommands([
    { command: 'hari', description: 'Posisi hari ini' },
    { command: 'minggu', description: 'Rekap minggu ini' },
    { command: 'bulan', description: 'Rekap bulan ini' },
    { command: '5hari', description: 'Blok lima hari berjalan' },
    { command: 'tagihan', description: 'Tagihan dan jatuh tempo' },
    { command: 'anggaran', description: 'Pemakaian versus batas' },
    { command: 'tabungan', description: 'Setoran dan saldo BCA' },
    { command: 'reimburse', description: 'Piutang teman dan company' },
    { command: 'belanja', description: 'Tambah pembelian' },
    { command: 'simulasi', description: 'Bolehkah aku beli ini?' },
    { command: 'skenario', description: 'Bandingkan skenario Claude' },
    { command: 'koreksi', description: 'Perbaiki transaksi' },
    { command: 'bantuan', description: 'Daftar kemampuan' },
  ]);

  if (config.TELEGRAM_MODE === 'webhook') {
    console.log('[telegram] mode webhook: pasang webhook lewat /api/telegram/webhook.');
    return;
  }
  void b.start({
    onStart: () => console.log('[telegram] bot berjalan dengan long polling.'),
  });
}
