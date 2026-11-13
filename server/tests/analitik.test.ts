import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import Database from 'better-sqlite3';
import { dbUji, akun } from './bantu.js';
import { HARI_ACUAN, isiDataUji, keluar } from './data-uji.js';
import { analitik, persenPerubahan, rincian, resolveRange } from '../src/domain/analytics.js';
import { createBudget } from '../src/domain/budgets.js';
import { createGoal, addContribution } from '../src/domain/goals.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { setDatabase } from '../src/db/index.js';
import { kategori } from './bantu.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
  isiDataUji(database);
});

describe('rentang dan pembanding yang adil', () => {
  it('bulan berjalan dibandingkan dengan jumlah hari yang sama bulan lalu, bukan seluruh bulan lalu', () => {
    const r = resolveRange({ preset: 'bulan_ini' }, HARI_ACUAN);
    expect(r.dari).toBe('2026-11-01');
    expect(r.sampai).toBe('2026-11-20');
    expect(r.hari).toBe(20);
    expect(r.sebelumnya.dari).toBe('2026-10-01');
    expect(r.sebelumnya.sampai).toBe('2026-10-20');
    expect(r.sebelumnya.hari).toBe(20);
  });

  it('bulan lalu penuh, 30 hari, dan kustom', () => {
    const lalu = resolveRange({ preset: 'bulan_lalu' }, HARI_ACUAN);
    expect([lalu.dari, lalu.sampai]).toEqual(['2026-10-01', '2026-10-31']);
    const t30 = resolveRange({ preset: '30_hari' }, HARI_ACUAN);
    expect(t30.hari).toBe(30);
    expect(t30.sebelumnya.sampai).toBe('2026-10-21');
    const kustom = resolveRange({ dari: '2026-11-10', sampai: '2026-11-05' }, HARI_ACUAN);
    expect([kustom.dari, kustom.sampai]).toEqual(['2026-11-05', '2026-11-10']);
  });

  it('persen perubahan tidak dihitung bila pembanding kosong', () => {
    expect(persenPerubahan(100, 0)).toBeNull();
    expect(persenPerubahan(150, 100)).toBe(50);
    expect(persenPerubahan(50, 100)).toBe(-50);
  });
});

describe('ringkasan keuangan', () => {
  it('pengeluaran pribadi neto hanya menghitung yang memang pengeluaran pribadi', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    // 460.000 + 60.000 + 100.000 - 20.000 refund + 40.000 = 640.000
    expect(a.ringkasan.pengeluaran_pribadi_neto_minor).toBe(640_000);
    // Pembanding adil: 180.000 + 90.000 (makan Rp300.000 tanggal 25 Okt tidak ikut)
    expect(a.ringkasan.pengeluaran_pribadi_sebelumnya_minor).toBe(270_000);
    expect(a.ringkasan.perubahan_persen).toBe(137);
  });

  it('pemasukan tidak menyertakan refund maupun pelunasan piutang', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    expect(a.ringkasan.pemasukan_minor).toBe(3_000_000);
  });

  it('arus kas keluar tidak menyertakan setoran tabungan dan biaya company langsung', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    // pengeluaran pribadi bruto 660.000 (640.000 + refund 20.000 belum dikurangkan) + talangan 120.000
    expect(a.ringkasan.arus_kas_keluar_minor).toBe(660_000 + 120_000);
    // masuk: gaji 3.000.000 + refund 20.000 + pelunasan 50.000 (uang masuk nyata)
    expect(a.ringkasan.arus_kas_masuk_minor).toBe(3_070_000);
    expect(a.ringkasan.arus_kas_neto_minor).toBe(3_070_000 - 780_000);
  });

  it('tabungan neto berasal dari transfer tercatat', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    expect(a.ringkasan.tabungan_neto_minor).toBe(300_000);
  });

  it('saldo terverifikasi hanya tampil bila ada titik tambat', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    expect(a.ringkasan.saldo_terverifikasi_minor).not.toBeNull();
    const kosong = new Database(':memory:');
    migrate(kosong);
    seed(kosong, { profil: 'bersih' });
    setDatabase(kosong);
    expect(analitik({}, kosong, HARI_ACUAN).ringkasan.saldo_terverifikasi_minor).toBeNull();
  });
});

