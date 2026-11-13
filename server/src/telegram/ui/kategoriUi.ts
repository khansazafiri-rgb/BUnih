/**
 * Kelola kategori dari Telegram: lihat, buat, ganti nama, arsipkan, gabungkan.
 * Kategori disimpan di tabel `category` yang sama dengan web, sehingga muncul di dashboard dan analitik.
 *
 * Callback data: k:<aksi>[:args]
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../../db/index.js';
import { CategoryError, deactivateCategory, getCategory } from '../../domain/categories.js';
import { buatAtauPakaiKategori, cariKategoriPersis, gabungKategori, gantiNamaKategori } from '../../domain/categoryOps.js';
import { getState, getTgMessage, selesaikanPesan, clearState, setState, type TgState } from '../state.js';
import { answerDecision, getDecision } from '../../domain/decisions.js';
import { esc } from '../format.js';
import { layarKartu, layarSelesai, semuaKategoriAktif, setKategoriTransaksi } from './transaksiUi.js';
import { MENU_UTAMA, barisHalaman, grid, navigasi, potongHalaman, tombolData, type Hasil, type Konteks, type Layar, type Tombol } from './layar.js';

const PER_HALAMAN = 8;

export type StateKategoriBaru = TgState & {
  t: 'kat_baru';
  step: 'nama' | 'konfirmasi' | 'duplikat';
  nama?: string;
  rid?: number;
  eventId?: number;
  /** Alur lain yang menunggu kategori ini ('catat' | 'anggaran'). */
  lanjut?: string;
  balik?: string;
};

export type KaitanLanjutan = (lanjut: string, kategoriId: number, ctx: Konteks, database: DB) => Hasil | null;

const batalData = 'k:cancel';

export function layarDaftarKategori(halaman: number, database: DB = db()): Layar {
  const semua = semuaKategoriAktif(database);
  const h = potongHalaman(semua, halaman, PER_HALAMAN);
  const hitung = database.prepare(`SELECT COUNT(*) AS n FROM cash_event WHERE category_id = ? AND status <> 'dibatalkan'`);
  const baris: Tombol[][] = grid(
    h.item.map((k) => tombolData(`${k.icon ?? '🏷️'} ${k.name} (${(hitung.get(k.id) as { n: number }).n})`.slice(0, 40), `k:v:${k.id}:${h.halaman}`)),
    2,
  );
  const nav = barisHalaman(h, (p) => `k:l:${p}`);
  if (nav.length) baris.push(nav);
  baris.push([tombolData('➕ Kategori Baru', 'k:new')]);
  baris.push(navigasi());
  return {
    teks: `📂 <b>Kategori</b> (${h.total})\nAngka di dalam kurung = jumlah transaksi. Ketuk kategori untuk mengubah nama, mengarsipkan, atau menggabungkan.`,
    tombol: baris,
  };
}

function layarDetail(id: number, halaman: number, database: DB): Layar {
  const k = getCategory(id, database);
  if (!k) return { teks: 'Kategori tidak ditemukan.', tombol: [navigasi('k:l:0')] };
  const n = (database.prepare(`SELECT COUNT(*) AS n FROM cash_event WHERE category_id = ? AND status <> 'dibatalkan'`).get(id) as { n: number }).n;
  const ag = (database.prepare(`SELECT COUNT(*) AS n FROM budget WHERE category_id = ? AND active = 1`).get(id) as { n: number }).n;
  return {
    teks:
      `${esc(k.icon ?? '🏷️')} <b>${esc(k.name)}</b>${k.active ? '' : ' <i>(diarsipkan)</i>'}\n` +
      `${n} transaksi · ${ag} anggaran aktif`,
    tombol: [
      [tombolData('✏️ Ganti Nama', `k:rn:${id}`), tombolData('🔀 Gabungkan ke…', `k:mg:${id}:0`)],
      [tombolData('🎯 Buat Anggaran', `a:new:${id}`), tombolData('🗄️ Arsipkan', `k:ar:${id}`)],
      navigasi(`k:l:${halaman}`),
    ],
  };
}

