/**
 * Perutean pusat: callback data → layar, teks → alur percakapan, perintah → layar.
 *
 * Semua fungsi di sini murni terhadap database (tanpa jaringan), sehingga seluruh alur Telegram
 * dapat diuji tanpa bot sungguhan. Pembungkus grammY ada di ../bot.ts.
 *
 * Kebijakan penting:
 *  - Callback yang tidak dikenali mengembalikan `null` supaya handler lama (d:, cat:, x:, kk:, an:) tetap jalan.
 *  - Tombol pada pesan yang sudah selesai tidak mengubah data; hanya menampilkan ringkasan.
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../../db/index.js';
import { ubahTransaksi } from '../../domain/manualTx.js';
import { getCashEvent } from '../../domain/ledger.js';
import { bagiBiaya } from '../../domain/applyDecision.js';
import { penyebabDefisit } from '../../notify/index.js';
import { MUTE_HARI, TUNDA_JAM, setMute, setTunda } from '../../notify/kontrol.js';
import { dateOf, formatTanggal, today, addDays } from '../../domain/time.js';
import { adalahPermintaanBuatTujuan, parseTujuan } from '../analitikBot.js';
import { detectIntent, parseRupiah } from '../nlu.js';
import { esc } from '../format.js';
import { clearState, getState, type TgState } from '../state.js';
import { MENU_UTAMA, tombolData, type Hasil, type Konteks, type Layar } from './layar.js';
import { layarKartu, tanganiKartu, tanganiNotif } from './transaksiUi.js';
import { layarDaftarKategori, tanganiKategori, tanganiTeksGantiNama, tanganiTeksKategoriBaru, type StateKategoriBaru } from './kategoriUi.js';
import { halamanHasil, mulaiTransaksi } from './cariUi.js';
import {
  getDraft, hapusDraft, layarMenuCatat, mulaiDariTeks, setelahKategoriBaru, tanganiCatat, tanganiTeksCatat,
} from './catatUi.js';
import {
  adalahPermintaanAnggaran, layarAnggaran, layarDaftarTarget, mulaiDraftAnggaran, mulaiDraftTarget,
  tanganiAnggaran, tanganiTarget, tanganiTeksAnggaran, tanganiTeksTarget,
} from './rencanaUi.js';
import {
  layarBantuan, layarLaporanMenu, layarMenuUtama, layarPengaturan, layarRekening, layarRencana, layarTagihan,
  tanganiLaporan, tanganiPengaturan, tanganiRekening, tanganiTagihan, tanganiTeksSaldo,
} from './lainUi.js';

const layarMenu = (database: DB): Hasil => ({ layar: layarMenuUtama(database) });

/* ------------------------------------------------------------------ callback */

export function ruteCallback(data: string, ctx: Konteks, database: DB = db()): Hasil | null {
  const parts = data.split(':');
  switch (parts[0]) {
    case 'm':
      return tanganiMenu(parts, ctx, database);
    case 'n':
      return tanganiNotif(parts, ctx, database);
    case 't':
      if (parts[1] === 'l') return halamanHasil(Number(parts[2] ?? 0), ctx, database);
      return tanganiKartu(parts, ctx, database);
    case 'k':
      // k:<angka> adalah callback lama dari /koreksi; biarkan handler lama menanganinya.
      if (/^\d+$/.test(parts[1] ?? '')) return null;
      return tanganiKategori(parts, ctx, database, (lanjut, kategoriId, c, d) => (lanjut === 'catat' ? setelahKategoriBaru(kategoriId, c, d) : null));
    case 'c':
      return tanganiCatat(parts, ctx, database);
    case 'a':
      return tanganiAnggaran(parts, ctx, database);
    case 'g':
      return tanganiTarget(parts, ctx, database);
    case 'l':
      return tanganiLaporan(parts, ctx, database);
    case 'r':
      return tanganiRekening(parts, ctx, database);
    case 'b':
      return tanganiTagihan(parts, ctx, database);
    case 's':
      return tanganiPengaturan(parts, ctx, database);
    case 'p':
      return tanganiPengingat(parts, database);
    default:
      return null;
  }
}

function tanganiMenu(parts: string[], ctx: Konteks, database: DB): Hasil {
  switch (parts[1]) {
    case 'home':
      clearState(ctx.chatId, 'utama', database);
      hapusDraft(ctx, database);
      return layarMenu(database);
    case 'batal':
      clearState(ctx.chatId, 'utama', database);
      hapusDraft(ctx, database);
      return { toast: 'Dibatalkan', ...layarMenu(database) };
    case 'help':
      return { layar: layarBantuan() };
    case 'belum':
      return { ...mulaiTransaksi('belum dikategorikan', ctx, database), baru: false };
    case 'rencana':
      return { layar: layarRencana(database) };
    case 'noop':
      return {};
    default:
      return { toast: 'Tombol ini tidak dikenali.' };
  }
}

