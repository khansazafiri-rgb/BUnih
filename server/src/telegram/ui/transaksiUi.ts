/**
 * Notifikasi transaksi baru, kartu transaksi, pemilih kategori, dan ubah jenis.
 *
 * Callback data:
 *   n:<idPesan>:<aksi>[:arg]   dari notifikasi transaksi (sekali pakai: diberi penjaga status)
 *   t:<aksi>:<idTransaksi>...  dari kartu transaksi (selalu valid, semua aksinya idempoten)
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../../db/index.js';
import { answerDecision, getDecision } from '../../domain/decisions.js';
import { DAFTAR_JENIS, JenisError, jenisUntukArah, ringkasPenanggung, terapkanJenis, type KodeJenis } from '../../domain/jenisTransaksi.js';
import { allocationsOf, getCashEvent, recategorize, type CashEventRow } from '../../domain/ledger.js';
import { CASH_KIND_LABEL } from '../../domain/types.js';
import { formatIDR } from '../../domain/money.js';
import { dateOf, formatTanggal, nowIso } from '../../domain/time.js';
import { getCategory } from '../../domain/categories.js';
import { listAccounts } from '../../domain/balances.js';
import { setMerchantDefaultCategory } from '../../domain/merchants.js';
import { ubahTransaksi } from '../../domain/manualTx.js';
import { esc } from '../format.js';
import { clearState, getTgMessage, selesaikanPesan, setState, type TgMessageRow } from '../state.js';
import {
  MENU_UTAMA, barisHalaman, grid, navigasi, potongHalaman, tombolData,
  type Hasil, type Konteks, type Layar, type Tombol,
} from './layar.js';

const PER_HALAMAN_KATEGORI = 8;

/* ------------------------------------------------------------------ ringkasan */

type Ringkas = {
  ev: CashEventRow;
  rekening: string | null;
  merchant: string | null;
  kategori: { id: number; nama: string; ikon: string } | null;
  jenis: string;
  penanggung: string;
};

export function ringkasEvent(id: number, database: DB = db()): Ringkas | null {
  const ev = getCashEvent(id, database);
  if (!ev) return null;
  const rek = ev.account_id
    ? (database.prepare(`SELECT name FROM account WHERE id = ?`).get(ev.account_id) as { name: string } | undefined)
    : undefined;
  const mer = ev.merchant_id
    ? (database.prepare(`SELECT name FROM merchant WHERE id = ?`).get(ev.merchant_id) as { name: string } | undefined)
    : undefined;
  const kat = ev.category_id ? getCategory(ev.category_id, database) : undefined;
  return {
    ev,
    rekening: rek?.name ?? null,
    merchant: mer?.name ?? ev.merchant_raw ?? ev.counterparty ?? null,
    kategori: kat ? { id: kat.id, nama: kat.name, ikon: kat.icon ?? '🏷️' } : null,
    jenis: CASH_KIND_LABEL[ev.kind as keyof typeof CASH_KIND_LABEL] ?? ev.kind,
    penanggung: ringkasPenanggung(id, database),
  };
}

const rp = (n: number) => esc(formatIDR(n));

/* ------------------------------------------------------------------ kategori cepat */

type Kat = { id: number; name: string; icon: string | null };

/** Urutan pilihan bawaan untuk kategori yang belum pernah dipakai: yang paling umum lebih dulu. */
const URUTAN_UMUM = ['makan', 'transport', 'groceries', 'belanja-barang', 'langganan-lain', 'langganan-ai', 'hiburan', 'pendidikan', 'kesehatan', 'kebutuhan-harian', 'hadiah'];

/**
 * Kategori untuk tombol cepat: yang paling sering dipakai 90 hari terakhir lebih dulu (termasuk kategori
 * buatan sendiri), lalu urutan umum (Makan, Transport, Belanja, ...), lalu urutan bawaan.
 */
