import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, jumlahTransaksi, kategori } from './bantu.js';
import { recordCashEvent } from '../src/domain/ledger.js';
import { HARI_ACUAN, isiDataUji } from './data-uji.js';
import {
  adalahPermintaanBuatTujuan, adalahPertanyaanPengeluaran, adalahPertanyaanTujuan, jawabDariTombol,
  jawabPertanyaanPengeluaran, parseTanggalTarget, parseTujuan, parseWaktu, pertanyaanTujuan, simpanTujuan,
  uraiMerchantProyek, waktuDariKunci,
} from '../src/telegram/analitikBot.js';
import { createBudget } from '../src/domain/budgets.js';
import { belumPernahDikirim, catatTerkirim, kumpulkanPengingat } from '../src/notify/index.js';
import { bantuan, ringkasanAnggaran } from '../src/telegram/format.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
});

describe('waktu dalam pertanyaan', () => {
  it('mengenali frasa umum dan default ke bulan ini', () => {
    expect(parseWaktu('berapa makan kemarin', HARI_ACUAN).kunci).toBe('kmrn');
    expect(parseWaktu('berapa makan minggu lalu', HARI_ACUAN).kunci).toBe('mgl');
    expect(parseWaktu('berapa makan bulan lalu', HARI_ACUAN).kunci).toBe('bl');
    expect(parseWaktu('berapa makan', HARI_ACUAN).kunci).toBe('bi');
  });

  it('minggu ini mulai hari Senin', () => {
    // 2026-11-20 adalah hari Jumat; Senin = 2026-11-16.
    expect(waktuDariKunci('mg', HARI_ACUAN).spec).toEqual({ dari: '2026-11-16', sampai: HARI_ACUAN });
    const lalu = waktuDariKunci('mgl', HARI_ACUAN).spec;
    expect(lalu).toEqual({ dari: '2026-11-09', sampai: '2026-11-15' });
  });
});

describe('jawaban analitik deterministik', () => {
  it('total bulan ini sama dengan angka yang bisa dihitung manual, dengan pembanding yang adil', () => {
    isiDataUji(database);
    const j = jawabPertanyaanPengeluaran('berapa total pengeluaran bulan ini', database, HARI_ACUAN);
    expect(j.teks).toContain('Rp640.000');
    // Oktober hari ke-1..20 = 270.000 -> naik 137%
    expect(j.teks).toContain('Naik 137%');
    expect(j.teks).toContain('Rp270.000');
    expect(j.teks).toMatch(/Tidak termasuk transfer/);
  });

  it('jawaban per kategori mengikuti definisi pengeluaran yang sama dengan web', () => {
    isiDataUji(database);
    const j = jawabPertanyaanPengeluaran('berapa pengeluaran makan bulan ini', database, HARI_ACUAN);
    expect(j.teks).toContain('Rp460.000');
    const h = jawabPertanyaanPengeluaran('berapa hiburan bulan ini', database, HARI_ACUAN);
    // 100.000 dikurangi refund 20.000
    expect(h.teks).toContain('Rp80.000');
  });

  it('nama tempat didahulukan daripada kata kategori', () => {
    isiDataUji(database);
    const j = jawabPertanyaanPengeluaran('berapa belanja di Gojek bulan ini', database, HARI_ACUAN);
    expect(j.pilihan).toBeUndefined();
    expect(j.teks).toContain('Gojek');
    expect(j.teks).toContain('Rp60.000');
  });

  it('bertanya balik bila kategori ambigu, lalu menjawab setelah dipilih', () => {
    isiDataUji(database);
    const j = jawabPertanyaanPengeluaran('berapa langganan bulan ini', database, HARI_ACUAN);
    expect(j.pilihan && j.pilihan.length).toBeGreaterThanOrEqual(2);
    expect(j.teks).toMatch(/Kategori mana/);
    const jawab = jawabDariTombol(j.pilihan![0]!.data, database, HARI_ACUAN);
    expect(jawab?.teks).toMatch(/Belum ada pengeluaran/);
  });

  it('data kosong dijawab jujur, tanpa angka karangan', () => {
    const j = jawabPertanyaanPengeluaran('berapa pengeluaran bulan ini', database, HARI_ACUAN);
    expect(j.teks).toMatch(/Belum ada pengeluaran tercatat/);
    expect(j.teks).not.toMatch(/Rp\d/);
  });

  it('paling banyak habis buat apa: urut dari terbesar, dan menyebut yang belum dikategorikan', () => {
    isiDataUji(database);
    const j = jawabPertanyaanPengeluaran('paling banyak habis buat apa bulan ini', database, HARI_ACUAN);
    expect(j.teks.indexOf('Makan')).toBeGreaterThan(-1);
    expect(j.teks.indexOf('Makan')).toBeLessThan(j.teks.indexOf('Transport'));
    expect(j.teks).toMatch(/belum punya kategori/);
  });

  it('bukan pertanyaan: pencatatan biasa tidak ditangkap', () => {
    expect(adalahPertanyaanPengeluaran('makan 25 ribu')).toBe(false);
    expect(adalahPertanyaanPengeluaran('berapa pengeluaran makan bulan ini?')).toBe(true);
    expect(adalahPertanyaanPengeluaran('bandingkan bulan ini dengan bulan lalu')).toBe(true);
    expect(adalahPertanyaanPengeluaran('paling banyak habis buat apa minggu ini')).toBe(true);
  });
});

