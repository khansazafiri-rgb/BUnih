import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, jumlahTransaksi, kategori, pasangSaldo } from './bantu.js';
import { ASING, pasangBot } from './bot-uji.js';
import { ingestMessage } from '../src/gmail/ingest.js';
import type { MailMessage } from '../src/gmail/types.js';
import { sendPendingDecisions } from '../src/telegram/bot.js';
import { today, addDays } from '../src/domain/time.js';
import { analitik } from '../src/domain/analytics.js';
import { spendRows, sumSpend } from '../src/domain/spend.js';
import { putuskanKirimDefisit, setMute, type SnapshotDefisit } from '../src/notify/kontrol.js';
import { belumPernahDikirim, catatTerkirim, kumpulkanPengingat } from '../src/notify/index.js';
import { rencanaUang, teksRencanaUang } from '../src/domain/rencanaUang.js';
import { formatTanggalSingkat } from '../src/domain/time.js';
import { buatTransaksi } from '../src/domain/manualTx.js';
import { getState } from '../src/telegram/state.js';

let database: DB;
let nomor = 0;

function surat(nominal: string, opsi: { penerima?: string; tail?: string | null; tanggal?: string } = {}): MailMessage {
  nomor += 1;
  const tail = opsi.tail === undefined ? '****4821' : opsi.tail;
  return {
    id: `m-${nomor}-${Math.random().toString(36).slice(2)}`,
    from: 'noreply@bankmandiri.co.id',
    subject: 'Transaksi Berhasil',
    date: `${opsi.tanggal ?? today()}T14:05:00+07:00`,
    headers: {},
    labelIds: [],
    text: `Transfer berhasil\nNominal: ${nominal}\n${tail ? `Rekening Sumber: ${tail}\n` : ''}${opsi.penerima === '' ? '' : `Penerima: ${opsi.penerima ?? 'Toko Buku'}\n`}No. Referensi: REF${nomor}${Math.floor(Math.random() * 1e6)}`,
  };
}

beforeEach(() => {
  database = dbUji();
  database.prepare(`UPDATE account SET last4 = '4821', verified = 1 WHERE name LIKE '%Mandiri%'`).run();
  database.prepare(`UPDATE account SET last4 = '7733', verified = 1 WHERE name LIKE '%BCA%'`).run();
});

function eventTerbaru(): { id: number; category_id: number | null; account_id: number | null; status: string; kind: string } {
  return database.prepare(`SELECT id, category_id, account_id, status, kind FROM cash_event ORDER BY id DESC LIMIT 1`).get() as never;
}
function rowNotif(eventId: number): { id: number; state: string; message_id: string | null } {
  return database.prepare(`SELECT id, state, message_id FROM tg_message WHERE kind = 'transaksi' AND cash_event_id = ?`).get(eventId) as never;
}
const adaTombol = (labels: string[], cari: string) => labels.some((l) => l.includes(cari));

describe('1. notifikasi transaksi dari Gmail', () => {
  it('mengirim satu notifikasi interaktif yang merujuk ke id transaksi yang tepat', async () => {
    const b = pasangBot();
    ingestMessage(surat('Rp85.000'), database);
    const ev = eventTerbaru();
    const sebelum = jumlahTransaksi(database);

    expect(await sendPendingDecisions(5, database)).toBe(1);
    const teks = b.terakhirTeks();
    expect(teks).toContain('Transaksi baru terdeteksi');
    expect(teks).toContain('Rp85.000');
    expect(teks).toContain('Mandiri');
    expect(teks).toContain('Menunggu kategorisasi');

    const labels = b.terakhirTombolLabel();
    for (const kata of ['Kategori Baru', 'Semua Kategori', 'Ubah Jenis', 'Nanti Saja']) expect(adaTombol(labels, kata)).toBe(true);
    const data = b.terakhirTombol();
    const notif = rowNotif(ev.id);
    expect(notif.message_id).not.toBeNull();
    expect(data.filter((d) => d.startsWith('n:')).every((d) => d.startsWith(`n:${notif.id}:`))).toBe(true);
    expect(Math.max(...data.map((d) => Buffer.byteLength(d)))).toBeLessThanOrEqual(64);
    // Mengirim ulang tidak membuat notifikasi kedua dan tidak membuat transaksi baru.
    await sendPendingDecisions(5, database);
    expect(b.keluar.filter((k) => k.method === 'sendMessage').length).toBe(1);
    expect(jumlahTransaksi(database)).toBe(sebelum);
  });

  it('notifikasi tetap terkirim walau pengingat proyeksi dimatikan', async () => {
    database.prepare(`UPDATE notification_setting SET enabled = 0 WHERE type = 'saldo_di_bawah_cadangan'`).run();
    pasangBot();
    ingestMessage(surat('Rp40.000'), database);
    expect(await sendPendingDecisions(5, database)).toBe(1);
  });
});

