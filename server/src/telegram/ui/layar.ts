/**
 * Bahasa bersama untuk layar Telegram: teks + inline keyboard sebagai data biasa.
 * Pemisahan ini membuat semua alur dapat diuji tanpa menyentuh jaringan.
 */
import { InlineKeyboard } from 'grammy';

export type Tombol = { t: string; d: string } | { t: string; url: string };
export type Layar = { teks: string; tombol?: Tombol[][] };

export type Hasil = {
  /** Layar yang menggantikan pesan tempat tombol ditekan (atau balasan baru bila tidak ada pesan). */
  layar?: Layar;
  /** Teks singkat yang muncul di atas layar Telegram (answerCallbackQuery). */
  toast?: string;
  /** Pesan tambahan yang dikirim sebagai balasan baru. */
  pesanBaru?: Layar[];
  /** Hapus tombol dari pesan tempat callback ditekan, tanpa mengganti teks. */
  hapusTombol?: boolean;
  /** Paksa kirim sebagai pesan baru, bukan menyunting pesan lama. */
  baru?: boolean;
};

export type Konteks = { chatId: string; messageId?: number };

export const BATAS_CALLBACK = 64;

export function tombolData(t: string, d: string): Tombol {
  if (Buffer.byteLength(d, 'utf8') > BATAS_CALLBACK) {
    throw new Error(`Callback data terlalu panjang (${d.length}): ${d}`);
  }
  return { t, d };
}

export function keKeyboard(rows: Tombol[][] | undefined): InlineKeyboard | undefined {
  if (!rows || rows.length === 0) return undefined;
  const kb = new InlineKeyboard();
  rows.forEach((row, i) => {
    for (const b of row) {
      if ('url' in b) kb.url(b.t, b.url);
      else kb.text(b.t, b.d);
    }
    if (i < rows.length - 1) kb.row();
  });
  return kb;
}

export const MENU_UTAMA: Tombol = { t: '🏠 Menu Utama', d: 'm:home' };
export const BATAL: Tombol = { t: '❌ Batalkan', d: 'm:batal' };

/** Baris navigasi standar: Kembali (opsional) + Menu Utama. */
export function navigasi(kembali?: string): Tombol[] {
  return kembali ? [tombolData('⬅️ Kembali', kembali), MENU_UTAMA] : [MENU_UTAMA];
}

/** Susun tombol menjadi grid dengan `kolom` tombol per baris. */
export function grid(tombol: Tombol[], kolom = 2): Tombol[][] {
  const rows: Tombol[][] = [];
  for (let i = 0; i < tombol.length; i += kolom) rows.push(tombol.slice(i, i + kolom));
  return rows;
}

export type Halaman<T> = { item: T[]; halaman: number; total: number; jumlahHalaman: number };

export function potongHalaman<T>(semua: T[], halaman: number, perHalaman: number): Halaman<T> {
  const jumlahHalaman = Math.max(1, Math.ceil(semua.length / perHalaman));
  const h = Math.min(Math.max(0, Math.floor(halaman) || 0), jumlahHalaman - 1);
  return { item: semua.slice(h * perHalaman, (h + 1) * perHalaman), halaman: h, total: semua.length, jumlahHalaman };
}

/** Baris "⬅️ Sebelumnya · 2/5 · Berikutnya ➡️" untuk daftar bertingkat halaman. */
export function barisHalaman(h: Halaman<unknown>, dataUntuk: (halaman: number) => string): Tombol[] {
  if (h.jumlahHalaman <= 1) return [];
  const baris: Tombol[] = [];
  if (h.halaman > 0) baris.push(tombolData('⬅️ Sebelumnya', dataUntuk(h.halaman - 1)));
  baris.push(tombolData(`${h.halaman + 1}/${h.jumlahHalaman}`, 'm:noop'));
  if (h.halaman < h.jumlahHalaman - 1) baris.push(tombolData('Berikutnya ➡️', dataUntuk(h.halaman + 1)));
  return baris;
}