describe('pengeluaran per kategori', () => {
  it('diurutkan, dengan persentase yang jumlahnya masuk akal', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    expect(a.kategori.map((k) => [k.nama, k.jumlah_minor])).toEqual([
      ['Makan', 460_000],
      ['Hiburan', 80_000], // 100.000 dikurangi refund 20.000
      ['Transport', 60_000],
      ['Belum dikategorikan', 40_000],
    ]);
    const jumlahPersen = a.kategori.reduce((s, k) => s + k.persen, 0);
    expect(jumlahPersen).toBeGreaterThan(99);
    expect(jumlahPersen).toBeLessThanOrEqual(100.5);
    expect(a.kategori[0]!.persen).toBeCloseTo(71.9, 1);
  });

  it('membandingkan dengan periode sebelumnya yang adil', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    const makan = a.kategori.find((k) => k.nama === 'Makan')!;
    expect(makan.sebelumnya_minor).toBe(180_000); // Resto Rp300.000 (25 Okt) tidak ikut
    expect(makan.perubahan_persen).toBe(156);
    const transport = a.kategori.find((k) => k.nama === 'Transport')!;
    expect(transport.perubahan_persen).toBe(-33);
  });

  it('transaksi tanpa kategori ditandai, bukan disembunyikan', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    const belum = a.kategori.find((k) => k.belum_dikategorikan)!;
    expect(belum.jumlah_minor).toBe(40_000);
    expect(a.kualitas_data.belum_dikategorikan_jumlah).toBe(1);
    expect(a.kualitas_data.belum_dikategorikan_minor).toBe(40_000);
  });

  it('mengelompokkan subkategori ke induknya dengan rincian anak', async () => {
    const { createCategory } = await import('../src/domain/categories.js');
    const anak = createCategory({ name: 'Kopi', parent_id: kategori(database, 'makan') }, 'uji', database);
    keluar(database, '2026-11-19', 30_000, null, 'Kedai Kopi', { category_id: anak });
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    const makan = a.kategori.find((k) => k.nama === 'Makan')!;
    expect(makan.jumlah_minor).toBe(490_000);
    expect(makan.anak.find((x) => x.nama === 'Kopi')?.jumlah_minor).toBe(30_000);
  });
});

describe('analitik merchant', () => {
  it('peringkat frekuensi dan total, rata-rata per transaksi', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    const teratas = a.merchant.paling_sering[0]!;
    expect(teratas.nama).toBe('Kantin Kampus');
    expect(teratas.jumlah_transaksi).toBe(6);
    expect(teratas.total_minor).toBe(150_000);
    expect(teratas.rata_rata_minor).toBe(25_000);
    expect(teratas.sebelumnya_transaksi).toBe(5);
    expect(a.merchant.paling_besar_total[0]!.nama).toBe('Resto Mahal');
  });

  it('transaksi tanpa merchant tidak ikut peringkat tetapi tetap dihitung di total', () => {
    keluar(database, '2026-11-19', 15_000, 'makan', null);
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    expect(a.merchant.paling_sering.some((m) => m.nama === 'Tanpa nama')).toBe(false);
    expect(a.kualitas_data.tanpa_merchant_jumlah).toBe(1);
    expect(a.ringkasan.pengeluaran_pribadi_neto_minor).toBe(655_000);
  });
});

describe('analisis makanan', () => {
  it('menghitung total, rata-rata harian, peringkat, dan transaksi termahal', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    const m = a.makanan;
    expect(m.tersedia).toBe(true);
    expect(m.total_minor).toBe(460_000);
    expect(m.hari_berjalan).toBe(20);
    expect(m.rata_per_hari_minor).toBe(23_000);
    expect(m.transaksi_termahal[0]).toMatchObject({ merchant: 'Resto Mahal', jumlah_minor: 250_000 });
    expect(m.paling_sering[0]!.nama).toBe('Kantin Kampus');
    expect(m.paling_besar_total[0]!.nama).toBe('Resto Mahal');
    expect(m.hari_dengan_catatan).toBe(8);
    expect(m.hari_tanpa_catatan).toBe(12);
  });

  it('tren bulanan mencakup enam bulan dan memakai angka nyata tiap bulan', () => {
    const m = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN).makanan;
    expect(m.tren_bulanan).toHaveLength(6);
    expect(m.tren_bulanan[5]).toMatchObject({ bulan: '2026-11', total_minor: 460_000 });
    expect(m.tren_bulanan[4]).toMatchObject({ bulan: '2026-10', total_minor: 180_000 + 300_000 });
  });

  it('kepatuhan anggaran makan dihitung dari anggaran yang sama', () => {
    createBudget({ name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 900_000, start_date: '2026-11-01' }, 'uji', database);
    const m = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN).makanan;
    expect(m.anggaran?.terpakai_minor).toBe(460_000);
    expect(m.anggaran?.dialokasikan_minor).toBe(900_000);
    // 460.000 dalam 20 hari -> 30 hari = 690.000, masih di bawah 900.000
    expect(m.anggaran?.perkiraan_akhir_minor).toBe(690_000);
    expect(m.anggaran?.status).toBe('aman');
  });
});