/** Tombol pada pengingat defisit: Lihat Penyebab / Ingatkan Nanti / Bisukan. */
function tanganiPengingat(parts: string[], database: DB): Hasil {
  const tipe = 'saldo_di_bawah_cadangan';
  switch (parts[1]) {
    case 'sebab':
      return { baru: true, layar: { teks: penyebabDefisit(database), tombol: [[tombolData('💳 Konfirmasi Saldo', 'r:l')], [MENU_UTAMA]] } };
    case 'tunda':
      setTunda(tipe, new Date(Date.now() + TUNDA_JAM * 3_600_000).toISOString(), database);
      return { toast: `Diingatkan lagi ${TUNDA_JAM} jam lagi`, hapusTombol: true };
    case 'mute':
      setMute(tipe, new Date(Date.now() + MUTE_HARI * 86_400_000).toISOString(), database);
      return { toast: `Dibisukan ${MUTE_HARI} hari`, hapusTombol: true };
    default:
      return { toast: 'Tombol ini tidak dikenali.' };
  }
}

/* ------------------------------------------------------------------ perintah */

export function ruteCommand(nama: string, argumen: string, ctx: Konteks, database: DB = db()): Hasil | null {
  switch (nama) {
    case 'start':
    case 'mulai':
    case 'menu':
      clearState(ctx.chatId, 'utama', database);
      hapusDraft(ctx, database);
      return { baru: true, ...layarMenu(database) };
    case 'batal':
      clearState(ctx.chatId, 'utama', database);
      hapusDraft(ctx, database);
      return { baru: true, layar: { teks: '❌ Dibatalkan. Tidak ada yang diubah.', tombol: [[MENU_UTAMA]] } };
    case 'catat':
      hapusDraft(ctx, database);
      clearState(ctx.chatId, 'utama', database);
      return { baru: true, layar: layarMenuCatat() };
    case 'transaksi':
      clearState(ctx.chatId, 'utama', database);
      return mulaiTransaksi(argumen, ctx, database);
    case 'kategori':
      clearState(ctx.chatId, 'utama', database);
      return { baru: true, layar: layarDaftarKategori(0, database) };
    case 'anggaran':
      clearState(ctx.chatId, 'utama', database);
      return { baru: true, layar: layarAnggaran(database) };
    case 'target':
    case 'tujuan':
      clearState(ctx.chatId, 'utama', database);
      return { baru: true, layar: layarDaftarTarget(database) };
    case 'laporan':
      return { baru: true, layar: layarLaporanMenu() };
    case 'rekening':
      return { baru: true, layar: layarRekening(database) };
    case 'tagihan':
      return { baru: true, layar: layarTagihan(database) };
    case 'rencana':
      return { baru: true, layar: layarRencana(database) };
    case 'pengaturan':
      return { baru: true, layar: layarPengaturan(database) };
    case 'bantuan':
    case 'help':
      return { baru: true, layar: layarBantuan() };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ teks */

function parseTanggal(teks: string, hariIni = today()): string | null {
  const t = teks.trim().toLowerCase();
  if (t === 'kemarin') return addDays(hariIni, -1);
  if (t === 'hari ini' || t === 'hari-ini') return hariIni;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return t;
  const dm = t.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?$/);
  if (dm) return `${dm[3] ?? hariIni.slice(0, 4)}-${dm[2]!.padStart(2, '0')}-${dm[1]!.padStart(2, '0')}`;
  return null;
}

function tanganiKoreksi(state: TgState, teks: string, ctx: Konteks, database: DB): Hasil {
  const eventId = Number(state['eventId']);
  const field = String(state['field']);
  const ev = getCashEvent(eventId, database);
  if (!ev) {
    clearState(ctx.chatId, 'utama', database);
    return { baru: true, layar: { teks: 'Transaksi itu tidak ditemukan.', tombol: [[MENU_UTAMA]] } };
  }
  const batal = [[tombolData('❌ Batal', `t:v:${eventId}`)]];
  const nilai = teks.trim();
  try {
    if (field === 'jumlah') {
      const n = parseRupiah(nilai.toLowerCase()) ?? (/^\d{3,}$/.test(nilai) ? Number(nilai) : null);
      if (!n) return { baru: true, layar: { teks: 'Nominalnya belum terbaca. Contoh: 35rb', tombol: batal } };
      ubahTransaksi(eventId, { jumlah_minor: n }, 'telegram', database);
    } else if (field === 'merchant') {
      ubahTransaksi(eventId, { merchant: nilai === '-' ? null : nilai.slice(0, 60) }, 'telegram', database);
    } else if (field === 'catatan') {
      ubahTransaksi(eventId, { catatan: nilai === '-' ? null : nilai.slice(0, 200) }, 'telegram', database);
    } else if (field === 'proyek') {
      ubahTransaksi(eventId, { proyek: nilai === '-' ? null : nilai.slice(0, 30) }, 'telegram', database);
    } else if (field === 'tanggal') {
      const tgl = parseTanggal(nilai);
      if (!tgl) return { baru: true, layar: { teks: 'Tanggalnya belum terbaca. Contoh: kemarin, 2026-11-10, atau 10/11', tombol: batal } };
      // Pertahankan jam aslinya; hanya tanggalnya yang berubah.
      ubahTransaksi(eventId, { waktu: `${tgl}T${ev.occurred_at.slice(11, 16)}` }, 'telegram', database);
    } else {
      return { baru: true, layar: { teks: 'Bagian itu tidak dikenal.', tombol: batal } };
    }
  } catch (err) {
    return { baru: true, layar: { teks: `⚠️ ${esc((err as Error).message)}`, tombol: batal } };
  }
  clearState(ctx.chatId, 'utama', database);
  return { baru: true, layar: layarKartu(eventId, {}, database), toast: 'Tersimpan' };
}

function tanganiBagi(state: TgState, teks: string, ctx: Konteks, database: DB): Hasil {
  const nlu = detectIntent(teks);
  try {
    const hasil = bagiBiaya(
      Number(state['cash_event_id']),
      { bagian_saya_minor: nlu.bagian_saya_minor ?? nlu.nominal_minor, jumlah_orang: nlu.jumlah_orang, actor: 'telegram' },
      database,
    );
    clearState(ctx.chatId, 'utama', database);
    return { baru: true, layar: { ...layarKartu(Number(state['cash_event_id']), {}, database), teks: `✅ ${esc(hasil.pesan)}\n\n${layarKartu(Number(state['cash_event_id']), {}, database).teks}` } };
  } catch (err) {
    return { baru: true, layar: { teks: `⚠️ ${esc((err as Error).message)}\nCoba tulis ulang, misalnya "aku 30rb, 3 teman".`, tombol: [[tombolData('❌ Batal', `t:v:${state['cash_event_id']}`)]] } };
  }
}

/**
 * Teks bebas. Mengembalikan null bila bukan urusan lapisan ini (diteruskan ke handler lama:
 * top-up, belanja, foto kuitansi, simulasi, pertanyaan analitik, dll).
 */
export function ruteTeks(teks: string, ctx: Konteks, database: DB = db()): Hasil | null {
  const t = teks.trim();
  if (/^(batal|cancel|stop)$/i.test(t)) return ruteCommand('batal', '', ctx, database);

  const st = getState(ctx.chatId, 'utama', database);
  if (st) {
    switch (st.t) {
      case 'kat_baru':
        return tanganiTeksKategoriBaru(st as StateKategoriBaru, t, ctx, database);
      case 'kat_ganti':
        return tanganiTeksGantiNama(st, t, ctx, database);
      case 'koreksi':
        return tanganiKoreksi(st, t, ctx, database);
      case 'bagi':
        return tanganiBagi(st, t, ctx, database);
      case 'anggaran_teks':
      case 'anggaran_nominal':
        return tanganiTeksAnggaran(st, t, ctx, database);
      case 'target_teks':
      case 'target_setoran':
        return tanganiTeksTarget(st, t, ctx, database);
      case 'saldo':
        return tanganiTeksSaldo(st, t, ctx, database);
      default:
        break; // keadaan lain (topup, belanja, foto, tujuan lama) ditangani handler lama
    }
  }

  if (getDraft(ctx, database)) {
    const h = tanganiTeksCatat(t, ctx, database);
    if (h) return h;
  }

  if (adalahPermintaanAnggaran(t)) return mulaiDraftAnggaran(t, ctx, database);
  if (adalahPermintaanBuatTujuan(t)) return mulaiDraftTarget(parseTujuan(t), ctx, database);
  const catat = mulaiDariTeks(t, ctx, database);
  if (catat) return catat;
  return null;
}

export type { Layar };
void dateOf;
void formatTanggal;
