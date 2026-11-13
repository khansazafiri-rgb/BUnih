/**
 * /catat — pencatatan manual bertahap, dan pencatatan dari kalimat bebas
 * ("Bayar makan 35rb di kantin pakai Mandiri").
 *
 * Aturan keselamatan:
 *  - rekening sumber yang tidak diketahui TIDAK dipilihkan otomatis: pengguna memilih, atau menandainya
 *    "belum teridentifikasi" (tercatat, tetapi ditandai perlu verifikasi);
 *  - kalimat bebas selalu berakhir di kartu konfirmasi sebelum disimpan;
 *  - penyimpanan lewat `buatTransaksi`, sehingga dedupe 120 detik dan audit berlaku sama seperti web.
 *
 * Draft disimpan di slot 'catat' (SQLite). Callback: c:<aksi>[:arg]
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../../db/index.js';
import { listAccounts } from '../../domain/balances.js';
import { getCategory } from '../../domain/categories.js';
import { buatTransaksi, TransaksiError, type TransaksiBaru } from '../../domain/manualTx.js';
import { formatIDR } from '../../domain/money.js';
import { rebuildObligations } from '../../domain/obligations.js';
import { addDays, formatTanggal, today } from '../../domain/time.js';
import { esc } from '../format.js';
import { cariKategori, uraiMerchantProyek } from '../analitikBot.js';
import { detectIntent, parseRupiah, tebakKategori } from '../nlu.js';
import { clearState, getState, setState, type TgState } from '../state.js';
import { kategoriPopuler } from './transaksiUi.js';
import { semuaKategoriAktif } from './transaksiUi.js';
import { MENU_UTAMA, barisHalaman, grid, navigasi, potongHalaman, tombolData, type Hasil, type Konteks, type Layar, type Tombol } from './layar.js';

export type JenisCatat = 'pengeluaran' | 'pemasukan' | 'transfer' | 'reimburse';

export type DraftCatat = TgState & {
  t: 'catat';
  jenis: JenisCatat;
  step: 'nominal' | 'rekening' | 'rekening_tujuan' | 'merchant' | 'kategori' | 'proyek' | 'konfirmasi';
  nominal?: number;
  rekeningId?: number | null;
  tunai?: boolean;
  belumJelas?: boolean;
  tujuanId?: number | null;
  merchant?: string | null;
  kategoriId?: number | null;
  proyek?: string | null;
  tanggal?: string | null;
  /** Dari kalimat bebas: kategori ditebak, bukan dipilih pengguna. */
  ditebak?: boolean;
};

const JUDUL: Record<JenisCatat, string> = {
  pengeluaran: '💸 Mencatat pengeluaran',
  pemasukan: '💰 Mencatat pemasukan',
  transfer: '🔁 Transfer antarrekeningku',
  reimburse: '🧾 Catat reimburse (kubayar dulu, company mengganti)',
};

const SLOT = 'catat';
const kapital = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const tombolBatal: Tombol = tombolData('❌ Batalkan', 'c:x');

export function getDraft(ctx: Konteks, database: DB = db()): DraftCatat | null {
  const st = getState(ctx.chatId, SLOT, database);
  return st && st.t === 'catat' ? (st as DraftCatat) : null;
}
function simpanDraft(ctx: Konteks, d: DraftCatat, database: DB): void {
  setState(ctx.chatId, d, SLOT, 60, database);
}
export function hapusDraft(ctx: Konteks, database: DB = db()): void {
  clearState(ctx.chatId, SLOT, database);
}

/* ------------------------------------------------------------------ layar */

export function layarMenuCatat(): Layar {
  return {
    teks: '➕ <b>Catat transaksi</b>\nMau mencatat apa? Atau tulis saja langsung, misalnya <i>"makan 35rb di kantin pakai Mandiri"</i>.',
    tombol: [
      [tombolData('💸 Mencatat Pengeluaran', 'c:j:pengeluaran'), tombolData('💰 Mencatat Pemasukan', 'c:j:pemasukan')],
      [tombolData('🔁 Transfer Sendiri', 'c:j:transfer'), tombolData('🧾 Catat Reimburse', 'c:j:reimburse')],
      [MENU_UTAMA],
    ],
  };
}