describe('tren dan pola', () => {
  it('rentang pendek memakai titik harian, tanpa lubang, dan jumlahnya cocok dengan total', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    expect(a.tren.granularitas).toBe('harian');
    expect(a.tren.titik).toHaveLength(20);
    expect(a.tren.titik.reduce((s, t) => s + t.pengeluaran_minor, 0)).toBe(640_000);
    expect(a.tren.titik.reduce((s, t) => s + t.pemasukan_minor, 0)).toBe(3_000_000);
  });

  it('rentang panjang memakai titik mingguan atau bulanan', () => {
    expect(analitik({ preset: '90_hari' }, database, HARI_ACUAN).tren.granularitas).toBe('mingguan');
    expect(analitik({ preset: 'tahun_ini' }, database, '2026-11-20').tren.granularitas).toBe('bulanan');
  });

  it('memisahkan pengeluaran berulang dari sesuka hati', async () => {
    const svc = database.prepare(`SELECT id FROM service WHERE slug = 'biznet-gio-pribadi'`).get() as { id: number };
    keluar(database, '2026-11-19', 198_690, 'server-hosting', 'Biznet Gio', { kind: 'bayar_langganan', service_id: svc.id });
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    expect(a.berulang_vs_sesuka.berulang_minor).toBe(198_690);
    expect(a.berulang_vs_sesuka.sesuka_minor).toBe(640_000);
  });

  it('mendeteksi pengeluaran tidak biasa dengan penjelasan angka, dan tidak menandai yang wajar', () => {
    const db2 = dbUji();
    for (let i = 0; i < 8; i += 1) keluar(db2, `2026-09-${String(10 + i).padStart(2, '0')}`, 20_000 + i * 1000, 'makan', 'Kantin');
    keluar(db2, '2026-11-10', 400_000, 'makan', 'Resto Mewah');
    keluar(db2, '2026-11-11', 24_000, 'makan', 'Kantin');
    const a = analitik({ preset: 'bulan_ini' }, db2, HARI_ACUAN);
    expect(a.tidak_biasa).toHaveLength(1);
    expect(a.tidak_biasa[0]!.merchant).toBe('Resto Mewah');
    expect(a.tidak_biasa[0]!.alasan).toContain('Rp400.000');
    expect(a.tidak_biasa[0]!.sampel).toBe(8);
  });

  it('tidak mendeteksi tidak biasa bila pembanding kurang dari lima transaksi', () => {
    const db2 = dbUji();
    keluar(db2, '2026-09-10', 20_000, 'makan', 'Kantin');
    keluar(db2, '2026-11-10', 400_000, 'makan', 'Resto Mewah');
    expect(analitik({ preset: 'bulan_ini' }, db2, HARI_ACUAN).tidak_biasa).toHaveLength(0);
  });
});