describe('2–4, 7. kategori dengan satu klik, kategori baru, dan laporan', () => {
  it('alur lengkap: notifikasi → klik kategori → laporan ikut berubah, tanpa transaksi baru', async () => {
    const b = pasangBot();
    ingestMessage(surat('Rp85.000'), database);
    const ev = eventTerbaru();
    await sendPendingDecisions(5, database);
    const notif = rowNotif(ev.id);
    const sebelum = jumlahTransaksi(database);
    const makan = kategori(database, 'makan');

    await b.tekan(`n:${notif.id}:c:${makan}`, { pesan: Number(notif.message_id) });
    const sesudah = eventTerbaru();
    expect(sesudah.id).toBe(ev.id);
    expect(sesudah.category_id).toBe(makan);
    expect(jumlahTransaksi(database)).toBe(sebelum);
    expect(rowNotif(ev.id).state).toBe('selesai');
    expect(b.terakhirTeks()).toContain('Dikategorikan');

    // Alokasi dan analitik membaca perubahan yang sama.
    const alok = database.prepare(`SELECT category_id FROM allocation WHERE cash_event_id = ?`).all(ev.id) as Array<{ category_id: number | null }>;
    expect(alok.every((a) => a.category_id === makan)).toBe(true);
    const hasil = analitik({ preset: 'bulan_ini' }, database);
    const barisMakan = hasil.kategori.find((k) => k.category_id === makan);
    expect(barisMakan?.jumlah_minor).toBe(85_000);
    // Keputusan terkait tertutup.
    const dec = database.prepare(`SELECT state FROM pending_decision WHERE cash_event_id = ? AND kind = 'kategori_transaksi'`).get(ev.id) as { state: string };
    expect(dec.state).toBe('dijawab');
  });

  it('membuat kategori baru dari Telegram, memakainya, dan muncul pada transaksi berikutnya', async () => {
    const b = pasangBot();
    ingestMessage(surat('Rp120.000', { penerima: 'Restoran ABC' }), database);
    const ev = eventTerbaru();
    await sendPendingDecisions(5, database);
    const notif = rowNotif(ev.id);

    await b.tekan(`n:${notif.id}:new`, { pesan: Number(notif.message_id) });
    expect(b.terakhirTeks()).toContain('mau diberi nama apa');
    await b.kirimTeks('  pacaran ');
    expect(b.terakhirTeks()).toContain('Pacaran');
    expect(adaTombol(b.terakhirTombolLabel(), 'Simpan & Pakai')).toBe(true);
    expect(adaTombol(b.terakhirTombolLabel(), 'Ganti Nama')).toBe(true);
    expect(adaTombol(b.terakhirTombolLabel(), 'Batal')).toBe(true);
    await b.tekan('k:ok');

    const kat = database.prepare(`SELECT id, name, active FROM category WHERE lower(name) = 'pacaran'`).all() as Array<{ id: number; name: string; active: number }>;
    expect(kat).toHaveLength(1);
    expect(kat[0]!.name).toBe('Pacaran');
    expect(eventTerbaru().category_id).toBe(kat[0]!.id);
    expect(rowNotif(ev.id).state).toBe('selesai');

    // Transaksi berikutnya menawarkan kategori baru itu.
    ingestMessage(surat('Rp60.000', { penerima: 'Toko Lain' }), database);
    await sendPendingDecisions(5, database);
    expect(adaTombol(b.terakhirTombolLabel(), 'Pacaran')).toBe(true);
    // Dan ia terbaca di dashboard/analitik yang sama.
    const a = analitik({ preset: 'bulan_ini' }, database);
    expect(a.kategori.find((k) => k.nama === 'Pacaran')?.jumlah_minor).toBe(120_000);
  });

  it('tidak membuat kategori duplikat yang hanya beda kapitalisasi atau spasi', async () => {
    const b = pasangBot();
    ingestMessage(surat('Rp30.000'), database);
    const ev = eventTerbaru();
    await sendPendingDecisions(5, database);
    const notif = rowNotif(ev.id);
    await b.tekan(`n:${notif.id}:new`, { pesan: Number(notif.message_id) });
    await b.kirimTeks('MAKAN');
    expect(b.terakhirTeks()).toContain('sudah ada');
    await b.tekan('k:ok');
    const n = (database.prepare(`SELECT COUNT(*) AS n FROM category WHERE lower(replace(name,' ','')) = 'makan'`).get() as { n: number }).n;
    expect(n).toBe(1);
    expect(eventTerbaru().category_id).toBe(kategori(database, 'makan'));
  });
});