function layarKonfirmasiNama(nama: string, balik: string): Layar {
  return {
    teks: `➕ Kategori baru: <b>${esc(nama)}</b>\nSimpan dan pakai sekarang?`,
    tombol: [[tombolData('✅ Simpan & Pakai', 'k:ok')], [tombolData('✏️ Ganti Nama', 'k:ren'), tombolData('❌ Batal', batalData)]],
    ...(balik ? {} : {}),
  };
}

/* ------------------------------------------------------------------ teks: nama kategori */

export function tanganiTeksKategoriBaru(state: StateKategoriBaru, teks: string, ctx: Konteks, database: DB = db()): Hasil {
  let nama = teks.trim().replace(/\s+/g, ' ');
  // Ditulis huruf kecil semua → rapikan jadi "Pacaran"; tulisan yang sudah bercampur dihormati apa adanya.
  if (nama === nama.toLowerCase()) nama = nama.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  if (nama.length < 2 || nama.length > 40) {
    return { layar: { teks: 'Nama kategori 2–40 karakter. Coba lagi, atau batalkan.', tombol: [[tombolData('❌ Batal', batalData)]] }, baru: true };
  }
  if (!/[\p{L}\p{N}]/u.test(nama)) {
    return { layar: { teks: 'Nama harus memuat huruf atau angka. Coba lagi.', tombol: [[tombolData('❌ Batal', batalData)]] }, baru: true };
  }
  const ada = cariKategoriPersis(nama, {}, database);
  if (ada) {
    setState(ctx.chatId, { ...state, step: 'duplikat', nama: ada.name }, 'utama', 45, database);
    return {
      baru: true,
      layar: {
        teks: `Kategori <b>${esc(ada.name)}</b> sudah ada (nama yang berbeda hanya kapitalisasi atau spasi dianggap sama).`,
        tombol: [[tombolData('✅ Pakai yang Sudah Ada', 'k:ok')], [tombolData('✏️ Ganti Nama', 'k:ren'), tombolData('❌ Batal', batalData)]],
      },
    };
  }
  setState(ctx.chatId, { ...state, step: 'konfirmasi', nama }, 'utama', 45, database);
  return { baru: true, layar: layarKonfirmasiNama(nama, state.balik ?? '') };
}

export function tanganiTeksGantiNama(state: TgState, teks: string, ctx: Konteks, database: DB = db()): Hasil {
  const id = Number(state['id']);
  try {
    gantiNamaKategori(id, teks, 'telegram', database);
    clearState(ctx.chatId, 'utama', database);
    return { baru: true, layar: { teks: `✅ Nama kategori diganti menjadi <b>${esc(teks.trim())}</b>. Riwayat transaksi tidak berubah.`, tombol: [[tombolData('📂 Daftar Kategori', 'k:l:0')], [MENU_UTAMA]] } };
  } catch (err) {
    return { baru: true, layar: { teks: `⚠️ ${esc((err as Error).message)}\nCoba nama lain, atau batalkan.`, tombol: [[tombolData('❌ Batal', batalData)]] } };
  }
}

/* ------------------------------------------------------------------ callback */

