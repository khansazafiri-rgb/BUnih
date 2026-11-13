/**
 * Pertanyaan analitik dan tujuan lewat Telegram.
 *
 * Semua angka berasal dari fungsi domain yang sama dengan web (analitik, spend, goals, budgets).
 * Tidak ada angka yang dikarang: bila datanya kosong, bot menjawab bahwa datanya kosong.
 * Bila pertanyaan bisa berarti lebih dari satu hal (mis. "langganan" cocok dengan dua kategori),
 * bot mengembalikan pilihan untuk ditanyakan, bukan menebak.
 */
import type { Database as DB } from 'better-sqlite3';
import { analitik, resolveRange, type RentangSpec } from '../domain/analytics.js';
import { spendRows, sumSpend } from '../domain/spend.js';
import { categorySubtreeIds } from '../domain/categories.js';
import { createGoal, listGoals, GoalError } from '../domain/goals.js';
import { normalizeMerchant } from '../domain/merchantNorm.js';
import { formatIDR } from '../domain/money.js';
import { addDays, addMonths, endOfMonth, isValidDate, today, type IsoDate } from '../domain/time.js';
import { esc } from './format.js';
import { hapusNominal, parseRupiah } from './nlu.js';

/* ------------------------------------------------------------------ waktu */

export type Waktu = { spec: RentangSpec; kunci: string; label: string };

function senin(hari: IsoDate): IsoDate {
  const [y, m, d] = hari.split('-').map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0=Minggu
  return addDays(hari, -((dow + 6) % 7));
}

/** Kunci pendek dipakai di data tombol Telegram (batas 64 byte). */
export function waktuDariKunci(kunci: string, hariIni: IsoDate = today()): Waktu {
  switch (kunci) {
    case 'hi':
      return { spec: { dari: hariIni, sampai: hariIni }, kunci, label: 'hari ini' };
    case 'kmrn':
      return { spec: { dari: addDays(hariIni, -1), sampai: addDays(hariIni, -1) }, kunci, label: 'kemarin' };
    case 'mg':
      return { spec: { dari: senin(hariIni), sampai: hariIni }, kunci, label: 'minggu ini' };
    case 'mgl': {
      const s = addDays(senin(hariIni), -7);
      return { spec: { dari: s, sampai: addDays(s, 6) }, kunci, label: 'minggu lalu' };
    }
    case 'bl':
      return { spec: { preset: 'bulan_lalu' }, kunci, label: 'bulan lalu' };
    case '7h':
      return { spec: { preset: '7_hari' }, kunci, label: '7 hari terakhir' };
    case '30h':
      return { spec: { preset: '30_hari' }, kunci, label: '30 hari terakhir' };
    case 'th':
      return { spec: { preset: 'tahun_ini' }, kunci, label: 'tahun ini' };
    default:
      return { spec: { preset: 'bulan_ini' }, kunci: 'bi', label: 'bulan ini' };
  }
}

export function parseWaktu(teks: string, hariIni: IsoDate = today()): Waktu {
  const t = teks.toLowerCase();
  if (/\bkemarin\b/.test(t)) return waktuDariKunci('kmrn', hariIni);
  if (/\bhari ini\b/.test(t)) return waktuDariKunci('hi', hariIni);
  if (/\bminggu lalu|pekan lalu\b/.test(t)) return waktuDariKunci('mgl', hariIni);
  if (/\bminggu ini|pekan ini\b/.test(t)) return waktuDariKunci('mg', hariIni);
  if (/\bbulan lalu|bulan kemarin\b/.test(t)) return waktuDariKunci('bl', hariIni);
  if (/\b7 hari\b|\bseminggu terakhir\b/.test(t)) return waktuDariKunci('7h', hariIni);
  if (/\b30 hari\b|\bsebulan terakhir\b/.test(t)) return waktuDariKunci('30h', hariIni);
  if (/\btahun ini\b/.test(t)) return waktuDariKunci('th', hariIni);
  return waktuDariKunci('bi', hariIni);
}