describe('5. ketahanan terhadap restart', () => {
  it('kategori dan percakapan setengah jalan bertahan setelah bot dibuat ulang', async () => {
    let b = pasangBot();
    ingestMessage(surat('Rp70.000'), database);
    const ev = eventTerbaru();
    await sendPendingDecisions(5, database);
    const notif = rowNotif(ev.id);
    await b.tekan(`n:${notif.id}:new`, { pesan: Number(notif.message_id) });
    expect(getState('1001', 'utama', database)?.t).toBe('kat_baru');

    // "Restart": instance bot baru, database yang sama.
    b = pasangBot();
    await b.kirimTeks('Nongkrong');
    expect(b.terakhirTeks()).toContain('Nongkrong');
    await b.tekan('k:ok');
    expect(database.prepare(`SELECT COUNT(*) AS n FROM category WHERE name = 'Nongkrong' AND active = 1`).get()).toEqual({ n: 1 });

    // Setelah restart lagi, kategori tetap ada dan tersedia di pilihan.
    b = pasangBot();
    await b.kirimTeks('/kategori');
    expect(b.terakhirTeks()).toContain('Kategori');
    let ketemu = adaTombol(b.terakhirTombolLabel(), 'Nongkrong');
    for (let h = 1; h < 6 && !ketemu; h += 1) {
      await b.tekan(`k:l:${h}`);
      ketemu = adaTombol(b.terakhirTombolLabel(), 'Nongkrong');
    }
    expect(ketemu).toBe(true);
  });
});

describe('6. ubah kategori dari /transaksi dan audit', () => {
  it('mengubah kategori transaksi lama, alokasi ikut berubah, dan tercatat di audit', async () => {
    const b = pasangBot();
    ingestMessage(surat('Rp55.000'), database);
    const ev = eventTerbaru();
    const makan = kategori(database, 'makan');
    const transport = kategori(database, 'transport');
    await sendPendingDecisions(5, database);
    const notif = rowNotif(ev.id);
    await b.tekan(`n:${notif.id}:c:${makan}`, { pesan: Number(notif.message_id) });

    await b.kirimTeks('/transaksi');
    expect(b.terakhirTeks()).toContain(`Transaksi #${ev.id}`);
    for (const kata of ['Kategori', 'Koreksi', 'Bagi Biaya', 'Reimburse', 'Bukti', 'Berikutnya']) expect(adaTombol(b.terakhirTombolLabel(), kata)).toBe(true);

    await b.tekan(`t:c:${ev.id}:${transport}`);
    expect(eventTerbaru().category_id).toBe(transport);
    const alok = database.prepare(`SELECT category_id FROM allocation WHERE cash_event_id = ?`).all(ev.id) as Array<{ category_id: number }>;
    expect(alok.every((a) => a.category_id === transport)).toBe(true);
    const audit = database.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'cash_event' AND entity_id = ? AND action = 'kategori_diubah'`).get(ev.id) as { n: number };
    expect(audit.n).toBeGreaterThanOrEqual(2);
    // Memilih kategori yang sama lagi tidak menulis audit baru.
    const sebelum = audit.n;
    await b.tekan(`t:c:${ev.id}:${transport}`);
    const sesudah = database.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'cash_event' AND entity_id = ? AND action = 'kategori_diubah'`).get(ev.id) as { n: number };
    expect(sesudah.n).toBe(sebelum);
  });
});