function layarPilihRekening(d: DraftCatat, tujuan: boolean, database: DB): Layar {
  const akun = listAccounts(database, true).filter((a) => !tujuan || a.id !== d.rekeningId);
  const baris: Tombol[][] = grid(akun.map((a) => tombolData(`🏦 ${a.name}`, `c:${tujuan ? 't' : 'a'}:${a.id}`)), 2);
  if (!tujuan) {
    const lain: Tombol[] = [tombolData('💵 Tunai', 'c:a:tunai')];
    if (d.jenis !== 'transfer') lain.push(tombolData('❓ Belum Teridentifikasi', 'c:a:x'));
    baris.push(lain);
  }
  baris.push([tombolBatal]);
  return {
    teks: `${JUDUL[d.jenis]}\n${d.nominal ? `Nominal: <b>${esc(formatIDR(d.nominal))}</b>\n` : ''}${tujuan ? 'Ditransfer <b>ke</b> rekening mana?' : d.jenis === 'pemasukan' ? 'Masuk ke rekening mana?' : d.jenis === 'transfer' ? 'Dari rekening mana?' : 'Dibayar pakai rekening mana?'}`,
    tombol: baris,
  };
}

function layarPilihKategori(d: DraftCatat, halaman: number | null, database: DB): Layar {
  let baris: Tombol[][];
  if (halaman === null) {
    const pop = kategoriPopuler(8, database);
    baris = grid(pop.map((k) => tombolData(`${k.icon ?? '🏷️'} ${k.name}`, `c:k:${k.id}`)), 2);
    baris.push([tombolData('📂 Semua Kategori', 'c:kp:0'), tombolData('➕ Kategori Baru', 'c:kn')]);
  } else {
    const h = potongHalaman(semuaKategoriAktif(database), halaman, 8);
    baris = grid(h.item.map((k) => tombolData(`${k.icon ?? '🏷️'} ${k.name}`, `c:k:${k.id}`)), 2);
    const nav = barisHalaman(h, (p) => `c:kp:${p}`);
    if (nav.length) baris.push(nav);
    baris.push([tombolData('➕ Kategori Baru', 'c:kn')]);
  }
  baris.push([tombolData('⏭️ Tanpa Kategori', 'c:k:0'), tombolBatal]);
  return { teks: `${JUDUL[d.jenis]}\nNominal: <b>${esc(formatIDR(d.nominal ?? 0))}</b>\nUntuk apa? Pilih kategori:`, tombol: baris };
}

function namaRekening(id: number | null | undefined, database: DB): string | null {
  if (!id) return null;
  return (database.prepare(`SELECT name FROM account WHERE id = ?`).get(id) as { name: string } | undefined)?.name ?? null;
}

export function layarKonfirmasi(d: DraftCatat, database: DB): Layar {
  const kat = d.kategoriId ? getCategory(d.kategoriId, database) : null;
  const rek = d.tunai ? 'Tunai' : d.belumJelas ? 'belum teridentifikasi (ditandai perlu verifikasi)' : namaRekening(d.rekeningId, database) ?? '—';
  const tgl = d.tanggal ? formatTanggal(d.tanggal) : `${formatTanggal(today())} (hari ini)`;
  const baris = [
    JUDUL[d.jenis],
    `Nominal: <b>${esc(formatIDR(d.nominal ?? 0))}</b>`,
    d.jenis === 'transfer'
      ? `Dari: ${esc(rek)} → ke: ${esc(namaRekening(d.tujuanId, database) ?? '—')}`
      : `Rekening: ${esc(rek)}`,
    d.jenis !== 'transfer' ? `Merchant: ${d.merchant ? esc(d.merchant) : '—'}` : null,
    d.jenis !== 'transfer' && d.jenis !== 'pemasukan' ? `Kategori: ${kat ? `${esc(kat.icon ?? '🏷️')} ${esc(kat.name)}${d.ditebak ? ' <i>(usulan)</i>' : ''}` : '—'}` : null,
    d.proyek ? `Proyek: ${esc(d.proyek)}` : null,
    d.jenis === 'reimburse' ? 'Penanggung akhir: Company (kamu bayar dulu)' : null,
    `Tanggal: ${esc(tgl)}`,
    '',
    'Simpan transaksi ini?',
  ].filter((x): x is string => x !== null);
  const sunting: Tombol[] = [];
  if (d.jenis !== 'transfer') sunting.push(tombolData('🏪 Merchant', 'c:em'));
  if (d.jenis === 'pengeluaran' || d.jenis === 'reimburse') sunting.push(tombolData('📂 Kategori', 'c:ek'));
  sunting.push(tombolData('🏦 Rekening', 'c:er'));
  return { teks: baris.join('\n'), tombol: [[tombolData('✅ Simpan', 'c:ok')], sunting, [tombolBatal]] };
}