export function kategoriPopuler(batas: number, database: DB = db()): Kat[] {
  const sejak = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const rows = database
    .prepare(
      `SELECT c.id, c.name, c.icon, c.slug,
              (SELECT COUNT(*) FROM cash_event ce
                WHERE ce.category_id = c.id AND ce.status <> 'dibatalkan' AND date(ce.occurred_at) >= ?) AS n
         FROM category c
        WHERE c.active = 1 AND c.parent_id IS NULL AND c.slug NOT IN ('lainnya','tabungan')`,
    )
    .all(sejak) as Array<Kat & { slug: string; n: number }>;
  const peringkat = (slug: string) => {
    const i = URUTAN_UMUM.indexOf(slug);
    return i === -1 ? 999 : i;
  };
  return rows
    .sort((a, b) => b.n - a.n || peringkat(a.slug) - peringkat(b.slug) || a.name.localeCompare(b.name))
    .slice(0, batas)
    .map(({ id, name, icon }) => ({ id, name, icon }));
}

export function semuaKategoriAktif(database: DB = db()): Kat[] {
  return database
    .prepare(`SELECT id, name, icon FROM category WHERE active = 1 ORDER BY sort_order, name`)
    .all() as Kat[];
}

const labelKat = (k: Kat) => `${k.icon ?? '🏷️'} ${k.name}`;

/* ------------------------------------------------------------------ penerapan */

/**
 * Setel kategori sebuah transaksi. Idempoten: kategori yang sama dua kali tidak mengubah apa pun
 * dan tidak menulis audit kedua.
 */
export function setKategoriTransaksi(
  eventId: number,
  categoryId: number,
  actor = 'telegram',
  database: DB = db(),
): { nama: string; berubah: boolean } {
  const kat = getCategory(categoryId, database);
  if (!kat) throw new JenisError('Kategori itu tidak ditemukan.');
  if (!kat.active) throw new JenisError(`Kategori "${kat.name}" sudah diarsipkan.`);
  return database.transaction(() => {
    const ev = getCashEvent(eventId, database);
    if (!ev) throw new JenisError('Transaksi tidak ditemukan.');
    let berubah = false;
    if (ev.category_id !== categoryId) {
      recategorize(eventId, { category_id: categoryId }, actor, database);
      berubah = true;
    } else {
      // Pastikan potongan alokasi ikut sama walaupun cash_event sudah benar.
      const ps = allocationsOf(eventId, database) as Array<{ purpose: string; category_id: number | null }>;
      if (ps.some((p) => ['biaya_pribadi', 'kredit_layanan', 'refund'].includes(p.purpose) && p.category_id !== categoryId)) {
        recategorize(eventId, { category_id: categoryId }, actor, database);
        berubah = true;
      }
    }
    database
      .prepare(`UPDATE cash_event SET status = CASE WHEN status = 'perlu_verifikasi' THEN 'terkonfirmasi' ELSE status END, updated_at = ? WHERE id = ?`)
      .run(nowIso(), eventId);
    return { nama: kat.name, berubah };
  })();
}

/** Tutup pertanyaan "kategori transaksi" yang terkait, bila masih terbuka. */
function tutupKeputusan(row: TgMessageRow, jawaban: unknown, database: DB): void {
  if (!row.decision_id) return;
  const d = getDecision(row.decision_id, database);
  if (d && d.state !== 'dijawab' && d.state !== 'dibatalkan') answerDecision(row.decision_id, jawaban, 'telegram', database);
}

/* ------------------------------------------------------------------ layar notifikasi */

function barisInfo(r: Ringkas): string {
  return [
    `Nominal: <b>${rp(r.ev.amount_minor)}</b>`,
    `Rekening: ${r.rekening ? esc(r.rekening) : '<i>belum teridentifikasi</i>'}`,
    `Merchant: ${r.merchant ? esc(r.merchant) : 'Belum diketahui'}`,
    `Tanggal: ${esc(formatTanggal(dateOf(r.ev.occurred_at)))}`,
  ].join('\n');
}

