/**
 * /transaksi: kartu transaksi terbaru, atau daftar hasil pencarian berdasarkan kategori, merchant,
 * tanggal, rekening, dan nominal. Contoh: "/transaksi makan kemarin mandiri 35rb".
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../../db/index.js';
import { listAccounts } from '../../domain/balances.js';
import { categorySubtreeIds } from '../../domain/categories.js';
import { formatIDR } from '../../domain/money.js';
import { addDays, dateOf, formatTanggalSingkat, today, type IsoDate } from '../../domain/time.js';
import { esc } from '../format.js';
import { cariKategori } from '../analitikBot.js';
import { hapusNominal, parseRupiah } from '../nlu.js';
import { getState, setState } from '../state.js';
import { layarKartu } from './transaksiUi.js';
import { MENU_UTAMA, barisHalaman, navigasi, potongHalaman, tombolData, type Hasil, type Konteks, type Layar, type Tombol } from './layar.js';

export type FilterTx = {
  kategoriId?: number;
  kategoriNama?: string;
  teks?: string;
  dari?: IsoDate;
  sampai?: IsoDate;
  rekeningId?: number;
  rekeningNama?: string;
  nominal?: number;
  tanpaKategori?: boolean;
};

const PER_HALAMAN = 6;

/** Ubah kalimat pencarian menjadi filter. Bagian yang tidak dikenali menjadi kata kunci merchant/catatan. */
export function parseFilter(teks: string, database: DB, hariIni: IsoDate = today()): FilterTx {
  let sisa = ` ${teks.toLowerCase()} `;
  const f: FilterTx = {};

  if (/\bbelum (?:ada )?(?:dikategorikan|kategori)\b/.test(sisa) || /\btanpa kategori\b/.test(sisa)) {
    f.tanpaKategori = true;
    sisa = sisa.replace(/\b(belum (?:ada )?(?:dikategorikan|kategori)|tanpa kategori)\b/g, ' ');
  }

  const iso = sisa.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) { f.dari = f.sampai = iso[1]!; sisa = sisa.replace(iso[0], ' '); }
  else if (/\bkemarin\b/.test(sisa)) { f.dari = f.sampai = addDays(hariIni, -1); sisa = sisa.replace(/\bkemarin\b/g, ' '); }
  else if (/\bhari ini\b/.test(sisa)) { f.dari = f.sampai = hariIni; sisa = sisa.replace(/\bhari ini\b/g, ' '); }
  else if (/\bminggu ini\b/.test(sisa)) { f.dari = addDays(hariIni, -6); f.sampai = hariIni; sisa = sisa.replace(/\bminggu ini\b/g, ' '); }
  else if (/\bbulan ini\b/.test(sisa)) { f.dari = `${hariIni.slice(0, 7)}-01`; f.sampai = hariIni; sisa = sisa.replace(/\bbulan ini\b/g, ' '); }
  else {
    const dm = sisa.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
    if (dm) {
      const y = dm[3] ?? hariIni.slice(0, 4);
      f.dari = f.sampai = `${y}-${dm[2]!.padStart(2, '0')}-${dm[1]!.padStart(2, '0')}`;
      sisa = sisa.replace(dm[0], ' ');
    }
  }

  for (const a of listAccounts(database, true)) {
    const nm = a.name.toLowerCase().split(/[\s']+/)[0]!;
    if (nm.length >= 3 && new RegExp(`\\b${nm}\\b`).test(sisa)) {
      f.rekeningId = a.id;
      f.rekeningNama = a.name;
      sisa = sisa.replace(new RegExp(`\\b${nm}\\b`, 'g'), ' ');
      break;
    }
  }

  const nom = parseRupiah(sisa);
  if (nom && nom >= 1000) {
    f.nominal = nom;
    sisa = hapusNominal(sisa);
  }

  const kat = cariKategori(sisa, database);
  if (kat.length === 1) {
    f.kategoriId = kat[0]!.id;
    f.kategoriNama = kat[0]!.name;
    for (const kata of kat[0]!.name.toLowerCase().split(/\s+/)) sisa = sisa.replace(new RegExp(`\\b${kata}\\b`, 'g'), ' ');
  }

  const kunci = sisa.replace(/\b(transaksi|cari|di|dari|pada|yang|untuk)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (kunci) f.teks = kunci;
  return f;
}

export function ringkasFilter(f: FilterTx): string {
  const p: string[] = [];
  if (f.kategoriNama) p.push(`kategori ${f.kategoriNama}`);
  if (f.tanpaKategori) p.push('belum dikategorikan');
  if (f.teks) p.push(`"${f.teks}"`);
  if (f.rekeningNama) p.push(`rekening ${f.rekeningNama}`);
  if (f.nominal) p.push(formatIDR(f.nominal));
  if (f.dari) p.push(f.dari === f.sampai ? f.dari : `${f.dari} s/d ${f.sampai}`);
  return p.length ? p.join(' · ') : 'semua transaksi';
}

type BarisTx = { id: number; occurred_at: string; direction: string; amount_minor: number; merchant: string | null; kategori: string | null; ikon: string | null };

export function cariTransaksi(f: FilterTx, halaman: number, database: DB = db()): { baris: BarisTx[]; total: number; halaman: number; jumlahHalaman: number } {
  const where: string[] = [`ce.status <> 'dibatalkan'`];
  const params: unknown[] = [];
  if (f.dari) { where.push(`date(ce.occurred_at) >= ?`); params.push(f.dari); }
  if (f.sampai) { where.push(`date(ce.occurred_at) <= ?`); params.push(f.sampai); }
  if (f.rekeningId) { where.push(`ce.account_id = ?`); params.push(f.rekeningId); }
  if (f.nominal) { where.push(`ce.amount_minor = ?`); params.push(f.nominal); }
  if (f.tanpaKategori) where.push(`ce.category_id IS NULL AND ce.direction = 'keluar' AND ce.kind NOT IN ('transfer_internal','setoran_tabungan')`);
  if (f.kategoriId) {
    const ids = categorySubtreeIds(f.kategoriId, database);
    where.push(`ce.category_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (f.teks) {
    where.push(`(ce.merchant_raw LIKE ? OR ce.note LIKE ? OR ce.counterparty LIKE ? OR mc.name LIKE ?)`);
    const like = `%${f.teks}%`;
    params.push(like, like, like, like);
  }
  const dasar = `FROM cash_event ce LEFT JOIN merchant mc ON mc.id = ce.merchant_id LEFT JOIN category c ON c.id = ce.category_id WHERE ${where.join(' AND ')}`;
  const total = (database.prepare(`SELECT COUNT(*) AS n ${dasar}`).get(...params) as { n: number }).n;
  const h = potongHalaman(new Array(total).fill(0), halaman, PER_HALAMAN);
  const baris = database
    .prepare(
      `SELECT ce.id, ce.occurred_at, ce.direction, ce.amount_minor, COALESCE(mc.name, ce.merchant_raw, ce.counterparty) AS merchant,
              c.name AS kategori, c.icon AS ikon
         ${dasar} ORDER BY ce.occurred_at DESC, ce.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, PER_HALAMAN, h.halaman * PER_HALAMAN) as BarisTx[];
  return { baris, total, halaman: h.halaman, jumlahHalaman: h.jumlahHalaman };
}

function singkat(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}jt`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}rb`;
  return String(n);
}

export function layarHasil(f: FilterTx, halaman: number, database: DB = db()): Layar {
  const r = cariTransaksi(f, halaman, database);
  if (r.total === 0) {
    return {
      teks: `🔍 Tidak ada transaksi untuk: ${esc(ringkasFilter(f))}.\nCoba kata lain, atau ketik /transaksi saja untuk yang terbaru.`,
      tombol: [navigasi()],
    };
  }
  const baris: Tombol[][] = r.baris.map((b) => [
    tombolData(
      `${b.direction === 'keluar' ? '−' : '+'}${singkat(b.amount_minor)} · ${(b.merchant ?? 'tanpa nama').slice(0, 16)} · ${formatTanggalSingkat(dateOf(b.occurred_at))}${b.kategori ? ` · ${(b.ikon ?? '')}${b.kategori.slice(0, 10)}` : ''}`.slice(0, 60),
      `t:v:${b.id}:L${r.halaman}`,
    ),
  ]);
  const nav = barisHalaman({ item: [], halaman: r.halaman, total: r.total, jumlahHalaman: r.jumlahHalaman }, (p) => `t:l:${p}`);
  if (nav.length) baris.push(nav);
  baris.push([MENU_UTAMA]);
  return { teks: `🔍 <b>${r.total} transaksi</b> — ${esc(ringkasFilter(f))}\nKetuk salah satu untuk membuka dan mengubahnya.`, tombol: baris };
}

/** Dipanggil oleh /transaksi [kata kunci]. */
export function mulaiTransaksi(argumen: string, ctx: Konteks, database: DB = db()): Hasil {
  const a = argumen.trim();
  if (!a) {
    const terbaru = database.prepare(`SELECT id FROM cash_event WHERE status <> 'dibatalkan' ORDER BY occurred_at DESC, id DESC LIMIT 1`).get() as { id: number } | undefined;
    if (!terbaru) {
      return { baru: true, layar: { teks: '🧾 Belum ada transaksi. Catat yang pertama dengan /catat.', tombol: [[tombolData('➕ Catat', 'c:menu')], [MENU_UTAMA]] } };
    }
    return { baru: true, layar: layarKartu(terbaru.id, {}, database) };
  }
  const f = parseFilter(a, database);
  setState(ctx.chatId, { t: 'cari_filter', filter: f }, 'cari', 24 * 60, database);
  return { baru: true, layar: layarHasil(f, 0, database) };
}

export function halamanHasil(halaman: number, ctx: Konteks, database: DB = db()): Hasil {
  const st = getState<{ t: string; filter?: FilterTx }>(ctx.chatId, 'cari', database);
  if (!st?.filter) return { toast: 'Pencarian sudah kedaluwarsa. Ketik /transaksi lagi.', layar: { teks: 'Pencarian sudah kedaluwarsa. Ketik /transaksi untuk mencari lagi.', tombol: [[MENU_UTAMA]] } };
  return { layar: layarHasil(st.filter, halaman, database) };
}