/* --------------------------------------------------------------- kategori */

type KategoriRingkas = { id: number; name: string; slug: string; parent_id: number | null };

const KATA_UMUM = new Set(['dan', 'lain', 'lainnya', 'harian', 'untuk', 'atau', 'yang', 'api']);

function token(s: string, minimal = 3): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((x) => x.length >= minimal);
}

/**
 * Cari kategori yang disebut dalam teks. Mengembalikan semua kandidat dengan skor tertinggi:
 * satu kandidat = jelas, lebih dari satu = ambigu, kosong = tidak disebut.
 */
export function cariKategori(teks: string, database: DB): KategoriRingkas[] {
  const kata = new Set(token(teks));
  const semua = database
    .prepare(`SELECT id, name, slug, parent_id FROM category WHERE active = 1`)
    .all() as KategoriRingkas[];
  const skor = new Map<number, number>();
  for (const k of semua) {
    const nm = token(k.name);
    // Kecocokan nama penuh memakai semua kata (termasuk yang pendek seperti "AI").
    const semuaKata = token(k.name, 1);
    if (semuaKata.length >= 1 && token(teks, 1).join(' ').includes(semuaKata.join(' ')) && ` ${token(teks, 1).join(' ')} `.includes(` ${semuaKata.join(' ')} `)) {
      skor.set(k.id, 10 + semuaKata.length);
      continue;
    }
    const khas = nm.filter((x) => !KATA_UMUM.has(x));
    const cocok = khas.filter((x) => kata.has(x) || [...kata].some((w) => w.length >= 4 && (x.startsWith(w) || w.startsWith(x))));
    if (cocok.length > 0) skor.set(k.id, cocok.length);
  }
  if (skor.size === 0) return [];
  const maks = Math.max(...skor.values());
  return semua.filter((k) => skor.get(k.id) === maks);
}

function cariMerchant(teks: string, database: DB): Array<{ id: number; name: string }> {
  const norm = ` ${normalizeMerchant(teks)} `;
  if (norm.trim().length < 3) return [];
  const daftar = database
    .prepare(
      `SELECT m.id, m.name, m.name_norm FROM merchant m WHERE m.active = 1
       UNION
       SELECT m.id, m.name, a.alias_norm FROM merchant_alias a JOIN merchant m ON m.id = a.merchant_id WHERE m.active = 1`,
    )
    .all() as Array<{ id: number; name: string; name_norm: string }>;
  const hit = new Map<number, { id: number; name: string; len: number }>();
  for (const m of daftar) {
    if (m.name_norm.length >= 3 && norm.includes(` ${m.name_norm} `)) {
      const lama = hit.get(m.id);
      if (!lama || lama.len < m.name_norm.length) hit.set(m.id, { id: m.id, name: m.name, len: m.name_norm.length });
    }
  }
  if (hit.size === 0) return [];
  const maks = Math.max(...[...hit.values()].map((x) => x.len));
  return [...hit.values()].filter((x) => x.len === maks).map(({ id, name }) => ({ id, name }));
}

/* ------------------------------------------------------------ pertanyaan */

export type Pilihan = { label: string; data: string };
export type Jawaban = { teks: string; pilihan?: Pilihan[] };

const rp = (n: number) => esc(formatIDR(n));

function kalimatPerubahan(sekarang: number, sebelum: number, pembanding: string): string {
  if (sebelum === 0 && sekarang === 0) return '';
  if (sebelum === 0) return `\nBelum ada data pada ${esc(pembanding)} untuk dibandingkan.`;
  const persen = Math.round(((sekarang - sebelum) / sebelum) * 100);
  if (persen === 0) return `\nSama dengan ${esc(pembanding)} (${rp(sebelum)}).`;
  return `\n${persen > 0 ? 'Naik' : 'Turun'} ${Math.abs(persen)}% dari ${esc(pembanding)} (${rp(sebelum)}).`;
}

type Topik = 'total' | 'teratas' | 'banding' | 'merchant_sering';