function layarTanyaTeks(d: DraftCatat, pertanyaan: string, bisaLewati: boolean): Layar {
  const b: Tombol[] = [];
  if (bisaLewati) b.push(tombolData('⏭️ Lewati', 'c:skip'));
  b.push(tombolBatal);
  return { teks: `${JUDUL[d.jenis]}\n${pertanyaan}`, tombol: [b] };
}

/** Tentukan langkah berikutnya berdasarkan apa yang masih kosong. */
export function langkahBerikut(d: DraftCatat, ctx: Konteks, database: DB): Hasil {
  const perluRekening = d.rekeningId === undefined && !d.tunai && !d.belumJelas;
  if (!d.nominal) {
    d.step = 'nominal';
    simpanDraft(ctx, d, database);
    return { layar: layarTanyaTeks(d, 'Berapa nominalnya? Contoh: 35rb atau 1,5jt', false) };
  }
  if (perluRekening) {
    d.step = 'rekening';
    simpanDraft(ctx, d, database);
    return { layar: layarPilihRekening(d, false, database) };
  }
  if (d.jenis === 'transfer' && !d.tujuanId) {
    d.step = 'rekening_tujuan';
    simpanDraft(ctx, d, database);
    return { layar: layarPilihRekening(d, true, database) };
  }
  if (d.jenis !== 'transfer' && d.merchant === undefined) {
    d.step = 'merchant';
    simpanDraft(ctx, d, database);
    return { layar: layarTanyaTeks(d, 'Di mana / dari siapa? Contoh: Kantin Kampus', true) };
  }
  if ((d.jenis === 'pengeluaran' || d.jenis === 'reimburse') && d.kategoriId === undefined) {
    d.step = 'kategori';
    simpanDraft(ctx, d, database);
    return { layar: layarPilihKategori(d, null, database) };
  }
  if (d.jenis === 'reimburse' && d.proyek === undefined) {
    d.step = 'proyek';
    simpanDraft(ctx, d, database);
    return { layar: layarTanyaTeks(d, 'Untuk proyek apa? Contoh: MEDCOEL', true) };
  }
  d.step = 'konfirmasi';
  simpanDraft(ctx, d, database);
  return { layar: layarKonfirmasi(d, database) };
}

/* ------------------------------------------------------------------ dari kalimat bebas */

