/**
 * Anggaran (/anggaran) dan target keuangan (/target) dari Telegram.
 *
 * Contoh teks yang dipahami:
 *   "Buat anggaran Pacaran Rp500 ribu per bulan"
 *   "Target laptop Rp8 juta sebelum Juni 2027"
 *
 * Semua angka berasal dari modul `budgets` dan `goals` yang sama dengan web. Menyisihkan uang untuk
 * target hanyalah penanda: tidak ada transaksi yang dibuat dan tidak ada uang yang berpindah.
 *
 * Callback: a:<aksi>... (anggaran), g:<aksi>... (target)
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../../db/index.js';
import { BudgetError, createBudget, listBudgets, reviseBudget, updateBudget, type BudgetEval, type BudgetPeriod } from '../../domain/budgets.js';
import { getCategory } from '../../domain/categories.js';
import { buatAtauPakaiKategori, cariKategoriPersis } from '../../domain/categoryOps.js';
import { GoalError, addContribution, listGoals, updateGoal, type GoalEval } from '../../domain/goals.js';
import { formatIDR } from '../../domain/money.js';
import { formatTanggal, startOfMonth, startOfWeek, today } from '../../domain/time.js';
import { esc, ringkasanAnggaran } from '../format.js';
import { cariKategori, parseTujuan, pertanyaanTujuan, simpanTujuan, type DraftTujuan } from '../analitikBot.js';
import { hapusNominal, parseRupiah } from '../nlu.js';
import { clearState, getState, setState, type TgState } from '../state.js';
import { MENU_UTAMA, grid, navigasi, tombolData, type Hasil, type Konteks, type Layar, type Tombol } from './layar.js';
import { semuaKategoriAktif } from './transaksiUi.js';

const rp = (n: number) => esc(formatIDR(n));

/* ================================================================== ANGGARAN */

export type DraftAnggaran = {
  kategoriId: number | null;
  /** Nama kategori yang belum ada dan akan dibuat saat disimpan. */
  buatKategori?: string | null;
  nama: string;
  nominal: number;
  periode: BudgetPeriod;
};

const LABEL_PERIODE: Record<BudgetPeriod, string> = { harian: 'per hari', mingguan: 'per minggu', bulanan: 'per bulan', kustom: 'kustom' };

export function adalahPermintaanAnggaran(teks: string): boolean {
  const t = teks.toLowerCase();
  return /\b(buat|bikin|atur|set|tambah|tambahkan|pasang)\b.*\b(anggaran|budget|batas)\b/.test(t) || /^\s*(?:anggaran|budget)\s+[a-z].*\d/.test(t);
}