export function layarNotifikasi(row: TgMessageRow, database: DB = db()): Layar {
  const r = ringkasEvent(row.cash_event_id!, database);
  if (!r) return { teks: 'Transaksi ini sudah tidak ada.' };
  const keluar = r.ev.direction === 'keluar';
  const rid = row.id;

  if (!keluar) {
    const teks = [
      '💰 <b>Uang masuk terdeteksi</b>',
      barisInfo(r),
      `Jenis saat ini: ${esc(r.jenis)}`,
      `Status: ${r.ev.status === 'terkonfirmasi' ? 'Terkonfirmasi' : 'Menunggu kepastian'}`,
      '',
      'Uang masuk ini apa?',
    ].join('\n');
    const jenis = jenisUntukArah('masuk').map((j) => tombolData(j.label, `n:${rid}:j:${j.kode}`));
    const baris: Tombol[][] = [...grid(jenis, 2)];
    if (!r.ev.account_id) baris.push([tombolData('🏦 Pilih Rekening', `n:${rid}:acc`)]);
    baris.push([tombolData('⏭️ Nanti Saja', `n:${rid}:later`)]);
    return { teks, tombol: baris };
  }

  const saran = r.kategori && r.ev.kind !== 'belum_dikategorikan' ? r.kategori : null;
  const teks = [
    '💸 <b>Transaksi baru terdeteksi</b>',
    barisInfo(r),
    `Jenis: ${esc(r.jenis)}`,
    saran ? `Kategori disarankan: <b>${esc(saran.ikon)} ${esc(saran.nama)}</b>` : null,
    `Status: ${saran ? 'Kategori disarankan — mohon konfirmasi' : 'Menunggu kategorisasi'}`,
    '',
    saran ? 'Sudah benar?' : 'Transaksi ini untuk apa?',
  ]
    .filter((x): x is string => x !== null)
    .join('\n');

  const baris: Tombol[][] = [];
  if (saran) {
    baris.push([
      tombolData(`✅ Konfirmasi: ${saran.nama}`.slice(0, 40), `n:${rid}:ok`),
      tombolData('✏️ Ubah Kategori', `n:${rid}:all:0`),
    ]);
  } else {
    const populer = kategoriPopuler(6, database);
    baris.push(...grid(populer.map((k) => tombolData(labelKat(k), `n:${rid}:c:${k.id}`)), 2));
    baris.push([tombolData('➕ Kategori Baru', `n:${rid}:new`), tombolData('📂 Semua Kategori', `n:${rid}:all:0`)]);
  }
  const aksi: Tombol[] = [tombolData('🔄 Ubah Jenis', `n:${rid}:J`), tombolData('⏭️ Nanti Saja', `n:${rid}:later`)];
  if (!r.ev.account_id) aksi.unshift(tombolData('🏦 Pilih Rekening', `n:${rid}:acc`));
  baris.push(aksi);
  return { teks, tombol: baris };
}

/** Tampilan setelah notifikasi selesai: tombol lama diganti satu tombol "Detail". */
export function layarSelesai(row: TgMessageRow, ringkasan: string, database: DB = db()): Layar {
  const r = ringkasEvent(row.cash_event_id!, database);
  const info = r
    ? `${rp(r.ev.amount_minor)} · ${esc(r.rekening ?? 'rekening belum teridentifikasi')} · ${esc(r.merchant ?? 'merchant belum diketahui')}`
    : '';
  const baris: Tombol[][] = [[tombolData('📄 Detail & Ubah', `t:v:${row.cash_event_id}`)]];
  if (r?.ev.merchant_id && r.kategori) {
    const m = database.prepare(`SELECT default_category_id FROM merchant WHERE id = ?`).get(r.ev.merchant_id) as
      | { default_category_id: number | null }
      | undefined;
    if (m && m.default_category_id === null) baris.push([tombolData('🧠 Ingat untuk merchant ini', `t:mem:${row.cash_event_id}`)]);
  }
  return { teks: `${ringkasan}\n${info}`, tombol: baris };
}

/* ------------------------------------------------------------------ pemilih kategori */

function layarPilihKategori(
  judul: string,
  halaman: number,
  dataKategori: (id: number) => string,
  dataHalaman: (h: number) => string,
  dataBaru: string,
  kembali: string,
  database: DB,
): Layar {
  const h = potongHalaman(semuaKategoriAktif(database), halaman, PER_HALAMAN_KATEGORI);
  const baris: Tombol[][] = grid(h.item.map((k) => tombolData(labelKat(k), dataKategori(k.id))), 2);
  const nav = barisHalaman(h, dataHalaman);
  if (nav.length) baris.push(nav);
  baris.push([tombolData('➕ Kategori Baru', dataBaru)]);
  baris.push(navigasi(kembali));
  return { teks: `${judul}\n(${h.total} kategori)`, tombol: baris };
}