export function tanganiKategori(parts: string[], ctx: Konteks, database: DB = db(), kaitan?: KaitanLanjutan): Hasil {
  const aksi = parts[1] ?? '';
  const a = parts[2];
  const b = parts[3];
  try {
    switch (aksi) {
      case 'l':
        clearState(ctx.chatId, 'utama', database);
        return { layar: layarDaftarKategori(Number(a ?? 0), database) };
      case 'v':
        return { layar: layarDetail(Number(a), Number(b ?? 0), database) };

      case 'new':
        setState(ctx.chatId, { t: 'kat_baru', step: 'nama', balik: 'k:l:0' } satisfies StateKategoriBaru, 'utama', 45, database);
        return {
          layar: { teks: '➕ <b>Kategori baru</b>\nKategori baru mau diberi nama apa?\n<i>Ketik namanya, misalnya: Pacaran</i>', tombol: [[tombolData('❌ Batal', batalData)]] },
        };
      case 'ren': {
        const st = (getStateKat(ctx, database));
        if (!st) return { toast: 'Sesi sudah berakhir. Mulai lagi dari /kategori.' };
        setState(ctx.chatId, { ...st, step: 'nama' }, 'utama', 45, database);
        return { layar: { teks: 'Nama kategorinya mau diganti jadi apa?', tombol: [[tombolData('❌ Batal', batalData)]] } };
      }
      case 'cancel': {
        const st = getStateKat(ctx, database);
        clearState(ctx.chatId, 'utama', database);
        if (st?.balik) {
          // Kembali ke layar asal (notifikasi, kartu, atau daftar).
          return { toast: 'Dibatalkan', layar: { teks: 'Dibatalkan.', tombol: [[tombolData('⬅️ Kembali', st.balik)], [MENU_UTAMA]] } };
        }
        return { toast: 'Dibatalkan', layar: { teks: 'Dibatalkan.', tombol: [[MENU_UTAMA]] } };
      }
      case 'ok': {
        const st = getStateKat(ctx, database);
        if (!st || !st.nama || st.step === 'nama') return { toast: 'Sudah diproses atau sesi berakhir.', hapusTombol: true };
        const hasil = buatAtauPakaiKategori(st.nama, 'telegram', {}, database);
        clearState(ctx.chatId, 'utama', database);
        const pesanStatus =
          hasil.status === 'baru' ? `✅ Kategori <b>${esc(hasil.nama)}</b> disimpan.` :
          hasil.status === 'diaktifkan_lagi' ? `✅ Kategori <b>${esc(hasil.nama)}</b> diaktifkan kembali (riwayatnya utuh).` :
          `✅ Memakai kategori <b>${esc(hasil.nama)}</b> yang sudah ada.`;

        if (st.lanjut && kaitan) {
          const h = kaitan(st.lanjut, hasil.id, ctx, database);
          if (h) return h;
        }
        if (st.eventId) {
          const rowNotif = st.rid ? getTgMessage(st.rid, database) : undefined;
          setKategoriTransaksi(st.eventId, hasil.id, 'telegram', database);
          if (rowNotif && rowNotif.state === 'aktif' && selesaikanPesan(rowNotif.id, `kategori ${hasil.nama}`, database)) {
            if (rowNotif.decision_id) {
              const d = getDecision(rowNotif.decision_id, database);
              if (d && d.state !== 'dijawab' && d.state !== 'dibatalkan') answerDecision(rowNotif.decision_id, { kategori_id: hasil.id }, 'telegram', database);
            }
            return { toast: 'Tersimpan', layar: layarSelesai(rowNotif, `${pesanStatus}\n✅ Transaksi ini dikategorikan <b>${esc(hasil.nama)}</b>. Kategori ini akan muncul di pilihan berikutnya.`, database) };
          }
          return { toast: 'Tersimpan', layar: { ...layarKartu(st.eventId, {}, database), teks: `${pesanStatus}\n\n${layarKartu(st.eventId, {}, database).teks}` } };
        }
        return { toast: 'Tersimpan', layar: { teks: pesanStatus, tombol: [[tombolData('📂 Daftar Kategori', 'k:l:0')], [MENU_UTAMA]] } };
      }

      case 'rn':
        setState(ctx.chatId, { t: 'kat_ganti', id: Number(a) }, 'utama', 45, database);
        return { layar: { teks: 'Nama baru untuk kategori ini?', tombol: [[tombolData('❌ Batal', 'k:l:0')]] } };

      case 'ar': {
        const k = getCategory(Number(a), database);
        if (!k) return { toast: 'Kategori tidak ditemukan.' };
        return {
          layar: {
            teks: `🗄️ Arsipkan <b>${esc(k.name)}</b>?\nTransaksi lama <b>tetap tersimpan</b> dengan kategori ini. Kategori hanya tidak muncul lagi di pilihan baru. Bisa diaktifkan lagi dengan membuat kategori bernama sama.`,
            tombol: [[tombolData('✅ Ya, Arsipkan', `k:ar2:${k.id}`), tombolData('❌ Batal', `k:v:${k.id}:0`)]],
          },
        };
      }
      case 'ar2': {
        const k = getCategory(Number(a), database);
        if (!k) return { toast: 'Kategori tidak ditemukan.' };
        if (k.active) deactivateCategory(k.id, 'telegram', database);
        return { toast: 'Diarsipkan', layar: layarDaftarKategori(0, database) };
      }

      case 'mg': {
        const dari = Number(a);
        const k = getCategory(dari, database);
        if (!k) return { toast: 'Kategori tidak ditemukan.' };
        const kandidat = semuaKategoriAktif(database).filter((x) => x.id !== dari);
        const h = potongHalaman(kandidat, Number(b ?? 0), PER_HALAMAN);
        const baris: Tombol[][] = grid(h.item.map((x) => tombolData(`${x.icon ?? '🏷️'} ${x.name}`, `k:mgc:${dari}:${x.id}`)), 2);
        const nav = barisHalaman(h, (p) => `k:mg:${dari}:${p}`);
        if (nav.length) baris.push(nav);
        baris.push(navigasi(`k:v:${dari}:0`));
        return { layar: { teks: `🔀 Gabungkan <b>${esc(k.name)}</b> ke kategori mana?`, tombol: baris } };
      }
      case 'mgc': {
        const dari = getCategory(Number(a), database);
        const ke = getCategory(Number(b), database);
        if (!dari || !ke) return { toast: 'Kategori tidak ditemukan.' };
        return {
          layar: {
            teks: `🔀 Gabungkan <b>${esc(dari.name)}</b> → <b>${esc(ke.name)}</b>?\nSemua transaksi, anggaran, dan aturan merchant dipindahkan ke <b>${esc(ke.name)}</b>. Kategori <b>${esc(dari.name)}</b> diarsipkan (tidak dihapus) dan semua laporan ikut berubah.`,
            tombol: [[tombolData('✅ Ya, Gabungkan', `k:mgx:${dari.id}:${ke.id}`), tombolData('❌ Batal', `k:v:${dari.id}:0`)]],
          },
        };
      }
      case 'mgx': {
        const dari = Number(a);
        const ke = Number(b);
        const aktif = getCategory(dari, database);
        if (!aktif || !aktif.active) return { toast: 'Sudah digabung.', layar: layarDaftarKategori(0, database) };
        const h = gabungKategori(dari, ke, 'telegram', database);
        return {
          toast: 'Digabung',
          layar: {
            teks: `✅ <b>${esc(h.dari)}</b> digabung ke <b>${esc(h.ke)}</b>.\n${h.dipindah_transaksi} transaksi dan ${h.anggaran} anggaran dipindahkan.`,
            tombol: [[tombolData('📂 Daftar Kategori', 'k:l:0')], [MENU_UTAMA]],
          },
        };
      }
      default:
        return { toast: 'Tombol ini tidak dikenali.' };
    }
  } catch (err) {
    if (err instanceof CategoryError) return { toast: err.message.slice(0, 180) };
    return { toast: (err as Error).message.slice(0, 180) };
  }
}

function getStateKat(ctx: Konteks, database: DB): StateKategoriBaru | null {
  const st = getState(ctx.chatId, 'utama', database);
  return st && st.t === 'kat_baru' ? (st as StateKategoriBaru) : null;
}