describe('8–9. tekan ganda dan tombol lama', () => {
  it('callback yang sama dua kali (id sama) hanya diproses sekali', async () => {
    const b = pasangBot();
    ingestMessage(surat('Rp25.000'), database);
    const ev = eventTerbaru();
    await sendPendingDecisions(5, database);
    const notif = rowNotif(ev.id);
    const makan = kategori(database, 'makan');
    await b.tekan(`n:${notif.id}:c:${makan}`, { id: 'cb-dobel', pesan: Number(notif.message_id) });
    const audit = () => (database.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'cash_event' AND entity_id = ?`).get(ev.id) as { n: number }).n;
    const a1 = audit();
    await b.tekan(`n:${notif.id}:c:${makan}`, { id: 'cb-dobel', pesan: Number(notif.message_id) });
    expect(audit()).toBe(a1);
  });

  it('tombol pada notifikasi yang sudah selesai tidak mengubah apa pun', async () => {
    const b = pasangBot();
    ingestMessage(surat('Rp25.000'), database);
    const ev = eventTerbaru();
    await sendPendingDecisions(5, database);
    const notif = rowNotif(ev.id);
    const makan = kategori(database, 'makan');
    const transport = kategori(database, 'transport');
    await b.tekan(`n:${notif.id}:c:${makan}`, { pesan: Number(notif.message_id) });
    const n = jumlahTransaksi(database);
    // Klik fisik kedua (callback id berbeda) pada tombol lama dengan kategori lain.
    await b.tekan(`n:${notif.id}:c:${transport}`, { pesan: Number(notif.message_id) });
    expect(eventTerbaru().category_id).toBe(makan);
    expect(jumlahTransaksi(database)).toBe(n);
    expect(b.keluar.some((k) => k.method === 'answerCallbackQuery' && /sudah selesai/i.test(String(k.payload['text'] ?? '')))).toBe(true);
  });

  it('callback lama atau rusak tidak merusak data', async () => {
    const b = pasangBot();
    ingestMessage(surat('Rp25.000'), database);
    const ev = eventTerbaru();
    const n = jumlahTransaksi(database);
    await b.tekan('n:99999:c:1');
    await b.tekan('n:abc:c:1');
    await b.tekan('t:c:99999:1');
    await b.tekan('k:mgx:999:998');
    await b.tekan('zzz:1:2');
    expect(jumlahTransaksi(database)).toBe(n);
    expect(eventTerbaru().category_id).toBe(ev.category_id);
  });
});

describe('10. akses', () => {
  it('pengguna tidak sah tidak mendapat jawaban dan tidak bisa mengubah data', async () => {
    const b = pasangBot();
    ingestMessage(surat('Rp25.000'), database);
    const ev = eventTerbaru();
    await sendPendingDecisions(5, database);
    const notif = rowNotif(ev.id);
    const makan = kategori(database, 'makan');
    const awal = b.keluar.length;
    await b.kirimTeks('/menu', ASING);
    await b.kirimTeks('/transaksi', ASING);
    await b.tekan(`n:${notif.id}:c:${makan}`, { chat: ASING });
    expect(b.keluar.length).toBe(awal);
    expect(eventTerbaru().category_id).toBe(ev.category_id);
    expect(rowNotif(ev.id).state).toBe('aktif');
  });
});

describe('11. Gmail dan Telegram tidak mencatat transaksi yang sama dua kali', () => {
  it('catatan manual dari Telegram lalu notifikasi bank yang sama menjadi satu transaksi', async () => {
    const b = pasangBot();
    await b.kirimTeks('beli buku 75rb di toko buku pakai mandiri');
    expect(b.terakhirTeks()).toContain('Simpan transaksi ini?');
    await b.tekan('c:ok');
    expect(jumlahTransaksi(database)).toBe(1);
    ingestMessage(surat('Rp75.000', { penerima: 'Toko Buku' }), database);
    expect(jumlahTransaksi(database)).toBe(1);
  });

  it('tekan Simpan dua kali tidak membuat dua transaksi', async () => {
    const b = pasangBot();
    await b.kirimTeks('makan 35rb di kantin pakai mandiri');
    await b.tekan('c:ok');
    await b.tekan('c:ok');
    expect(jumlahTransaksi(database)).toBe(1);
  });

  it('memproses ulang email yang sama tidak membuat notifikasi baru', async () => {
    const b = pasangBot();
    const msg = surat('Rp45.000');
    ingestMessage(msg, database);
    ingestMessage(msg, database);
    await sendPendingDecisions(5, database);
    await sendPendingDecisions(5, database);
    expect(jumlahTransaksi(database)).toBe(1);
    expect(b.keluar.filter((k) => k.method === 'sendMessage').length).toBe(1);
  });
});

describe('13. merchant atau rekening belum jelas', () => {
  it('email tanpa rekening: ditandai belum teridentifikasi dan bisa dipilihkan rekening', async () => {
    const b = pasangBot();
    // Bank dikenali tetapi rekening tidak bisa dipastikan (belum diverifikasi): jangan ditebak.
    database.prepare(`UPDATE account SET verified = 0`).run();
    ingestMessage(surat('Rp90.000', { tail: null, penerima: '' }), database);
    const ev = eventTerbaru();
    expect(ev.account_id).toBeNull();
    await sendPendingDecisions(5, database);
    expect(b.terakhirTeks()).toContain('belum teridentifikasi');
    expect(b.terakhirTeks()).toContain('Belum diketahui');
    const notif = rowNotif(ev.id);
    expect(adaTombol(b.terakhirTombolLabel(), 'Pilih Rekening')).toBe(true);
    // Kategorisasi tetap aman tanpa rekening.
    await b.tekan(`n:${notif.id}:c:${kategori(database, 'makan')}`, { pesan: Number(notif.message_id) });
    expect(eventTerbaru().category_id).toBe(kategori(database, 'makan'));
    expect(eventTerbaru().account_id).toBeNull();
  });

  it('/catat dari kalimat tanpa rekening bertanya, bukan memilih rekening pertama', async () => {
    const b = pasangBot();
    await b.kirimTeks('makan 35rb di kantin');
    expect(b.terakhirTeks()).toContain('rekening mana');
    expect(jumlahTransaksi(database)).toBe(0);
    await b.tekan('c:a:x'); // belum teridentifikasi
    expect(b.terakhirTeks()).toContain('belum teridentifikasi');
    await b.tekan('c:ok');
    const ev = eventTerbaru();
    expect(ev.account_id).toBeNull();
    expect(ev.status).toBe('perlu_verifikasi');
  });

  it('kalimat bebas mengusulkan kategori Makanan dan merchant Kantin, lalu meminta konfirmasi', async () => {
    const b = pasangBot();
    await b.kirimTeks('Bayar makan 35rb di kantin pakai Mandiri.');
    const t = b.terakhirTeks();
    expect(t).toContain('Makan');
    expect(t).toContain('Kantin');
    expect(t).toContain('Mandiri');
    expect(t).toContain('Rp35.000');
    expect(jumlahTransaksi(database)).toBe(0);
    await b.tekan('c:ok');
    const ev = eventTerbaru();
    expect(ev.account_id).toBe(akun(database, 'Mandiri'));
    expect(ev.category_id).toBe(kategori(database, 'makan'));
  });
});

describe('14. jenis transaksi tidak salah dihitung', () => {
  async function notif(nominal: string) {
    const b = pasangBot();
    ingestMessage(surat(nominal, { penerima: 'Pihak X' }), database);
    const ev = eventTerbaru();
    await sendPendingDecisions(5, database);
    return { b, ev, rid: rowNotif(ev.id).id, pesan: Number(rowNotif(ev.id).message_id) };
  }
  const total = () => sumSpend(spendRows(addDays(today(), -1), addDays(today(), 1), {}, database));

  it('reimburse company, transfer sendiri, tabungan, company langsung, dan talangan bukan pengeluaran pribadi', async () => {
    for (const jenis of ['reimburse', 'transfer', 'tabungan', 'company', 'talangan']) {
      const { b, ev, rid, pesan } = await notif('Rp100.000');
      // Mulai sebagai pengeluaran pribadi (satu klik kategori), lalu ubah jenisnya dari kartu transaksi.
      await b.tekan(`n:${rid}:c:${kategori(database, 'makan')}`, { pesan });
      const sebelum = total();
      await b.tekan(`t:j:${ev.id}:${jenis}`);
      expect(total(), `jenis ${jenis}`).toBe(sebelum - 100_000);
    }
  });

  it('dari notifikasi, jenis yang menutup (transfer, reimburse, ...) menyelesaikan notifikasi', async () => {
    for (const jenis of ['reimburse', 'transfer', 'tabungan', 'company', 'talangan']) {
      const { b, ev, rid, pesan } = await notif('Rp100.000');
      await b.tekan(`n:${rid}:j:${jenis}`, { pesan });
      expect(rowNotif(ev.id).state, jenis).toBe('selesai');
    }
  });

  it('pengeluaran pribadi dan hadiah tetap dihitung penuh', async () => {
    const { b, rid, pesan } = await notif('Rp80.000');
    expect(total()).toBe(0); // belum diklasifikasi: belum dihitung sebagai pengeluaran
    await b.tekan(`n:${rid}:j:hadiah`, { pesan });
    expect(total()).toBe(80_000);
  });

  it('pembayaran bersama: hanya bagianku yang dihitung', async () => {
    const { b, rid, pesan, ev } = await notif('Rp200.000');
    await b.tekan(`n:${rid}:j:bersama`, { pesan });
    expect(b.terakhirTeks()).toContain('pembagiannya');
    await b.kirimTeks('aku 50rb, 3 teman');
    expect(total()).toBe(50_000);
    const piutang = database.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS n FROM allocation WHERE cash_event_id = ? AND purpose = 'piutang_teman'`).get(ev.id) as { n: number };
    expect(piutang.n).toBe(150_000);
  });

  it('jenis hanya untuk uang keluar ditolak pada uang masuk, tanpa mengubah data', async () => {
    const b = pasangBot();
    buatTransaksi({ jenis: 'pemasukan', jumlah_minor: 500_000, rekening_id: akun(database, 'Mandiri'), merchant: 'Kantor' }, 'uji', database);
    const ev = eventTerbaru();
    await b.tekan(`t:j:${ev.id}:reimburse`);
    expect(eventTerbaru().kind).toBe('pemasukan_luar');
  });
});