describe('membuat tujuan lewat Telegram', () => {
  it('menguraikan nama, target, dan tenggat', () => {
    const d = parseTujuan('buat tujuan laptop 8 juta 6 bulan lagi', '2026-11-20');
    expect(d).toEqual({ nama: 'Laptop', target_minor: 8_000_000, target_date: '2027-05-20' });
    expect(parseTanggalTarget('sampai akhir tahun', '2026-11-20')).toBe('2026-12-31');
    expect(parseTanggalTarget('target 2027-03-01', '2026-11-20')).toBe('2027-03-01');
    expect(parseTanggalTarget('tanpa tanggal', '2026-11-20')).toBeNull();
  });

  it('bertanya bila ada yang kurang, tidak menebak', () => {
    expect(pertanyaanTujuan(parseTujuan('buat tujuan liburan', '2026-11-20'))).toMatch(/berapa target/i);
    expect(pertanyaanTujuan(parseTujuan('bikin target 5jt', '2026-11-20'))).toMatch(/namanya apa/i);
    expect(pertanyaanTujuan(parseTujuan('buat tujuan', '2026-11-20'))).toMatch(/Tujuan apa/);
    expect(pertanyaanTujuan(parseTujuan('buat tujuan laptop 5jt', '2026-11-20'))).toBeNull();
  });

  it('menyimpan tujuan tanpa membuat transaksi apa pun', () => {
    const sebelum = jumlahTransaksi(database);
    const hasil = simpanTujuan(parseTujuan('buat tujuan laptop 5jt', '2026-11-20'), database);
    expect(hasil.pesan).toMatch(/hanya penanda/);
    const row = database.prepare(`SELECT name, target_minor FROM goal WHERE id = ?`).get(hasil.id) as { name: string; target_minor: number };
    expect(row).toEqual({ name: 'Laptop', target_minor: 5_000_000 });
    expect(jumlahTransaksi(database)).toBe(sebelum);
  });

  it('mengenali permintaan dan pertanyaan tentang tujuan', () => {
    expect(adalahPermintaanBuatTujuan('buat tujuan laptop 5jt')).toBe(true);
    expect(adalahPermintaanBuatTujuan('makan 25rb di kantin')).toBe(false);
    expect(adalahPertanyaanTujuan('gimana progres tujuan laptop')).toBe(true);
  });
});

describe('merchant dan proyek dari kalimat pencatatan', () => {
  it('mengambil tempat bila ada penanda "di" dan proyek dari tagar', () => {
    expect(uraiMerchantProyek('makan 25 ribu di Kantin Kampus #skripsi kemarin')).toEqual({ merchant: 'Kantin Kampus', proyek: 'skripsi' });
    expect(uraiMerchantProyek('beli kabel 30rb di Toko Maju')).toEqual({ merchant: 'Toko Maju', proyek: null });
  });
  it('tidak menebak tempat tanpa penanda', () => {
    expect(uraiMerchantProyek('makan 25 ribu')).toEqual({ merchant: null, proyek: null });
  });
});

describe('anggaran dan notifikasi baru', () => {
  it('/anggaran memakai modul anggaran dan menandai perkiraan sebagai estimasi', () => {
    createBudget({ name: 'Makan uji', period: 'bulanan', amount_minor: 100_000, start_date: '2026-11-01' }, 'uji', database);
    const teks = ringkasanAnggaran(database);
    expect(teks).toContain('Makan uji');
    expect(teks).toMatch(/estimasi/);
  });

  it('pengingat anggaran terlewati hanya dikirim sekali per periode', () => {
    const tahunBulan = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
    createBudget({ name: 'Super ketat', period: 'bulanan', amount_minor: 1_000, start_date: `${tahunBulan}-01` }, 'uji', database);
    // Satu pengeluaran hari ini melewati batas.
    recordCashEvent(
      {
        occurred_at: `${new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 50_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        category_id: kategori(database, 'makan'),
        merchant_raw: 'Warung Uji',
        reference_no: 'UJI-NOTIF',
        source: 'manual',
      },
      database,
    );

    const pertama = kumpulkanPengingat('harian', database).filter((p) => p.type === 'anggaran_berisiko');
    expect(pertama.length).toBe(1);
    expect(pertama[0]!.text).toMatch(/terlewati/);
    catatTerkirim(pertama[0]!, database);
    expect(belumPernahDikirim(pertama[0]!, database)).toBe(false);
  });

  it('bantuan menyebut kemampuan baru', () => {
    const b = bantuan();
    expect(b).toMatch(/\/tujuan/);
    expect(b).toMatch(/buat tujuan/);
  });
});