function layarPilihJenis(arah: 'keluar' | 'masuk', dataJenis: (k: KodeJenis) => string, kembali: string): Layar {
  const tombol = jenisUntukArah(arah).map((j) => tombolData(j.label, dataJenis(j.kode)));
  return {
    teks:
      '<b>Ini transaksi jenis apa?</b>\nJenis menentukan makna uangnya (pribadi, reimburse, transfer sendiri, ...). ' +
      'Kategori dan merchant tetap terpisah.',
    tombol: [...grid(tombol, 2), navigasi(kembali)],
  };
}

function layarPilihRekening(dataAkun: (id: number) => string, kembali: string, database: DB): Layar {
  const akun = listAccounts(database, true);
  return {
    teks: '<b>Transaksi ini dari rekening mana?</b>',
    tombol: [...grid(akun.map((a) => tombolData(`🏦 ${a.name}`, dataAkun(a.id))), 2), navigasi(kembali)],
  };
}

/* ------------------------------------------------------------------ handler notifikasi (n:) */

export function tanganiNotif(parts: string[], ctx: Konteks, database: DB = db()): Hasil {
  const rid = Number(parts[1]);
  const aksi = parts[2] ?? '';
  const arg = parts[3];
  const row = Number.isInteger(rid) ? getTgMessage(rid, database) : undefined;
  if (!row || row.chat_id !== ctx.chatId || row.kind !== 'transaksi' || !row.cash_event_id) {
    return { toast: 'Pesan ini sudah tidak berlaku.', hapusTombol: true };
  }

  if (row.state !== 'aktif') {
    return {
      toast: 'Notifikasi ini sudah selesai.',
      layar: layarSelesai(row, `✅ Sudah diproses${row.outcome ? `: ${esc(row.outcome)}` : ''}.`, database),
    };
  }
  const eventId = row.cash_event_id;

  try {
    switch (aksi) {
      case 'ok':
      case 'c': {
        const r0 = ringkasEvent(eventId, database);
        const catId = aksi === 'ok' ? r0?.ev.category_id : Number(arg);
        if (!catId) return { toast: 'Pilih kategori dulu.' };
        const { nama } = setKategoriTransaksi(eventId, catId, 'telegram', database);
        if (!selesaikanPesan(row.id, `kategori ${nama}`, database)) return { toast: 'Sudah diproses.' };
        tutupKeputusan(row, { kategori_id: catId }, database);
        clearState(ctx.chatId, 'utama', database);
        const k = getCategory(catId, database);
        return {
          toast: `Dikategorikan: ${nama}`,
          layar: layarSelesai(row, `✅ Dikategorikan: <b>${esc(k?.icon ?? '🏷️')} ${esc(nama)}</b>`, database),
        };
      }
      case 'all':
        return {
          layar: layarPilihKategori(
            '<b>Pilih kategori</b>',
            Number(arg ?? 0),
            (id) => `n:${rid}:c:${id}`,
            (h) => `n:${rid}:all:${h}`,
            `n:${rid}:new`,
            `n:${rid}:back`,
            database,
          ),
        };
      case 'new':
        setState(ctx.chatId, { t: 'kat_baru', step: 'nama', rid, eventId, balik: `n:${rid}:back` }, 'utama', 45, database);
        return {
          layar: {
            teks: '➕ <b>Kategori baru</b>\nKategori baru mau diberi nama apa?\n<i>Ketik namanya, misalnya: Pacaran</i>',
            tombol: [[tombolData('❌ Batal', `n:${rid}:back`)]],
          },
        };
      case 'back':
        clearState(ctx.chatId, 'utama', database);
        return { layar: layarNotifikasi(row, database) };
      case 'J': {
        const ev = getCashEvent(eventId, database)!;
        return { layar: layarPilihJenis(ev.direction, (k) => `n:${rid}:j:${k}`, `n:${rid}:back`) };
      }
      case 'j': {
        const kode = arg as KodeJenis;
        const hasil = terapkanJenis(eventId, kode, 'telegram', database);
        if (hasil.perluInput === 'bagi') {
          const ev = getCashEvent(eventId, database)!;
          setState(ctx.chatId, { t: 'bagi', cash_event_id: eventId, nominal_minor: ev.amount_minor }, 'utama', 45, database);
          return {
            layar: { teks: `👥 ${esc(hasil.pesan)}`, tombol: [[tombolData('❌ Batal', `n:${rid}:back`)]] },
          };
        }
        if (hasil.def.menutup) {
          selesaikanPesan(row.id, hasil.def.label.replace(/^\S+\s/, ''), database);
          tutupKeputusan(row, { jenis: kode }, database);
          return { toast: 'Jenis diperbarui', layar: layarSelesai(row, `✅ ${esc(hasil.pesan)}`, database) };
        }
        return { toast: 'Jenis diperbarui', layar: layarNotifikasi(row, database) };
      }
      case 'acc':
        return { layar: layarPilihRekening((id) => `n:${rid}:a:${id}`, `n:${rid}:back`, database) };
      case 'a': {
        ubahTransaksi(eventId, { rekening_id: Number(arg) }, 'telegram', database);
        return { toast: 'Rekening diperbarui', layar: layarNotifikasi(row, database) };
      }
      case 'later':
        selesaikanPesan(row.id, 'ditunda', database);
        return {
          toast: 'Ditunda',
          layar: {
            teks:
              '⏭️ <b>Ditunda.</b> Transaksi tetap tercatat dan belum dikategorikan.\n' +
              'Kamu bisa melanjutkannya kapan saja lewat tombol di bawah atau /transaksi.',
            tombol: [[tombolData('📂 Kategorikan Sekarang', `t:k:${eventId}`)], [MENU_UTAMA]],
          },
        };
      default:
        return { toast: 'Tombol ini tidak dikenali.' };
    }
  } catch (err) {
    return { toast: (err as Error).message.slice(0, 180) };
  }
}