describe('9. notifikasi defisit tidak berulang', () => {
  const kondisi = (o: Partial<{ hari: string; jenis: 'defisit' | 'rendah'; kekurangan: number; tgl: string | null; ok: boolean }> = {}) => ({
    hari: o.hari ?? '2026-11-13', jenis: o.jenis ?? ('defisit' as const), tanggalDefisit: o.tgl === undefined ? '2026-11-20' : o.tgl,
    kekurangan_minor: o.kekurangan ?? 1_000_000, terverifikasi: o.ok ?? true,
  });
  const snap = (k: ReturnType<typeof kondisi>, jam = 1, jumlah = 1): SnapshotDefisit => ({
    hari: k.hari, at: new Date(Date.now() - jam * 3_600_000).toISOString(), jenis: k.jenis, tanggalDefisit: k.tanggalDefisit,
    kekurangan_minor: k.kekurangan_minor, terverifikasi: k.terverifikasi, jumlahHariIni: jumlah,
  });

  it('perubahan kecil pada angka proyeksi tidak memicu peringatan baru di hari yang sama', () => {
    const a = kondisi();
    expect(putuskanKirimDefisit(a, null).kirim).toBe(true);
    expect(putuskanKirimDefisit(kondisi({ kekurangan: 1_030_000 }), snap(a, 5)).kirim).toBe(false);
    expect(putuskanKirimDefisit(kondisi({ kekurangan: 1_100_000 }), snap(a, 5)).kirim).toBe(false);
  });

  it('perubahan material (naik ≥25% dan ≥Rp250rb, atau tanggal maju ≥3 hari) tetap diperingatkan, dengan jeda', () => {
    const a = kondisi();
    expect(putuskanKirimDefisit(kondisi({ kekurangan: 1_400_000 }), snap(a, 5)).alasan).toBe('material');
    expect(putuskanKirimDefisit(kondisi({ kekurangan: 1_400_000 }), snap(a, 1)).kirim).toBe(false); // terlalu cepat
    expect(putuskanKirimDefisit(kondisi({ tgl: '2026-11-16' }), snap(a, 5)).alasan).toBe('material');
    expect(putuskanKirimDefisit(kondisi({ jenis: 'defisit' }), snap(kondisi({ jenis: 'rendah' }), 5)).alasan).toBe('eskalasi');
  });

  it('hari berikutnya dikirim lagi (satu per hari), tidak lebih', () => {
    const a = kondisi();
    expect(putuskanKirimDefisit(kondisi({ hari: '2026-11-14' }), snap(a, 24)).alasan).toBe('harian');
  });

  it('saldo belum terverifikasi: tidak ada pengecualian material dan jarak minimal 3 hari', () => {
    const a = kondisi({ ok: false });
    expect(putuskanKirimDefisit(kondisi({ ok: false, kekurangan: 5_000_000 }), snap(a, 8)).kirim).toBe(false);
    expect(putuskanKirimDefisit(kondisi({ ok: false, hari: '2026-11-14' }), snap(a, 24)).kirim).toBe(false);
    expect(putuskanKirimDefisit(kondisi({ ok: false, hari: '2026-11-16' }), snap(a, 72)).kirim).toBe(true);
  });

  it('terintegrasi: peringatan tidak diulang walau transaksi kecil mengubah saldo terendah', () => {
    pasangSaldo(database, 'Mandiri', 50_000, 0);
    const p1 = kumpulkanPengingat('langsung', database).filter((p) => p.type === 'saldo_di_bawah_cadangan');
    expect(p1.length).toBe(1);
    expect(p1[0]!.dedupe_key).toMatch(/^defisit:\d{4}-\d{2}-\d{2}:1$/); // tanpa angka saldo
    expect(p1[0]!.text).toContain('Rencana');
    expect(p1[0]!.text).toContain('Uang yang sebaiknya sudah ada sekarang');
    expect(p1[0]!.text).not.toMatch(/kekurangan|perlu tambahan/i);
    expect(p1[0]!.tombol?.flat().map((b) => ('d' in b ? b.d : '')).join(' ')).toMatch(/p:sebab.*p:tunda.*p:mute/);
    catatTerkirim(p1[0]!, database);

    // Transaksi kecil mengubah proyeksi sedikit.
    buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 5_000, rekening_id: akun(database, 'Mandiri'), kategori_id: kategori(database, 'makan') }, 'uji', database);
    const p2 = kumpulkanPengingat('langsung', database).filter((p) => p.type === 'saldo_di_bawah_cadangan');
    expect(p2.length).toBe(0);
  });

  it('saldo belum terverifikasi ditampilkan sebagai perkiraan, bukan kondisi aktual', () => {
    // dbUji (warisan) tidak punya titik tambat saldo: saldo dasar berasal dari asumsi awal.
    const p = kumpulkanPengingat('langsung', database).filter((x) => x.type === 'saldo_di_bawah_cadangan');
    for (const x of p) {
      expect(x.text).toContain('Perkiraan — saldo belum diverifikasi');
      expect(x.text).toMatch(/bukan kondisi keuangan aktual/);
      expect(x.prioritas).toBeGreaterThanOrEqual(3);
    }
  });

  it('Bisukan menahan pengingat; Ingatkan Nanti menunda', async () => {
    pasangSaldo(database, 'Mandiri', 50_000, 0);
    const b = pasangBot();
    expect(kumpulkanPengingat('langsung', database).some((p) => p.type === 'saldo_di_bawah_cadangan')).toBe(true);
    await b.tekan('p:mute');
    expect(kumpulkanPengingat('langsung', database).some((p) => p.type === 'saldo_di_bawah_cadangan')).toBe(false);
    setMute('saldo_di_bawah_cadangan', null, database);
    expect(kumpulkanPengingat('langsung', database).some((p) => p.type === 'saldo_di_bawah_cadangan')).toBe(true);
    await b.tekan('p:tunda');
    expect(kumpulkanPengingat('langsung', database).some((p) => p.type === 'saldo_di_bawah_cadangan')).toBe(false);
  });

  it('Lihat Penyebab menjelaskan dari angka proyeksi, termasuk status saldo', async () => {
    const b = pasangBot();
    await b.tekan('p:sebab');
    expect(b.terakhirTeks()).toContain('Penyebab');
    expect(b.terakhirTeks()).toMatch(/belum terverifikasi|terverifikasi/);
  });
});