describe('insight dihitung dari data', () => {
  it('menyebut kategori terbesar, kenaikan, merchant tersering, dan data belum rapi dengan angka asli', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    const kunci = a.insight.map((i) => i.kunci);
    expect(kunci).toContain('kategori_terbesar');
    expect(kunci).toContain('total_berubah');
    expect(kunci).toContain('merchant_tersering');
    expect(kunci).toContain('belum_dikategorikan');

    const terbesar = a.insight.find((i) => i.kunci === 'kategori_terbesar')!;
    expect(terbesar.teks).toContain('Makan');
    expect(terbesar.teks).toContain('Rp460.000');
    expect(terbesar.angka['persen']).toBeCloseTo(71.9, 1);

    const berubah = a.insight.find((i) => i.kunci === 'total_berubah')!;
    expect(berubah.teks).toContain('naik 137%');
    expect(berubah.tingkat).toBe('perhatian');

    const sering = a.insight.find((i) => i.kunci === 'merchant_tersering')!;
    expect(sering.teks).toContain('Kantin Kampus');
    expect(sering.teks).toContain('6 kali');
  });

  it('setiap insight membawa angka mentah dan tidak ada yang tanpa data', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    for (const i of a.insight) {
      expect(Object.keys(i.angka).length).toBeGreaterThan(0);
      expect(i.teks.length).toBeGreaterThan(10);
    }
  });

  it('perkiraan anggaran dilabeli estimasi', () => {
    createBudget({ name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 600_000, start_date: '2026-11-01' }, 'uji', database);
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    const i = a.insight.find((x) => x.kunci.startsWith('anggaran_berisiko'))!;
    expect(i).toBeDefined();
    expect(i.teks).toContain('Perkiraan');
    expect(i.teks).toContain('estimasi');
  });

  it('tujuan yang berisiko muncul sebagai insight', () => {
    const g = createGoal({ name: 'Laptop', target_minor: 5_000_000, target_date: '2027-01-31' }, 'uji', database);
    addContribution(g, { amount_minor: 100_000, occurred_on: '2026-11-10' }, 'uji', database);
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    expect(a.insight.some((i) => i.kunci.startsWith('tujuan_berisiko'))).toBe(true);
  });

  it('tidak membuat pernyataan perubahan bila periode sebelumnya kosong', () => {
    const db2 = dbUji();
    keluar(db2, '2026-11-10', 100_000, 'makan', 'Kantin');
    const a = analitik({ preset: 'bulan_ini' }, db2, HARI_ACUAN);
    expect(a.insight.some((i) => i.kunci === 'total_berubah')).toBe(false);
    expect(a.ringkasan.perubahan_persen).toBeNull();
  });
});

describe('data kosong atau belum lengkap', () => {
  it('database baru menghasilkan nol, bukan NaN atau kesalahan', () => {
    const kosong = new Database(':memory:');
    migrate(kosong);
    seed(kosong, { profil: 'bersih' });
    setDatabase(kosong);
    const a = analitik({}, kosong, HARI_ACUAN);
    expect(a.ringkasan.pengeluaran_pribadi_neto_minor).toBe(0);
    expect(a.kategori).toEqual([]);
    expect(a.insight).toEqual([]);
    expect(a.makanan.total_minor).toBe(0);
    expect(a.makanan.rata_per_hari_minor).toBe(0);
    expect(a.tren.titik.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).not.toContain('NaN');
    expect(JSON.stringify(a)).not.toContain('null%');
  });
});

describe('drill-down ke transaksi', () => {
  it('rincian kategori cocok persis dengan angka kategori itu', () => {
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    const makan = a.kategori.find((k) => k.nama === 'Makan')!;
    const r = rincian({ dari: '2026-11-01', sampai: '2026-11-20', kategori_id: makan.category_id }, database);
    expect(r.total_minor).toBe(makan.jumlah_minor);
    expect(r.baris.reduce((s, b) => s + b.jumlah_minor, 0)).toBe(makan.jumlah_minor);
    expect(r.jumlah_transaksi).toBe(makan.jumlah_transaksi);
  });

  it('rincian transaksi tanpa kategori dan per merchant', () => {
    const belum = rincian({ dari: '2026-11-01', sampai: '2026-11-20', tanpa_kategori: true }, database);
    expect(belum.total_minor).toBe(40_000);
    expect(belum.baris[0]!.merchant).toBe('Toko X');
    const a = analitik({ preset: 'bulan_ini' }, database, HARI_ACUAN);
    const kantin = a.merchant.paling_sering[0]!;
    const r = rincian({ dari: '2026-11-01', sampai: '2026-11-20', merchant_id: kantin.merchant_id }, database);
    expect(r.total_minor).toBe(kantin.total_minor);
    expect(r.jumlah_transaksi).toBe(6);
  });

  it('rincian refund ditandai dan mengurangi total', () => {
    const r = rincian({ dari: '2026-11-01', sampai: '2026-11-20', kategori_id: kategori(database, 'hiburan') }, database);
    expect(r.total_minor).toBe(80_000);
    expect(r.baris.find((b) => b.refund)?.jumlah_minor).toBe(-20_000);
  });

  it('rincian makanan dan jenis berulang memakai definisi yang sama dengan analitik', () => {
    const makanan = rincian({ dari: '2026-11-01', sampai: '2026-11-20', makanan: true }, database);
    expect(makanan.total_minor).toBe(460_000);
    expect(rincian({ dari: '2026-11-01', sampai: '2026-11-20', jenis: 'berulang' }, database).total_minor).toBe(0);
  });
});