/* ------------------------------------------------------------------ kartu transaksi (t:) */

export function layarKartu(eventId: number, opts: { dariDaftar?: number } = {}, database: DB = db()): Layar {
  const r = ringkasEvent(eventId, database);
  if (!r) return { teks: 'Transaksi tidak ditemukan.', tombol: [navigasi()] };
  const e = r.ev;
  const tanda = e.direction === 'keluar' ? '−' : '+';
  const teks = [
    `🧾 <b>Transaksi #${e.id}</b>`,
    `<b>${tanda}${rp(e.amount_minor)}</b> · ${esc(formatTanggal(dateOf(e.occurred_at)))}`,
    `Merchant: ${r.merchant ? esc(r.merchant) : 'Belum diketahui'}`,
    `Rekening: ${r.rekening ? esc(r.rekening) : '<i>belum teridentifikasi</i>'}`,
    `Jenis: ${esc(r.jenis)}`,
    `Kategori: ${r.kategori ? `${esc(r.kategori.ikon)} ${esc(r.kategori.nama)}` : '<i>belum ada</i>'}`,
    `Penanggung akhir: ${esc(r.penanggung)}`,
    e.project ? `Proyek: ${esc(e.project)}` : null,
    e.note ? `Catatan: ${esc(e.note)}` : null,
    `Status: ${esc(e.status.replace(/_/g, ' '))} · Sumber: ${esc(e.source)}`,
  ]
    .filter((x): x is string => x !== null)
    .join('\n');
  const L = opts.dariDaftar !== undefined ? `:L${opts.dariDaftar}` : '';
  const baris: Tombol[][] = [
    [tombolData('📂 Kategori', `t:k:${e.id}`), tombolData('✏️ Koreksi', `t:e:${e.id}`)],
    [tombolData('👥 Bagi Biaya', `t:b:${e.id}`), tombolData('↩️ Reimburse', `t:r:${e.id}`)],
    [tombolData('🔄 Jenis', `t:J:${e.id}`), tombolData('📎 Bukti', `t:bk:${e.id}`)],
  ];
  if (opts.dariDaftar !== undefined) baris.push([tombolData('⬅️ Hasil Pencarian', `t:l:${opts.dariDaftar}`), MENU_UTAMA]);
  else baris.push([tombolData('⬅️ Lebih Baru', `t:n:${e.id}`), tombolData('➡️ Berikutnya', `t:o:${e.id}`)], [MENU_UTAMA]);
  void L;
  return { teks, tombol: baris };
}