/** Uraikan kalimat menjadi draft. Mengembalikan pertanyaan bila ada bagian yang kurang. */
export function parseAnggaran(teks: string, database: DB, kategoriTetap?: number): { draft?: DraftAnggaran; tanya?: string } {
  const t = teks.toLowerCase();
  const nominal = parseRupiah(t);
  if (!nominal || nominal <= 0) return { tanya: 'Berapa batasnya? Contoh: "Buat anggaran Makan Rp900 ribu per bulan".' };
  const periode: BudgetPeriod = /\b(per ?hari|harian|sehari)\b/.test(t) ? 'harian' : /\b(per ?minggu|mingguan|seminggu|per ?pekan)\b/.test(t) ? 'mingguan' : 'bulanan';

  if (kategoriTetap) {
    const k = getCategory(kategoriTetap, database);
    if (!k) return { tanya: 'Kategori itu tidak ditemukan.' };
    return { draft: { kategoriId: k.id, nama: k.name, nominal, periode } };
  }

  let nama = hapusNominal(t)
    .replace(/\b(buat|bikin|atur|set|tambah|tambahkan|pasang|anggaran|budget|batas|untuk|buat|sebesar|senilai|maksimal|maks)\b/g, ' ')
    .replace(/\b(per ?hari|harian|sehari|per ?minggu|mingguan|seminggu|per ?pekan|per ?bulan|bulanan|sebulan|tiap bulan|setiap bulan)\b/g, ' ')
    .replace(/[,.:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const keseluruhan = /^(total|semua|keseluruhan|semua pengeluaran|pengeluaran|bulanan|umum)?$/.test(nama);
  if (keseluruhan) return { draft: { kategoriId: null, nama: 'Semua pengeluaran', nominal, periode } };

  const persis = cariKategoriPersis(nama, {}, database);
  if (persis) return { draft: { kategoriId: persis.id, nama: persis.name, nominal, periode } };
  const mirip = cariKategori(nama, database);
  if (mirip.length === 1) return { draft: { kategoriId: mirip[0]!.id, nama: mirip[0]!.name, nominal, periode } };
  if (mirip.length > 1) {
    return { tanya: `Kategori mana yang kamu maksud? ${mirip.slice(0, 5).map((k) => k.name).join(', ')}. Tulis lagi dengan nama yang persis.` };
  }
  nama = nama.length > 40 ? nama.slice(0, 40) : nama;
  const rapi = nama.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return { draft: { kategoriId: null, buatKategori: rapi, nama: rapi, nominal, periode } };
}

function mulaiJendela(periode: BudgetPeriod): string {
  const h = today();
  return periode === 'mingguan' ? startOfWeek(h) : periode === 'bulanan' ? startOfMonth(h) : h;
}

function layarKonfirmasiAnggaran(d: DraftAnggaran, database: DB): Layar {
  const ada = d.kategoriId
    ? (database.prepare(`SELECT id FROM budget WHERE active = 1 AND category_id = ? AND period = ?`).get(d.kategoriId, d.periode) as { id: number } | undefined)
    : (database.prepare(`SELECT id FROM budget WHERE active = 1 AND category_id IS NULL AND period = ?`).get(d.periode) as { id: number } | undefined);
  const teks = [
    '🎯 <b>Anggaran baru</b>',
    `Untuk: <b>${esc(d.nama)}</b>${d.buatKategori ? ' <i>(kategori baru akan dibuat)</i>' : ''}`,
    `Batas: <b>${rp(d.nominal)}</b> ${LABEL_PERIODE[d.periode]}`,
    ada ? '\n⚠️ Sudah ada anggaran aktif untuk ini. Menyimpan akan <b>memperbarui nominalnya</b> (riwayat lama tetap tersimpan).' : '',
    '\nSimpan?',
  ].filter(Boolean).join('\n');
  return { teks, tombol: [[tombolData('✅ Simpan', 'a:ok'), tombolData('❌ Batal', 'a:x')]] };
}

export function mulaiDraftAnggaran(teks: string, ctx: Konteks, database: DB = db(), kategoriTetap?: number): Hasil {
  const { draft, tanya } = parseAnggaran(teks, database, kategoriTetap);
  if (!draft) {
    setState(ctx.chatId, { t: 'anggaran_teks', kategoriTetap: kategoriTetap ?? null }, 'utama', 45, database);
    return { baru: true, layar: { teks: `🎯 ${esc(tanya ?? '')}`, tombol: [[tombolData('❌ Batal', 'a:x')]] } };
  }
  setState(ctx.chatId, { t: 'anggaran_draft', draft } as TgState, 'utama', 45, database);
  return { baru: true, layar: layarKonfirmasiAnggaran(draft, database) };
}

export function layarAnggaran(database: DB = db()): Layar {
  const daftar = listBudgets({ asOf: today() }, database);
  const baris: Tombol[][] = grid(daftar.map((b) => tombolData(`${b.kategori_ikon ?? '🎯'} ${b.nama}`.slice(0, 32), `a:v:${b.id}`)), 2);
  baris.push([tombolData('➕ Buat Anggaran', 'a:new')]);
  baris.push(navigasi());
  const teks = daftar.length ? ringkasanAnggaran(database) : '🎯 <b>Anggaran</b>\nBelum ada anggaran. Ketuk "Buat Anggaran", atau tulis: <i>Buat anggaran Pacaran Rp500 ribu per bulan</i>.';
  return { teks, tombol: baris };
}

function layarDetailAnggaran(b: BudgetEval): Layar {
  const teks = [
    `🎯 <b>${esc(b.nama)}</b> — ${esc(b.periode)}`,
    `Terpakai ${rp(b.terpakai_minor)} dari ${rp(b.nominal_periode_minor + b.carry_minor)} (${Math.round(b.persen_terpakai)}%)`,
    `Sisa ${rp(Math.max(0, b.sisa_minor))}${b.hari_tersisa > 0 ? `, cukup ${rp(Math.max(0, b.sisa_per_hari_minor))} per hari untuk ${b.hari_tersisa} hari lagi` : ''}`,
    b.perkiraan_akhir_minor !== null ? `Perkiraan akhir periode: ${rp(b.perkiraan_akhir_minor)} <i>(estimasi, bukan pengeluaran sungguhan)</i>` : '<i>Perkiraan belum ditampilkan: data periode ini belum cukup.</i>',
    `Status: ${esc(b.status_teks)}`,
  ].join('\n');
  return {
    teks,
    tombol: [
      [tombolData('✏️ Ubah Nominal', `a:en:${b.id}`), tombolData('🗑️ Nonaktifkan', `a:nx:${b.id}`)],
      navigasi('a:l'),
    ],
  };
}

export function tanganiTeksAnggaran(state: TgState, teks: string, ctx: Konteks, database: DB = db()): Hasil {
  if (state.t === 'anggaran_teks') {
    const kt = (state['kategoriTetap'] as number | null) ?? undefined;
    return mulaiDraftAnggaran(kt ? teks : /anggaran|budget/i.test(teks) ? teks : `anggaran ${teks}`, ctx, database, kt);
  }
  if (state.t === 'anggaran_nominal') {
    const n = parseRupiah(teks.toLowerCase());
    if (!n) return { baru: true, layar: { teks: 'Nominalnya belum terbaca. Contoh: 1jt atau 750rb.', tombol: [[tombolData('❌ Batal', 'a:x')]] } };
    try {
      reviseBudget(Number(state['id']), n, { effective_from: today() }, 'telegram', database);
      clearState(ctx.chatId, 'utama', database);
      const b = listBudgets({ asOf: today() }, database).find((x) => x.id === Number(state['id']));
      return { baru: true, layar: b ? layarDetailAnggaran(b) : layarAnggaran(database) };
    } catch (err) {
      return { baru: true, layar: { teks: `⚠️ ${esc((err as Error).message)}`, tombol: [[tombolData('❌ Batal', 'a:x')]] } };
    }
  }
  return { baru: true, layar: layarAnggaran(database) };
}

export function tanganiAnggaran(parts: string[], ctx: Konteks, database: DB = db()): Hasil {
  const aksi = parts[1] ?? '';
  const id = Number(parts[2]);
  try {
    switch (aksi) {
      case 'l':
        clearState(ctx.chatId, 'utama', database);
        return { layar: layarAnggaran(database) };
      case 'new': {
        if (id) {
          setState(ctx.chatId, { t: 'anggaran_teks', kategoriTetap: id }, 'utama', 45, database);
          const k = getCategory(id, database);
          return { layar: { teks: `🎯 Anggaran untuk <b>${esc(k?.name ?? '')}</b>: berapa batasnya? Contoh: 500rb per bulan`, tombol: [[tombolData('❌ Batal', 'a:x')]] } };
        }
        setState(ctx.chatId, { t: 'anggaran_teks', kategoriTetap: null }, 'utama', 45, database);
        return {
          layar: {
            teks: '🎯 <b>Buat anggaran</b>\nTulis anggarannya, misalnya:\n• <i>Pacaran Rp500 ribu per bulan</i>\n• <i>Makan 30rb per hari</i>\n• <i>Total 3jt per bulan</i>',
            tombol: [[tombolData('❌ Batal', 'a:x')]],
          },
        };
      }
      case 'x':
        clearState(ctx.chatId, 'utama', database);
        return { toast: 'Dibatalkan', layar: layarAnggaran(database) };
      case 'ok': {
        const st = getState<TgState & { draft?: DraftAnggaran }>(ctx.chatId, 'utama', database);
        if (!st || st.t !== 'anggaran_draft' || !st.draft) return { toast: 'Sudah diproses atau sesi berakhir.', hapusTombol: true };
        clearState(ctx.chatId, 'utama', database);
        const d = st.draft;
        let kategoriId = d.kategoriId;
        if (!kategoriId && d.buatKategori) kategoriId = buatAtauPakaiKategori(d.buatKategori, 'telegram', {}, database).id;
        const ada = kategoriId
          ? (database.prepare(`SELECT id FROM budget WHERE active = 1 AND category_id = ? AND period = ?`).get(kategoriId, d.periode) as { id: number } | undefined)
          : (database.prepare(`SELECT id FROM budget WHERE active = 1 AND category_id IS NULL AND period = ?`).get(d.periode) as { id: number } | undefined);
        let budgetId: number;
        if (ada) {
          reviseBudget(ada.id, d.nominal, { effective_from: today() }, 'telegram', database);
          budgetId = ada.id;
        } else {
          budgetId = createBudget(
            { name: d.nama, category_id: kategoriId, period: d.periode, amount_minor: d.nominal, start_date: mulaiJendela(d.periode), recurring: true },
            'telegram',
            database,
          );
        }
        const b = listBudgets({ asOf: today() }, database).find((x) => x.id === budgetId)!;
        return { toast: ada ? 'Anggaran diperbarui' : 'Anggaran dibuat', layar: { ...layarDetailAnggaran(b), teks: `✅ ${ada ? 'Anggaran diperbarui' : 'Anggaran disimpan'}.\n\n${layarDetailAnggaran(b).teks}` } };
      }
      case 'v': {
        const b = listBudgets({ asOf: today() }, database).find((x) => x.id === id);
        return b ? { layar: layarDetailAnggaran(b) } : { toast: 'Anggaran tidak ditemukan.' };
      }
      case 'en':
        setState(ctx.chatId, { t: 'anggaran_nominal', id }, 'utama', 45, database);
        return { layar: { teks: 'Batas barunya berapa? Contoh: 1jt\n<i>Nominal baru berlaku mulai hari ini; riwayat lama tetap tersimpan.</i>', tombol: [[tombolData('❌ Batal', 'a:x')]] } };
      case 'nx':
        return { layar: { teks: 'Nonaktifkan anggaran ini? Riwayatnya tetap tersimpan.', tombol: [[tombolData('✅ Ya', `a:nx2:${id}`), tombolData('❌ Batal', `a:v:${id}`)]] } };
      case 'nx2':
        updateBudget(id, { active: false }, 'telegram', database);
        return { toast: 'Dinonaktifkan', layar: layarAnggaran(database) };
      default:
        return { toast: 'Tombol ini tidak dikenali.' };
    }
  } catch (err) {
    if (err instanceof BudgetError) return { toast: err.message.slice(0, 180) };
    return { toast: (err as Error).message.slice(0, 180) };
  }
}

/* ================================================================== TARGET */

function layarDaftarTarget(database: DB): Layar {
  const goals = listGoals({ asOf: today() }, database).filter((g) => g.status === 'aktif' || g.status === 'dijeda');
  const baris: Tombol[][] = grid(goals.map((g) => tombolData(`${g.ikon ?? '🎯'} ${g.nama}`.slice(0, 32), `g:v:${g.id}`)), 2);
  baris.push([tombolData('➕ Buat Target', 'g:new')]);
  baris.push(navigasi());
  const teks = goals.length
    ? '🎯 <b>Target keuanganmu</b>\n' + goals.map((g) => `• ${esc(g.nama)}: ${rp(g.terkumpul_minor)} / ${rp(g.target_minor)} (${g.persen}%)`).join('\n')
    : '🎯 <b>Target keuangan</b>\nBelum ada target. Ketuk "Buat Target", atau tulis: <i>Target laptop Rp8 juta sebelum Juni 2027</i>.';
  return { teks, tombol: baris };
}

function bar(persen: number): string {
  const n = Math.max(0, Math.min(10, Math.round(persen / 10)));
  return '▰'.repeat(n) + '▱'.repeat(10 - n);
}

function layarDetailTarget(g: GoalEval): Layar {
  const teks = [
    `${esc(g.ikon ?? '🎯')} <b>${esc(g.nama)}</b>${g.status === 'dijeda' ? ' <i>(dijeda)</i>' : ''}`,
    `${bar(g.persen)} ${g.persen}%`,
    `Terkumpul ${rp(g.terkumpul_minor)} dari ${rp(g.target_minor)}`,
    `Masih kurang: <b>${rp(g.sisa_minor)}</b>`,
    g.target_date ? `Tenggat: ${esc(formatTanggal(g.target_date))}${g.hari_tersisa !== null && g.hari_tersisa > 0 ? ` (${g.hari_tersisa} hari lagi)` : ''}` : 'Tanpa tenggat',
    g.perlu_per_bulan_minor !== null ? `Perlu disetor: ${rp(g.perlu_per_bulan_minor)}/bulan (atau ${rp(g.perlu_per_minggu_minor ?? 0)}/minggu)` : null,
    `Dari transfer tabungan tercatat: ${rp(g.dari_transfer_tercatat_minor)} · hanya disisihkan (penanda): ${rp(g.disisihkan_minor)}`,
    '',
    esc(g.penjelasan),
  ].filter((x): x is string => x !== null).join('\n');
  return {
    teks,
    tombol: [
      [tombolData('➕ Sisihkan Uang', `g:s:${g.id}`)],
      [g.status === 'dijeda' ? tombolData('▶️ Lanjutkan', `g:st:${g.id}:aktif`) : tombolData('⏸️ Jeda', `g:st:${g.id}:dijeda`), tombolData('🗑️ Batalkan', `g:bt:${g.id}`)],
      navigasi('g:l'),
    ],
  };
}

function layarKonfirmasiTarget(d: DraftTujuan): Layar {
  return {
    teks: [
      '🎯 <b>Target baru</b>',
      `Nama: <b>${esc(d.nama ?? '')}</b>`,
      `Target: <b>${rp(d.target_minor ?? 0)}</b>`,
      d.target_date ? `Tenggat: ${esc(formatTanggal(d.target_date))}` : 'Tanpa tenggat',
      '\nSimpan?',
    ].join('\n'),
    tombol: [[tombolData('✅ Simpan', 'g:ok'), tombolData('❌ Batal', 'g:x')]],
  };
}

export function mulaiDraftTarget(draft: DraftTujuan, ctx: Konteks, database: DB = db()): Hasil {
  const tanya = pertanyaanTujuan(draft);
  if (tanya) {
    setState(ctx.chatId, { t: 'target_teks', draft } as TgState, 'utama', 45, database);
    return { baru: true, layar: { teks: `🎯 ${esc(tanya)}`, tombol: [[tombolData('❌ Batal', 'g:x')]] } };
  }
  setState(ctx.chatId, { t: 'target_draft', draft } as TgState, 'utama', 45, database);
  return { baru: true, layar: layarKonfirmasiTarget(draft) };
}

export function tanganiTeksTarget(state: TgState, teks: string, ctx: Konteks, database: DB = db()): Hasil {
  if (state.t === 'target_teks') {
    const lama = state['draft'] as DraftTujuan;
    const baru = parseTujuan(teks);
    const draft: DraftTujuan = {
      nama: lama.nama ?? baru.nama ?? (baru.target_minor ? null : teks.trim().slice(0, 60)),
      target_minor: lama.target_minor ?? baru.target_minor,
      target_date: lama.target_date ?? baru.target_date,
    };
    return mulaiDraftTarget(draft, ctx, database);
  }
  if (state.t === 'target_setoran') {
    const n = parseRupiah(teks.toLowerCase());
    if (!n) return { baru: true, layar: { teks: 'Nominalnya belum terbaca. Contoh: 500rb.', tombol: [[tombolData('❌ Batal', 'g:x')]] } };
    const id = Number(state['id']);
    addContribution(id, { amount_minor: n, kind: 'disisihkan', note: 'Dari Telegram' }, 'telegram', database);
    clearState(ctx.chatId, 'utama', database);
    const g = listGoals({ asOf: today() }, database).find((x) => x.id === id);
    return { baru: true, layar: g ? { ...layarDetailTarget(g), teks: `✅ ${rp(n)} disisihkan (hanya penanda — tidak ada uang yang berpindah).\n\n${layarDetailTarget(g).teks}` } : layarDaftarTarget(database) };
  }
  return { baru: true, layar: layarDaftarTarget(database) };
}

export function tanganiTarget(parts: string[], ctx: Konteks, database: DB = db()): Hasil {
  const aksi = parts[1] ?? '';
  const id = Number(parts[2]);
  try {
    switch (aksi) {
      case 'l':
        clearState(ctx.chatId, 'utama', database);
        return { layar: layarDaftarTarget(database) };
      case 'new':
        setState(ctx.chatId, { t: 'target_teks', draft: { nama: null, target_minor: null, target_date: null } } as TgState, 'utama', 45, database);
        return { layar: { teks: '🎯 <b>Buat target</b>\nTulis targetnya, misalnya:\n• <i>Target laptop Rp8 juta sebelum Juni 2027</i>\n• <i>Dana darurat 6jt</i>', tombol: [[tombolData('❌ Batal', 'g:x')]] } };
      case 'x':
        clearState(ctx.chatId, 'utama', database);
        return { toast: 'Dibatalkan', layar: layarDaftarTarget(database) };
      case 'ok': {
        const st = getState<TgState & { draft?: DraftTujuan }>(ctx.chatId, 'utama', database);
        if (!st || st.t !== 'target_draft' || !st.draft) return { toast: 'Sudah diproses atau sesi berakhir.', hapusTombol: true };
        clearState(ctx.chatId, 'utama', database);
        const hasil = simpanTujuan(st.draft, database);
        const g = listGoals({ asOf: today() }, database).find((x) => x.id === hasil.id)!;
        return { toast: 'Target dibuat', layar: { ...layarDetailTarget(g), teks: `✅ Target disimpan.\n\n${layarDetailTarget(g).teks}` } };
      }
      case 'v': {
        const g = listGoals({ asOf: today() }, database).find((x) => x.id === id);
        return g ? { layar: layarDetailTarget(g) } : { toast: 'Target tidak ditemukan.' };
      }
      case 's':
        setState(ctx.chatId, { t: 'target_setoran', id }, 'utama', 45, database);
        return { layar: { teks: 'Berapa yang mau disisihkan? Contoh: 500rb\n<i>Ini hanya penanda — uangnya tidak berpindah dan tidak ada transaksi yang dibuat.</i>', tombol: [[tombolData('❌ Batal', `g:v:${id}`)]] } };
      case 'st': {
        const status = parts[3] as 'aktif' | 'dijeda';
        updateGoal(id, { status }, 'telegram', database);
        const g = listGoals({ asOf: today() }, database).find((x) => x.id === id);
        return { toast: 'Diperbarui', layar: g ? layarDetailTarget(g) : layarDaftarTarget(database) };
      }
      case 'bt':
        return { layar: { teks: 'Batalkan target ini? Riwayat setorannya tetap tersimpan.', tombol: [[tombolData('✅ Ya, Batalkan', `g:bt2:${id}`), tombolData('❌ Tidak', `g:v:${id}`)]] } };
      case 'bt2':
        updateGoal(id, { status: 'dibatalkan' }, 'telegram', database);
        return { toast: 'Dibatalkan', layar: layarDaftarTarget(database) };
      default:
        return { toast: 'Tombol ini tidak dikenali.' };
    }
  } catch (err) {
    if (err instanceof GoalError) return { toast: err.message.slice(0, 180) };
    return { toast: (err as Error).message.slice(0, 180) };
  }
}

export { layarDaftarTarget };
void semuaKategoriAktif;
void MENU_UTAMA;