describe('rencana uang 7 hari (bukan "kekurangan berapa juta")', () => {
  it('menghitung kebutuhan, uang yang disarankan, dan batas harian dari angka yang konsisten', () => {
    pasangSaldo(database, 'Mandiri', 100_000_000, -1);
    const aman = rencanaUang(database);
    expect(aman.status).toBe('aman');
    expect(aman.disarankan_sekarang_minor).toBe(aman.kebutuhan_7_hari_minor + aman.cadangan_minimal_minor);
    expect(aman.kebutuhan_7_hari_minor).toBe(aman.tagihan_7_hari_minor + aman.makan_7_hari_minor);
    expect(aman.batas_harian_minor).toBeGreaterThan(0);
    expect(aman.perlu_masuk_minor).toBe(0);

    database.prepare(`DELETE FROM reconciliation`).run();
    pasangSaldo(database, 'Mandiri', 0, -1);
    const kurang = rencanaUang(database);
    expect(kurang.status).toBe('kurang');
    expect(kurang.perlu_masuk_minor).toBe(kurang.disarankan_sekarang_minor - (kurang.saldo_sekarang_minor ?? 0));
    expect(kurang.batas_harian_minor).toBe(0);
    const teks = teksRencanaUang(kurang, (s) => s, formatTanggalSingkat);
    expect(teks).toContain('Tenggat terdekat');
    expect(teks).toContain('Harus siap 7 hari ke depan');
    expect(teks).toContain('Uang yang sebaiknya sudah ada sekarang');
    expect(teks).toContain('Rencana:');
    expect(teks).not.toMatch(/kekurangan/i);
  });
});