function kembaliKe(eventId: number, dariDaftar?: number): string {
  return `t:v:${eventId}${dariDaftar !== undefined ? `:L${dariDaftar}` : ''}`;
}

export function tanganiKartu(parts: string[], ctx: Konteks, database: DB = db()): Hasil {
  const aksi = parts[1] ?? '';
  const eventId = Number(parts[2]);
  const arg = parts[3];
  const dariDaftar = arg?.startsWith('L') && aksi === 'v' ? Number(arg.slice(1)) : undefined;

  try {
    if (aksi === 'o' || aksi === 'n') {
      // Berikutnya = lebih lama, Lebih Baru = lebih baru; berdasarkan urutan yang sama dengan daftar.
      const cur = eventId ? getCashEvent(eventId, database) : undefined;
      const op = aksi === 'o' ? '<' : '>';
      const urut = aksi === 'o' ? 'DESC' : 'ASC';
      const row = cur
        ? (database
            .prepare(
              `SELECT id FROM cash_event WHERE status <> 'dibatalkan'
                 AND (occurred_at ${op} ? OR (occurred_at = ? AND id ${op} ?))
               ORDER BY occurred_at ${urut}, id ${urut} LIMIT 1`,
            )
            .get(cur.occurred_at, cur.occurred_at, cur.id) as { id: number } | undefined)
        : (database.prepare(`SELECT id FROM cash_event WHERE status <> 'dibatalkan' ORDER BY occurred_at DESC, id DESC LIMIT 1`).get() as
            | { id: number }
            | undefined);
      if (!row) return { toast: aksi === 'o' ? 'Ini transaksi paling lama.' : 'Ini transaksi terbaru.' };
      return { layar: layarKartu(row.id, {}, database) };
    }

    const ev = Number.isInteger(eventId) ? getCashEvent(eventId, database) : undefined;
    if (!ev && aksi !== 'l') return { toast: 'Transaksi tidak ditemukan.' };

    switch (aksi) {
      case 'v':
        clearState(ctx.chatId, 'utama', database);
        return { layar: layarKartu(eventId, { dariDaftar }, database) };

      case 'k':
        return {
          layar: layarPilihKategori(
            '<b>Pilih kategori untuk transaksi ini</b>',
            Number(arg ?? 0),
            (id) => `t:c:${eventId}:${id}`,
            (h) => `t:k:${eventId}:${h}`,
            `t:kn:${eventId}`,
            kembaliKe(eventId),
            database,
          ),
        };
      case 'c': {
        const { nama, berubah } = setKategoriTransaksi(eventId, Number(arg), 'telegram', database);
        return { toast: berubah ? `Kategori: ${nama}` : `Sudah ${nama}`, layar: layarKartu(eventId, {}, database) };
      }
      case 'kn':
        setState(ctx.chatId, { t: 'kat_baru', step: 'nama', eventId, balik: kembaliKe(eventId) }, 'utama', 45, database);
        return {
          layar: {
            teks: '➕ <b>Kategori baru</b>\nKategori baru mau diberi nama apa?',
            tombol: [[tombolData('❌ Batal', kembaliKe(eventId))]],
          },
        };

      case 'J':
        return { layar: layarPilihJenis(ev!.direction, (k) => `t:j:${eventId}:${k}`, kembaliKe(eventId)) };
      case 'j': {
        const hasil = terapkanJenis(eventId, arg as KodeJenis, 'telegram', database);
        if (hasil.perluInput === 'bagi') {
          setState(ctx.chatId, { t: 'bagi', cash_event_id: eventId, nominal_minor: ev!.amount_minor }, 'utama', 45, database);
          return { layar: { teks: `👥 ${esc(hasil.pesan)}`, tombol: [[tombolData('❌ Batal', kembaliKe(eventId))]] } };
        }
        return { toast: 'Jenis diperbarui', layar: layarKartu(eventId, {}, database) };
      }

      case 'r': {
        const hasil = terapkanJenis(eventId, 'reimburse', 'telegram', database);
        return { toast: 'Dicatat sebagai reimburse', layar: layarKartu(eventId, {}, database), pesanBaru: [{ teks: esc(hasil.pesan) }] };
      }
      case 'b': {
        setState(ctx.chatId, { t: 'bagi', cash_event_id: eventId, nominal_minor: ev!.amount_minor }, 'utama', 45, database);
        return {
          layar: {
            teks: `👥 <b>Bagi biaya</b>\nTotal ${rp(ev!.amount_minor)}. Tulis pembagiannya, misalnya "aku 30rb, 3 teman" atau "berempat".`,
            tombol: [[tombolData('❌ Batal', kembaliKe(eventId))]],
          },
        };
      }

      case 'e':
        return {
          layar: {
            teks: '✏️ <b>Koreksi transaksi</b>\nApa yang mau diubah? Semua perubahan tercatat di riwayat.',
            tombol: [
              [tombolData('💵 Nominal', `t:ef:${eventId}:jumlah`), tombolData('🏪 Merchant', `t:ef:${eventId}:merchant`)],
              [tombolData('📅 Tanggal', `t:ef:${eventId}:tanggal`), tombolData('📝 Catatan', `t:ef:${eventId}:catatan`)],
              [tombolData('🗂️ Proyek', `t:ef:${eventId}:proyek`), tombolData('🏦 Rekening', `t:rk:${eventId}`)],
              navigasi(kembaliKe(eventId)),
            ],
          },
        };
      case 'ef': {
        const prompt: Record<string, string> = {
          jumlah: 'Nominal yang benar berapa? Contoh: 35rb',
          merchant: 'Nama merchant yang benar? Contoh: Kantin Kampus',
          tanggal: 'Tanggal yang benar? Contoh: kemarin, 2026-11-10, atau 10/11',
          catatan: 'Tulis catatannya (kirim "-" untuk menghapus).',
          proyek: 'Nama proyeknya? Contoh: MEDCOEL (kirim "-" untuk menghapus).',
        };
        const field = arg ?? '';
        if (!prompt[field]) return { toast: 'Bagian itu tidak dikenal.' };
        setState(ctx.chatId, { t: 'koreksi', eventId, field }, 'utama', 45, database);
        return { layar: { teks: `✏️ ${esc(prompt[field]!)}`, tombol: [[tombolData('❌ Batal', kembaliKe(eventId))]] } };
      }
      case 'rk':
        return { layar: layarPilihRekening((id) => `t:ra:${eventId}:${id}`, kembaliKe(eventId), database) };
      case 'ra': {
        ubahTransaksi(eventId, { rekening_id: Number(arg) }, 'telegram', database);
        return { toast: 'Rekening diperbarui', layar: layarKartu(eventId, {}, database) };
      }

      case 'bk': {
        const bukti = database
          .prepare(
            `SELECT e.kind, e.subject, e.from_email, e.received_at, e.permalink, cee.role
               FROM cash_event_evidence cee JOIN evidence e ON e.id = cee.evidence_id
              WHERE cee.cash_event_id = ? ORDER BY e.received_at DESC LIMIT 8`,
          )
          .all(eventId) as Array<{ kind: string; subject: string | null; from_email: string | null; received_at: string; permalink: string | null; role: string }>;
        const teks =
          bukti.length === 0
            ? '📎 <b>Bukti</b>\nBelum ada bukti tertaut ke transaksi ini (dicatat manual).'
            : '📎 <b>Bukti</b>\n' +
              bukti
                .map((b) => `• ${esc(b.subject ?? b.kind)} — ${esc(b.role)}, ${esc(formatTanggal(dateOf(b.received_at)))}`)
                .join('\n');
        const tautan: Tombol[][] = bukti.filter((b) => b.permalink).slice(0, 3).map((b, i) => [{ t: `🔗 Buka bukti ${i + 1}`, url: b.permalink! }]);
        return { layar: { teks, tombol: [...tautan, navigasi(kembaliKe(eventId))] } };
      }

      case 'mem': {
        if (ev!.merchant_id && ev!.category_id) {
          setMerchantDefaultCategory(ev!.merchant_id, ev!.category_id, 'telegram', database);
          return { toast: 'Diingat untuk merchant ini', hapusTombol: true };
        }
        return { toast: 'Belum ada merchant/kategori untuk diingat.' };
      }
      default:
        return { toast: 'Tombol ini tidak dikenali.' };
    }
  } catch (err) {
    return { toast: (err as Error).message.slice(0, 180) };
  }
}