function topikDariTeks(t: string): Topik {
  if (/\b(bandingkan|banding|dibanding|naik atau turun|lebih (?:boros|hemat))\b/.test(t)) return 'banding';
  if (/\b(paling (?:banyak|besar|boros)|terbesar|habis (?:di|buat|untuk) (?:mana|apa)|kemana|ke mana|buat apa)\b/.test(t)) return 'teratas';
  if (/\b(paling sering|sering belanja|langganan(?:ku)? di mana|toko apa|tempat apa)\b/.test(t)) return 'merchant_sering';
  return 'total';
}

/** Apakah kalimat ini pertanyaan tentang pengeluaran (bukan pencatatan)? */
export function adalahPertanyaanPengeluaran(teks: string): boolean {
  const t = teks.toLowerCase();
  if (!/\b(berapa|total|jumlah|paling|bandingkan|banding|rata-rata|kemana|ke mana|habis|boros|hemat)\b/.test(t)) return false;
  return /\b(pengeluaran|keluar|belanja|habis|boros|hemat|makan|transport|jajan|uang|duit|biaya|spend)\b/.test(t) || /\b(paling|bandingkan)\b/.test(t);
}

export function jawabPertanyaanPengeluaran(teks: string, database: DB, hariIni: IsoDate = today()): Jawaban {
  const t = teks.toLowerCase();
  const waktu = parseWaktu(t, hariIni);
  const topik = topikDariTeks(t);

  // Nama tempat lebih spesifik daripada kata kategori ("belanja di Gojek" bukan "Belanja barang").
  const kandidatMer = cariMerchant(t, database);
  const kandidatKat = kandidatMer.length === 0 ? cariKategori(t, database) : [];

  // Ambigu -> tanya balik, jangan menebak.
  if (kandidatKat.length > 1) {
    return {
      teks: `Kategori mana yang kamu maksud untuk ${esc(waktu.label)}?`,
      pilihan: kandidatKat.slice(0, 6).map((k) => ({ label: k.name, data: `an:k:${k.id}:${waktu.kunci}` })),
    };
  }
  if (kandidatMer.length > 1) {
    return {
      teks: `Ada beberapa tempat yang mirip. Yang mana?`,
      pilihan: kandidatMer.slice(0, 6).map((m) => ({ label: m.name, data: `an:m:${m.id}:${waktu.kunci}` })),
    };
  }
  if (kandidatKat.length === 1) return jawabKategori(kandidatKat[0]!.id, waktu, database, hariIni);
  if (kandidatMer.length === 1) return jawabMerchant(kandidatMer[0]!.id, waktu, database, hariIni);

  const a = analitik(waktu.spec, database, hariIni);
  const total = a.ringkasan.pengeluaran_pribadi_neto_minor;
  const sebelum = a.ringkasan.pengeluaran_pribadi_sebelumnya_minor;
  const label = esc(a.rentang.label);
  const pembanding = a.rentang.sebelumnya.label;

  if (a.kualitas_data.jumlah_transaksi === 0) {
    return { teks: `Belum ada pengeluaran tercatat untuk ${label}. Aku tidak mengira-ngira angkanya.` };
  }

  if (topik === 'merchant_sering') {
    const top = a.merchant.paling_sering.slice(0, 5);
    if (top.length === 0) return { teks: `Belum ada tempat belanja yang tercatat untuk ${label}.` };
    return {
      teks:
        `<b>Paling sering belanja — ${label}</b>\n` +
        top.map((m, i) => `${i + 1}. ${esc(m.nama)} — ${m.jumlah_transaksi}× (${rp(m.total_minor)})`).join('\n'),
    };
  }

  if (topik === 'teratas' || topik === 'banding') {
    const baris = a.kategori.slice(0, 5).map((k, i) => {
      const p = k.perubahan_persen === null ? '' : ` (${k.perubahan_persen > 0 ? '+' : ''}${k.perubahan_persen}%)`;
      return `${i + 1}. ${esc(k.nama)} — ${rp(k.jumlah_minor)}${p}`;
    });
    return {
      teks:
        `<b>${topik === 'banding' ? 'Perbandingan' : 'Terbesar'} — ${label}</b>\n` +
        `Total pengeluaran pribadi: <b>${rp(total)}</b>${kalimatPerubahan(total, sebelum, pembanding)}\n\n` +
        baris.join('\n') +
        (a.kualitas_data.belum_dikategorikan_jumlah > 0
          ? `\n\n${a.kualitas_data.belum_dikategorikan_jumlah} transaksi (${rp(a.kualitas_data.belum_dikategorikan_minor)}) belum punya kategori.`
          : ''),
    };
  }

  return {
    teks:
      `<b>Pengeluaran pribadi ${label}</b>\n<b>${rp(total)}</b> dari ${a.kualitas_data.jumlah_transaksi} transaksi.` +
      `${kalimatPerubahan(total, sebelum, pembanding)}\n` +
      `Rata-rata ${rp(Math.round(total / Math.max(1, a.rentang.hari)))} per hari.\n` +
      'Tidak termasuk transfer antar rekeningmu, tabungan, uang yang akan diganti orang lain, dan biaya company.',
  };
}