describe('menu, perintah, dan navigasi', () => {
  it('/menu menampilkan menu utama dengan tombol ke semua bagian', async () => {
    const b = pasangBot();
    await b.kirimTeks('/menu');
    const data = b.terakhirTombol();
    for (const d of ['c:menu', 'k:l:0', 'a:l', 'g:l', 'l:menu', 'r:l', 'b:l', 's:l']) expect(data).toContain(d);
  });

  it('setiap perintah utama merespons dengan tombol navigasi', async () => {
    const b = pasangBot();
    for (const c of ['/catat', '/transaksi', '/kategori', '/anggaran', '/target', '/laporan', '/rekening', '/tagihan', '/pengaturan', '/bantuan', '/rencana']) {
      const n = b.keluar.length;
      await b.kirimTeks(c);
      expect(b.keluar.length, c).toBeGreaterThan(n);
      expect(b.terakhirTombol().some((d) => d === 'm:home'), c).toBe(true);
    }
  });

  it('pagination kategori: banyak kategori dibagi per halaman dengan Berikutnya/Sebelumnya', async () => {
    for (let i = 1; i <= 20; i += 1) database.prepare(`INSERT INTO category (slug, name, group_name, is_routine, active, sort_order, created_at) VALUES (?, ?, 'lainnya', 0, 1, ?, datetime('now'))`).run(`kat-${i}`, `Kategori Uji ${i}`, 100 + i);
    const b = pasangBot();
    await b.kirimTeks('/kategori');
    expect(b.terakhirTombol()).toContain('k:l:1');
    await b.tekan('k:l:1');
    expect(b.terakhirTombol()).toContain('k:l:0');
    expect(Math.max(...b.terakhirTombol().map((d) => Buffer.byteLength(d)))).toBeLessThanOrEqual(64);
  });

  it('anggaran dan target dari kalimat: konfirmasi lalu tersimpan, tanpa transaksi', async () => {
    const b = pasangBot();
    const n = jumlahTransaksi(database);
    await b.kirimTeks('Buat anggaran Pacaran Rp500 ribu per bulan');
    expect(b.terakhirTeks()).toContain('kategori baru akan dibuat');
    await b.tekan('a:ok');
    const ag = database.prepare(`SELECT b.amount_minor, b.period, c.name FROM budget b JOIN category c ON c.id = b.category_id WHERE c.name = 'Pacaran'`).get() as { amount_minor: number; period: string; name: string };
    expect(ag).toEqual({ amount_minor: 500_000, period: 'bulanan', name: 'Pacaran' });
    await b.kirimTeks('Target laptop Rp8 juta sebelum Juni 2027');
    expect(b.terakhirTeks()).toContain('Target baru');
    await b.tekan('g:ok');
    const g = database.prepare(`SELECT name, target_minor, target_date FROM goal WHERE name = 'Laptop'`).get() as { name: string; target_minor: number; target_date: string };
    expect(g.target_minor).toBe(8_000_000);
    expect(g.target_date).toBe('2027-06-30');
    expect(b.terakhirTeks()).toContain('Masih kurang');
    expect(jumlahTransaksi(database)).toBe(n);
  });

  it('gabung dan arsip kategori tidak menghilangkan riwayat transaksi', async () => {
    const b = pasangBot();
    const makan = kategori(database, 'makan');
    const groc = kategori(database, 'groceries');
    buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 20_000, rekening_id: akun(database, 'Mandiri'), kategori_id: groc }, 'uji', database);
    await b.tekan(`k:mgx:${groc}:${makan}`);
    const ev = eventTerbaru();
    expect(ev.category_id).toBe(makan);
    const lama = database.prepare(`SELECT active, merged_into FROM category WHERE id = ?`).get(groc) as { active: number; merged_into: number };
    expect(lama).toEqual({ active: 0, merged_into: makan });
    expect((database.prepare(`SELECT COUNT(*) AS n FROM category WHERE id = ?`).get(groc) as { n: number }).n).toBe(1);
  });

  it('pencarian transaksi berdasarkan merchant, kategori, dan nominal', async () => {
    const b = pasangBot();
    buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 35_000, rekening_id: akun(database, 'Mandiri'), kategori_id: kategori(database, 'makan'), merchant: 'Kantin Kampus' }, 'uji', database);
    buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 18_000, rekening_id: akun(database, 'Mandiri'), kategori_id: kategori(database, 'transport'), merchant: 'Gojek' }, 'uji', database);
    await b.kirimTeks('/transaksi kantin');
    expect(b.terakhirTeks()).toContain('1 transaksi');
    await b.kirimTeks('/transaksi transport');
    expect(b.terakhirTeks()).toContain('1 transaksi');
    await b.kirimTeks('/transaksi 35rb');
    expect(b.terakhirTeks()).toContain('1 transaksi');
    await b.kirimTeks('/transaksi tidak-ada-yang-cocok');
    expect(b.terakhirTeks()).toContain('Tidak ada transaksi');
  });
});