function kenaliRekening(teks: string, database: DB): { id: number; nama: string } | null {
  const t = teks.toLowerCase();
  const kena = listAccounts(database, true).filter((a) => {
    const kata = a.name.toLowerCase().split(/[\s']+/)[0]!;
    return kata.length >= 3 && new RegExp(`\\b${kata}\\b`).test(t);
  });
  return kena.length === 1 ? { id: kena[0]!.id, nama: kena[0]!.name } : null;
}

/**
 * Buat draft dari kalimat bebas. Mengembalikan null bila kalimat itu bukan pencatatan transaksi.
 * Tidak menyimpan apa pun ke tabel transaksi; hanya draft yang perlu dikonfirmasi.
 */
export function mulaiDariTeks(teks: string, ctx: Konteks, database: DB = db()): Hasil | null {
  const nlu = detectIntent(teks);
  if (nlu.intent !== 'catat_pengeluaran' && nlu.intent !== 'catat_pemasukan') return null;
  if (!nlu.nominal_minor) return null;

  const urai = uraiMerchantProyek(teks);
  const rek = kenaliRekening(teks, database);
  const draft: DraftCatat = {
    t: 'catat',
    jenis: nlu.intent === 'catat_pemasukan' ? 'pemasukan' : 'pengeluaran',
    step: 'konfirmasi',
    nominal: nlu.nominal_minor,
    merchant: urai.merchant ? kapital(urai.merchant) : undefined,
    proyek: urai.proyek ?? undefined,
    tanggal: nlu.tanggal_relatif === 'kemarin' ? addDays(today(), -1) : null,
  };
  if (rek) draft.rekeningId = rek.id;

  if (draft.jenis === 'pengeluaran') {
    // 1) kategori bawaan merchant yang sudah dikenal, 2) kata di kalimat, 3) tebakan kata kunci umum.
    let kategoriId: number | undefined;
    if (urai.merchant) {
      const m = database
        .prepare(`SELECT default_category_id FROM merchant WHERE active = 1 AND name_norm = ?`)
        .get(urai.merchant.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) as { default_category_id: number | null } | undefined;
      if (m?.default_category_id) kategoriId = m.default_category_id;
    }
    if (!kategoriId) {
      const sebutan = cariKategori(teks.replace(/\d+\s*(?:rb|ribu|k|jt|juta)?/gi, ' '), database);
      if (sebutan.length === 1) kategoriId = sebutan[0]!.id;
    }
    if (!kategoriId) {
      const slug = tebakKategori(teks.toLowerCase());
      if (slug) kategoriId = (database.prepare(`SELECT id FROM category WHERE slug = ? AND active = 1`).get(slug) as { id: number } | undefined)?.id;
    }
    if (kategoriId) {
      draft.kategoriId = kategoriId;
      draft.ditebak = true;
    } else draft.kategoriId = undefined;
  } else draft.kategoriId = null;
  if (draft.merchant === undefined) draft.merchant = undefined;

  // Dari kalimat bebas, merchant yang tidak disebut tidak ditanyakan lagi; boleh kosong.
  if (draft.merchant === undefined) draft.merchant = null;
  const h = langkahBerikut(draft, ctx, database);
  return { ...h, baru: true };
}

/* ------------------------------------------------------------------ teks balasan pada draft */

export function tanganiTeksCatat(teks: string, ctx: Konteks, database: DB = db()): Hasil | null {
  const d = getDraft(ctx, database);
  if (!d) return null;
  const t = teks.trim();
  switch (d.step) {
    case 'nominal': {
      const n = parseRupiah(t.toLowerCase()) ?? (/^\d{3,}$/.test(t) ? Number(t) : null);
      if (!n || n <= 0) return { baru: true, layar: layarTanyaTeks(d, 'Aku belum menangkap nominalnya. Tulis misalnya 35rb atau 1,5jt.', false) };
      d.nominal = n;
      return { ...langkahBerikut(d, ctx, database), baru: true };
    }
    case 'merchant': {
      d.merchant = t.length > 60 ? t.slice(0, 60) : kapital(t);
      return { ...langkahBerikut(d, ctx, database), baru: true };
    }
    case 'proyek': {
      d.proyek = t.slice(0, 30);
      return { ...langkahBerikut(d, ctx, database), baru: true };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ callback */

export function tanganiCatat(parts: string[], ctx: Konteks, database: DB = db()): Hasil {
  const aksi = parts[1] ?? '';
  const arg = parts[2];

  if (aksi === 'menu') {
    hapusDraft(ctx, database);
    return { layar: layarMenuCatat() };
  }
  if (aksi === 'j') {
    const jenis = arg as JenisCatat;
    if (!['pengeluaran', 'pemasukan', 'transfer', 'reimburse'].includes(jenis)) return { toast: 'Pilihan tidak dikenal.' };
    const d: DraftCatat = { t: 'catat', jenis, step: 'nominal' };
    return langkahBerikut(d, ctx, database);
  }
  if (aksi === 'x') {
    hapusDraft(ctx, database);
    return { toast: 'Dibatalkan', layar: { teks: '❌ Pencatatan dibatalkan. Tidak ada yang disimpan.', tombol: [[tombolData('➕ Catat Lagi', 'c:menu')], [MENU_UTAMA]] } };
  }

  const d = getDraft(ctx, database);
  if (!d) return { toast: 'Sesi pencatatan sudah berakhir atau sudah diproses.', hapusTombol: true };

  try {
    switch (aksi) {
      case 'a':
        if (arg === 'tunai') { d.tunai = true; d.rekeningId = null; d.belumJelas = false; }
        else if (arg === 'x') { d.belumJelas = true; d.rekeningId = null; d.tunai = false; }
        else { d.rekeningId = Number(arg); d.tunai = false; d.belumJelas = false; }
        return langkahBerikut(d, ctx, database);
      case 't':
        d.tujuanId = Number(arg);
        return langkahBerikut(d, ctx, database);
      case 'skip':
        if (d.step === 'merchant') d.merchant = null;
        else if (d.step === 'proyek') d.proyek = null;
        return langkahBerikut(d, ctx, database);
      case 'k':
        d.kategoriId = Number(arg) || null;
        d.ditebak = false;
        return langkahBerikut(d, ctx, database);
      case 'kp':
        return { layar: layarPilihKategori(d, Number(arg ?? 0), database) };
      case 'kn':
        // Alur kategori baru memakai slot utama; setelah selesai, draft ini dilanjutkan.
        setState(ctx.chatId, { t: 'kat_baru', step: 'nama', lanjut: 'catat', balik: 'c:ek' }, 'utama', 45, database);
        return { layar: { teks: '➕ <b>Kategori baru</b>\nKategori baru mau diberi nama apa?', tombol: [[tombolData('❌ Batal', 'k:cancel')]] } };
      case 'ek':
        d.step = 'kategori';
        simpanDraft(ctx, d, database);
        return { layar: layarPilihKategori(d, null, database) };
      case 'er':
        d.step = 'rekening';
        d.rekeningId = undefined; d.tunai = false; d.belumJelas = false;
        simpanDraft(ctx, d, database);
        return { layar: layarPilihRekening(d, false, database) };
      case 'em':
        d.step = 'merchant';
        simpanDraft(ctx, d, database);
        return { layar: layarTanyaTeks(d, 'Di mana / dari siapa? Contoh: Kantin Kampus', true) };
      case 'ok':
        return simpan(d, ctx, database);
      default:
        return { toast: 'Tombol ini tidak dikenali.' };
    }
  } catch (err) {
    return { toast: (err as Error).message.slice(0, 180) };
  }
}

/** Dipanggil setelah kategori baru dibuat dari alur /catat. */
export function setelahKategoriBaru(kategoriId: number, ctx: Konteks, database: DB = db()): Hasil | null {
  const d = getDraft(ctx, database);
  if (!d) return null;
  d.kategoriId = kategoriId;
  d.ditebak = false;
  return { toast: 'Kategori dibuat', ...langkahBerikut(d, ctx, database) };
}

function simpan(d: DraftCatat, ctx: Konteks, database: DB): Hasil {
  // Idempoten terhadap tekan ganda: draft dihapus sebelum menyimpan; tekan kedua melihat "sesi berakhir".
  hapusDraft(ctx, database);
  const waktu = d.tanggal ? `${d.tanggal}T12:00` : undefined;
  const dasar: TransaksiBaru = {
    jenis: d.jenis === 'pemasukan' ? 'pemasukan' : d.jenis === 'transfer' ? 'transfer_sendiri' : 'pengeluaran',
    jumlah_minor: d.nominal ?? 0,
    waktu,
    rekening_id: d.rekeningId ?? null,
    tunai: d.tunai ?? false,
    rekening_belum_jelas: d.belumJelas ?? false,
    merchant: d.merchant ?? null,
    kategori_id: d.kategoriId ?? null,
    proyek: d.proyek ?? null,
    tujuan_rekening_id: d.tujuanId ?? null,
    ...(d.jenis === 'reimburse' ? { penanggung: 'company_bayar_dulu' as const } : {}),
  };
  try {
    const hasil = buatTransaksi(dasar, 'telegram', database);
    try { rebuildObligations({}, database); } catch { /* proyeksi dibangun ulang pada siklus berikutnya */ }
    return {
      toast: 'Tersimpan',
      layar: {
        teks: `✅ <b>Tersimpan</b> (#${hasil.id})\n${hasil.pesan.map(esc).join('\n')}`.trim(),
        tombol: [[tombolData('📄 Lihat & Ubah', `t:v:${hasil.id}`)], [tombolData('➕ Catat Lagi', 'c:menu'), MENU_UTAMA]],
      },
    };
  } catch (err) {
    const pesan = err instanceof TransaksiError ? err.message : (err as Error).message;
    // Pulihkan draft supaya pengguna bisa memperbaiki, bukan mengulang dari awal.
    setState(ctx.chatId, d, SLOT, 60, database);
    return { toast: 'Belum bisa disimpan', layar: { teks: `⚠️ ${esc(pesan)}`, tombol: [[tombolData('🏦 Ganti Rekening', 'c:er')], [tombolBatal]] } };
  }
}