export function jawabKategori(categoryId: number, waktu: Waktu, database: DB, hariIni: IsoDate = today()): Jawaban {
  const nama = (database.prepare(`SELECT name FROM category WHERE id = ?`).get(categoryId) as { name: string } | undefined)?.name;
  if (!nama) return { teks: 'Kategori itu tidak ditemukan.' };
  const r = resolveRange(waktu.spec, hariIni);
  const ids = new Set(categorySubtreeIds(categoryId, database));
  const sum = (dari: IsoDate, sampai: IsoDate) => {
    const rows = spendRows(dari, sampai, {}, database).filter((x) => x.category_id !== null && ids.has(x.category_id));
    return { total: sumSpend(rows), n: new Set(rows.map((x) => x.cash_event_id)).size };
  };
  const skrg = sum(r.dari, r.sampai);
  const lalu = sum(r.sebelumnya.dari, r.sebelumnya.sampai);
  if (skrg.n === 0) return { teks: `Belum ada pengeluaran <b>${esc(nama)}</b> untuk ${esc(waktu.label)}.` };
  return {
    teks:
      `<b>${esc(nama)} — ${esc(waktu.label)}</b>\n<b>${rp(skrg.total)}</b> dari ${skrg.n} transaksi.` +
      kalimatPerubahan(skrg.total, lalu.total, r.sebelumnya.label),
  };
}

export function jawabMerchant(merchantId: number, waktu: Waktu, database: DB, hariIni: IsoDate = today()): Jawaban {
  const nama = (database.prepare(`SELECT name FROM merchant WHERE id = ?`).get(merchantId) as { name: string } | undefined)?.name;
  if (!nama) return { teks: 'Tempat itu tidak ditemukan.' };
  const r = resolveRange(waktu.spec, hariIni);
  const sum = (dari: IsoDate, sampai: IsoDate) => {
    const rows = spendRows(dari, sampai, {}, database).filter((x) => x.merchant_id === merchantId);
    return { total: sumSpend(rows), n: new Set(rows.map((x) => x.cash_event_id)).size };
  };
  const skrg = sum(r.dari, r.sampai);
  const lalu = sum(r.sebelumnya.dari, r.sebelumnya.sampai);
  if (skrg.n === 0) return { teks: `Belum ada belanja di <b>${esc(nama)}</b> untuk ${esc(waktu.label)}.` };
  return {
    teks:
      `<b>${esc(nama)} — ${esc(waktu.label)}</b>\n<b>${rp(skrg.total)}</b> dari ${skrg.n} transaksi.` +
      kalimatPerubahan(skrg.total, lalu.total, r.sebelumnya.label),
  };
}

/** Jawab tombol pilihan: data berbentuk "an:k:<id>:<kunci waktu>" atau "an:m:<id>:<kunci waktu>". */
export function jawabDariTombol(data: string, database: DB, hariIni: IsoDate = today()): Jawaban | null {
  const [, jenis, idRaw, kunci] = data.split(':');
  const id = Number(idRaw);
  if (!Number.isInteger(id)) return null;
  const waktu = waktuDariKunci(kunci ?? 'bi', hariIni);
  if (jenis === 'k') return jawabKategori(id, waktu, database, hariIni);
  if (jenis === 'm') return jawabMerchant(id, waktu, database, hariIni);
  return null;
}

/* ----------------------------------------------------------------- tujuan */

export function adalahPermintaanBuatTujuan(teks: string): boolean {
  const t = teks.toLowerCase();
  return (
    /\b(buat|bikin|tambah|tambahkan|mulai)\b.*\b(tujuan|target|celengan)\b/.test(t) ||
    /\b(mau|pengen|ingin)\s+(?:nabung|menabung)\s+(?:untuk|buat)\b/.test(t) ||
    // "Target laptop Rp8 juta sebelum Juni 2027"
    /^\s*(?:target|tujuan)\s+[a-z]/.test(t)
  );
}

export function adalahPertanyaanTujuan(teks: string): boolean {
  const t = teks.toLowerCase();
  return /\b(tujuan|target tabungan|celengan)\b/.test(t) && /\b(berapa|progres|sudah|gimana|bagaimana|status|lihat|daftar)\b/.test(t);
}

const NAMA_BULAN: Record<string, number> = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6, juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
};

export function parseTanggalTarget(teks: string, hariIni: IsoDate = today()): IsoDate | null {
  const t = teks.toLowerCase();
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso?.[1] && isValidDate(iso[1])) return iso[1];
  const relBulan = t.match(/\b(?:dalam|sekitar)?\s*(\d{1,2})\s*bulan\s*(?:lagi|ke depan|kedepan)?\b/);
  if (relBulan?.[1] && /\b(lagi|dalam|ke ?depan)\b/.test(t)) return addMonths(hariIni, Number(relBulan[1]));
  const relMinggu = t.match(/\b(\d{1,2})\s*minggu\s*(?:lagi|ke depan)?\b/);
  if (relMinggu?.[1] && /\b(lagi|dalam)\b/.test(t)) return addDays(hariIni, Number(relMinggu[1]) * 7);
  if (/\bakhir tahun\b/.test(t)) return `${hariIni.slice(0, 4)}-12-31`;
  const bln = t.match(/\b(?:sampai|di|pada|bulan|sebelum)\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)(?:\s+(\d{4}))?\b/);
  if (bln?.[1]) {
    const bulan = NAMA_BULAN[bln[1]]!;
    let tahun = bln[2] ? Number(bln[2]) : Number(hariIni.slice(0, 4));
    let akhir = endOfMonth(`${tahun}-${String(bulan).padStart(2, '0')}-01`);
    if (!bln[2] && akhir < hariIni) {
      tahun += 1;
      akhir = endOfMonth(`${tahun}-${String(bulan).padStart(2, '0')}-01`);
    }
    return akhir;
  }
  return null;
}

export type DraftTujuan = { nama: string | null; target_minor: number | null; target_date: IsoDate | null };

export function parseTujuan(teks: string, hariIni: IsoDate = today()): DraftTujuan {
  const target = parseRupiah(teks.toLowerCase());
  const tanggal = parseTanggalTarget(teks, hariIni);
  let nama = hapusNominal(teks)
    .replace(/\b(buat|bikin|tambah|tambahkan|mulai)\b/gi, ' ')
    .replace(/\b(tujuan|target|celengan|tabungan|baru)\b/gi, ' ')
    .replace(/\b(mau|pengen|ingin)\s+(?:nabung|menabung)\s+(?:untuk|buat)\b/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(?:dalam|sekitar)?\s*\d{1,2}\s*(?:bulan|minggu)\s*(?:lagi|ke ?depan)?\b/gi, ' ')
    .replace(/\b(?:sampai|sebelum|pada|di|bulan)\s+(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)(?:\s+\d{4})?\b/gi, ' ')
    .replace(/\bakhir tahun\b/gi, ' ')
    .replace(/\b(sebesar|senilai|targetnya|target|untuk|buat|dengan|yaitu|namanya|nama)\b/gi, ' ')
    .replace(/[,.:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (nama.length < 2) nama = '';
  if (nama.length > 60) nama = nama.slice(0, 60).trim();
  return { nama: nama ? nama.charAt(0).toUpperCase() + nama.slice(1) : null, target_minor: target, target_date: tanggal };
}

/** Pertanyaan untuk bagian yang belum diketahui; null bila draft sudah lengkap. */
export function pertanyaanTujuan(d: DraftTujuan): string | null {
  if (!d.nama && !d.target_minor) return 'Tujuan apa yang ingin kamu buat, dan berapa targetnya? Contoh: "laptop 8 juta".';
  if (!d.nama) return `Targetnya ${formatIDR(d.target_minor!)}. Tujuan ini namanya apa? Contoh: "Laptop".`;
  if (!d.target_minor) return `Tujuan "${d.nama}" — berapa target uangnya? Contoh: "5 juta".`;
  return null;
}

export function simpanTujuan(d: DraftTujuan, database: DB): { id: number; pesan: string } {
  if (!d.nama || !d.target_minor) throw new GoalError('Nama dan target tujuan belum lengkap.');
  const id = createGoal({ name: d.nama, target_minor: d.target_minor, target_date: d.target_date, reminder: true }, 'telegram', database);
  return {
    id,
    pesan:
      `Tujuan dibuat: <b>${esc(d.nama)}</b>, target ${rp(d.target_minor)}` +
      `${d.target_date ? `, tenggat ${esc(d.target_date)}` : ', tanpa tenggat'}.\n` +
      'Menyisihkan uang untuk tujuan hanya penanda — tidak ada uang yang berpindah. Kelola di web: menu Tujuan.',
  };
}

export function ringkasanTujuan(database: DB, hariIni: IsoDate = today()): string {
  const goals = listGoals({ asOf: hariIni }, database).filter((g) => g.status === 'aktif' || g.status === 'dijeda');
  if (goals.length === 0) return 'Belum ada tujuan aktif. Buat dengan menulis, misalnya: "buat tujuan laptop 8 juta 6 bulan lagi".';
  return (
    '<b>Tujuan keuanganmu</b>\n' +
    goals
      .map((g) => `• ${esc(g.nama)}: ${rp(g.terkumpul_minor)} dari ${rp(g.target_minor)} (${g.persen}%)\n  ${esc(g.penjelasan)}`)
      .join('\n')
  );
}

/* ----------------------------------------------------- merchant & proyek */

export type Terurai = { merchant: string | null; proyek: string | null };

/**
 * Ambil nama tempat dan proyek dari kalimat pencatatan: "makan 25rb di Kantin Kampus #skripsi".
 * Tanpa penanda "di ..." bot tidak menebak nama tempat.
 */
export function uraiMerchantProyek(teks: string): Terurai {
  let proyek: string | null = null;
  const tag = teks.match(/(?:#|\bproyek\s+)([\p{L}\p{N}_-]{2,30})/iu);
  if (tag?.[1]) proyek = tag[1].toLowerCase();
  let sisa = teks.replace(/#[\p{L}\p{N}_-]+/giu, ' ');
  const di = sisa.match(/\b(?:di|ke|dari|beli di)\s+([^,.;\d][^,.;]*?)(?=\s+(?:kemarin|tadi|hari ini|proyek|untuk|buat|sama|bareng|pakai|pake|via|lewat|dengan|rp|\d)|[,.;]|$)/i);
  let merchant: string | null = null;
  if (di?.[1]) {
    const m = di[1].trim().replace(/\s+/g, ' ');
    if (m.length >= 2 && m.length <= 60) merchant = m;
  }
  return { merchant, proyek };
}
