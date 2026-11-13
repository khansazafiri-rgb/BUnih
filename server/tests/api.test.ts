import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Database as DB } from 'better-sqlite3';
import { dbUji, akun, kategori } from './bantu.js';
import { HARI_ACUAN, isiDataUji } from './data-uji.js';
import { buatApp } from '../src/index.js';
import { today } from '../src/domain/time.js';

let server: Server;
let base = '';
let database: DB;

beforeAll(async () => {
  database = dbUji();
  const app = buatApp();
  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', () => ok());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  // Database baru per tes; router membaca singleton yang di-set oleh dbUji().
  database = dbUji();
});

async function panggil(metode: string, jalur: string, badan?: unknown) {
  const res = await fetch(`${base}${jalur}`, {
    method: metode,
    headers: badan === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: badan === undefined ? undefined : JSON.stringify(badan),
  });
  const teks = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(teks);
  } catch {
    /* bukan JSON */
  }
  return { status: res.status, json, teks };
}

describe('dashboard', () => {
  it('database kosong: menyambut dengan keadaan mulai, bukan angka kosong yang membingungkan', async () => {
    const { status, json } = await panggil('GET', '/dashboard');
    expect(status).toBe(200);
    expect(json.jawaban.wajah).toBe('kosong');
    expect(json.jawaban.judul).toBe('Mulai dari sini');
    expect(json.uang.saldo_terverifikasi_minor).toBeNull();
    expect(json.mulai.langkah.length).toBeGreaterThanOrEqual(5);
    expect(json.mulai.selesai).toBe(false);
    expect(JSON.stringify(json)).not.toContain('NaN');
  });

  it('dengan data: kalimat jawaban, kategori teratas, tujuh hari, dan insight tersedia', async () => {
    isiDataUji(database);
    await panggil('POST', '/anggaran', { name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 600_000, start_date: '2026-11-01' });
    const { json } = await panggil('GET', '/dashboard');
    expect(json.adaData).toBe(true);
    expect(json.jawaban.judul).toBeTruthy();
    expect(json.tujuh_hari).toHaveLength(7);
    expect(json.pemakaian.kategori.length).toBeGreaterThan(0);
  });

  it('menutup panduan mulai tersimpan', async () => {
    await panggil('POST', '/onboarding/tutup');
    const { json } = await panggil('GET', '/dashboard');
    expect(json.mulai.ditutup).toBe(true);
  });

  it('kalimat jawaban mengikuti keadaan anggaran', async () => {
    const { susunJawaban } = await import('../src/domain/dashboard.js');
    const base = { adaData: true, dipakaiBulanIni: 100_000, defisitTanggal: null, saldoTerverifikasi: true };
    const anggaran = (status: string, sisa = 100_000) => ({ nama: 'Makan', status, sisa_minor: sisa, dialokasikan_minor: 500_000, perkiraan_akhir_minor: 600_000 }) as any;
    expect(susunJawaban({ ...base, budgets: [anggaran('aman')] }).wajah).toBe('senang');
    expect(susunJawaban({ ...base, budgets: [anggaran('berisiko')] }).wajah).toBe('biasa');
    const lewat = susunJawaban({ ...base, budgets: [anggaran('lewat', -50_000)] });
    expect(lewat.wajah).toBe('khawatir');
    expect(lewat.kalimat).toContain('Rp50.000');
    expect(susunJawaban({ ...base, budgets: [] }).judul).toBe('Belum ada batas');
    // Defisit hanya diumumkan bila saldo terverifikasi, supaya tidak menakuti dengan tebakan.
    expect(susunJawaban({ ...base, budgets: [anggaran('aman')], defisitTanggal: '2026-12-01', saldoTerverifikasi: false }).wajah).toBe('senang');
    expect(susunJawaban({ ...base, budgets: [anggaran('aman')], defisitTanggal: '2026-12-01' }).wajah).toBe('khawatir');
  });
});

describe('API kategori', () => {
  it('membuat, mengganti nama, memindahkan, dan menonaktifkan', async () => {
    const induk = await panggil('POST', '/kategori', { name: 'Olahraga', icon: '🏃' });
    expect(induk.status).toBe(200);
    const anak = await panggil('POST', '/kategori', { name: 'Futsal', parent_id: induk.json.id });
    expect(anak.status).toBe(200);
    expect((await panggil('PATCH', `/kategori/${anak.json.id}`, { name: 'Futsal Malam' })).status).toBe(200);

    const pohon = await panggil('GET', '/kategori/pohon');
    const node = pohon.json.find((n: any) => n.id === induk.json.id);
    expect(node.anak[0].name).toBe('Futsal Malam');

    expect((await panggil('DELETE', `/kategori/${anak.json.id}`)).status).toBe(200);
    const aktif = await panggil('GET', '/kategori');
    expect(aktif.json.some((k: any) => k.id === anak.json.id)).toBe(false);
    const semua = await panggil('GET', '/kategori?semua=1');
    expect(semua.json.some((k: any) => k.id === anak.json.id)).toBe(true);
  });

  it('menolak lingkaran dan nama ganda dengan pesan yang jelas', async () => {
    const a = await panggil('POST', '/kategori', { name: 'Induk Uji' });
    const b = await panggil('POST', '/kategori', { name: 'Anak Uji', parent_id: a.json.id });
    const lingkaran = await panggil('PATCH', `/kategori/${a.json.id}`, { parent_id: b.json.id });
    expect(lingkaran.status).toBe(400);
    expect(lingkaran.json.pesan).toContain('turunan');
    const ganda = await panggil('POST', '/kategori', { name: 'induk uji' });
    expect(ganda.status).toBe(400);
    expect(ganda.json.pesan).toContain('Sudah ada');
  });
});

describe('API anggaran dan tujuan', () => {
  it('membuat anggaran, merevisi nominal tanpa mengubah riwayat, lalu menonaktifkan', async () => {
    const baru = await panggil('POST', '/anggaran', { name: 'Transport', category_id: kategori(database, 'transport'), period: 'bulanan', amount_minor: 300_000, start_date: '2026-09-01' });
    expect(baru.status).toBe(200);
    await panggil('POST', `/anggaran/${baru.json.id}/revisi`, { amount_minor: 400_000, effective_from: '2026-11-01' });
    const revisi = await panggil('GET', `/anggaran/${baru.json.id}/revisi`);
    expect(revisi.json).toHaveLength(1);
    expect((await panggil('DELETE', `/anggaran/${baru.json.id}`)).status).toBe(200);
    expect((await panggil('GET', '/anggaran')).json).toHaveLength(0);
    expect((await panggil('GET', '/anggaran?semua=1')).json).toHaveLength(1);
  });

  it('menolak anggaran tidak valid dengan pesan berbahasa Indonesia', async () => {
    const r = await panggil('POST', '/anggaran', { name: 'x', period: 'bulanan', amount_minor: 0 });
    expect(r.status).toBe(400);
    expect(r.json.pesan).toBeTruthy();
    expect((await panggil('POST', '/anggaran', { name: 'x', period: 'kustom', amount_minor: 1000 })).json.pesan).toContain('kustom');
  });

  it('membuat tujuan, menyisihkan uang tanpa membuat transaksi, dan melihat progres', async () => {
    const g = await panggil('POST', '/tujuan', { name: 'Laptop', target_minor: 5_000_000, target_date: '2027-06-30' });
    expect(g.status).toBe(200);
    const sebelum = (database.prepare(`SELECT COUNT(*) AS n FROM cash_event`).get() as { n: number }).n;
    expect((await panggil('POST', `/tujuan/${g.json.id}/setoran`, { amount_minor: 500_000, occurred_on: today() })).status).toBe(200);
    expect((database.prepare(`SELECT COUNT(*) AS n FROM cash_event`).get() as { n: number }).n).toBe(sebelum);
    const daftar = await panggil('GET', '/tujuan');
    expect(daftar.json[0]).toMatchObject({ nama: 'Laptop', terkumpul_minor: 500_000, persen: 10 });
  });
});

describe('API transaksi baru', () => {
  it('mencatat fee desain yang direimburse company lengkap dengan proyek', async () => {
    const r = await panggil('POST', '/transaksi/baru', {
      jenis: 'pengeluaran',
      jumlah_minor: 150_000,
      rekening_id: akun(database, 'Mandiri'),
      merchant: 'Desainer Lepas',
      penanggung: 'company_bayar_dulu',
      proyek: 'MEDCOEL',
    });
    expect(r.status).toBe(200);
    const detail = await panggil('GET', `/transaksi/${r.json.id}`);
    expect(detail.json.transaksi.project).toBe('MEDCOEL');
    expect(detail.json.alokasi[0].purpose).toBe('piutang_company');
    expect((await panggil('GET', '/reimburse')).json.total_sisa_company_minor).toBe(150_000);
  });

  it('menolak isian yang salah dengan 400 dan pesan jelas', async () => {
    const r = await panggil('POST', '/transaksi/baru', { jenis: 'pengeluaran', jumlah_minor: -5, rekening_id: akun(database, 'Mandiri') });
    expect(r.status).toBe(400);
    const tanpaRekening = await panggil('POST', '/transaksi/baru', { jenis: 'pengeluaran', jumlah_minor: 1000 });
    expect(tanpaRekening.status).toBe(400);
    expect(tanpaRekening.json.pesan).toContain('rekening');
  });

  it('mengubah kategori lewat API memperbarui analitik', async () => {
    const r = await panggil('POST', '/transaksi/baru', { jenis: 'pengeluaran', jumlah_minor: 40_000, rekening_id: akun(database, 'Mandiri'), kategori_id: kategori(database, 'makan'), waktu: `${today()}T10:00` });
    await panggil('PATCH', `/transaksi/${r.json.id}/ubah`, { kategori_id: kategori(database, 'hiburan') });
    const a = await panggil('GET', '/analitik?preset=7_hari');
    expect(a.json.kategori.map((k: any) => k.nama)).toEqual(['Hiburan']);
  });

  it('filter kategori di daftar transaksi membaca potongan dan turunan', async () => {
    isiDataUji(database);
    const semua = await panggil('GET', `/transaksi?kategori=${kategori(database, 'makan')}&dari=2026-11-01&sampai=2026-11-20&batas=200`);
    expect(semua.json.total).toBe(8);
    const proyek = await panggil('GET', '/transaksi?proyek=tidak-ada');
    expect(proyek.json.total).toBe(0);
  });
});

describe('API analitik', () => {
  it('mengembalikan seluruh bagian yang dijanjikan', async () => {
    isiDataUji(database);
    const { status, json } = await panggil('GET', `/analitik?dari=2026-11-01&sampai=${HARI_ACUAN}`);
    expect(status).toBe(200);
    for (const kunci of ['ringkasan', 'kategori', 'merchant', 'makanan', 'tren', 'langganan', 'insight', 'kualitas_data', 'berulang_vs_sesuka', 'tidak_biasa']) {
      expect(json).toHaveProperty(kunci);
    }
    expect(JSON.stringify(json)).not.toContain('NaN');
  });

  it('rincian cocok dengan angka kategori', async () => {
    isiDataUji(database);
    const a = await panggil('GET', `/analitik?dari=2026-11-01&sampai=${HARI_ACUAN}`);
    const makan = a.json.kategori.find((k: any) => k.nama === 'Makan');
    const r = await panggil('GET', `/analitik/rincian?dari=2026-11-01&sampai=${HARI_ACUAN}&kategori=${makan.category_id}`);
    expect(r.json.total_minor).toBe(makan.jumlah_minor);
  });

  it('menolak tanggal yang formatnya salah', async () => {
    expect((await panggil('GET', '/analitik/rincian?dari=kemarin&sampai=hari-ini')).status).toBe(400);
  });
});

describe('API merchant', () => {
  it('alias dan penggabungan memindahkan transaksi', async () => {
    const a = await panggil('POST', '/transaksi/baru', { jenis: 'pengeluaran', jumlah_minor: 20_000, rekening_id: akun(database, 'Mandiri'), merchant: 'Kopi Kenangan', waktu: `${today()}T08:00` });
    const b = await panggil('POST', '/transaksi/baru', { jenis: 'pengeluaran', jumlah_minor: 21_000, rekening_id: akun(database, 'Mandiri'), merchant: 'QRIS KOPI KENANGAN', waktu: `${today()}T09:00` });
    const daftar = await panggil('GET', '/merchant');
    expect(daftar.json).toHaveLength(2);
    const kanonik = daftar.json.find((m: any) => m.name === 'Kopi Kenangan');
    const lain = daftar.json.find((m: any) => m.name === 'QRIS KOPI KENANGAN');
    const gabung = await panggil('POST', `/merchant/${kanonik.id}/gabung`, { dari: lain.id });
    expect(gabung.json.transaksi_dipindah).toBe(1);
    const sesudah = await panggil('GET', '/merchant');
    expect(sesudah.json).toHaveLength(1);
    expect(sesudah.json[0].jumlah_transaksi).toBe(2);
    void a; void b;
  });
});

describe('skenario tersembunyi', () => {
  it('skenario Claude tidak muncul di daftar bawaan tetapi masih ada', async () => {
    const bawaan = await panggil('GET', '/skenario');
    expect(bawaan.json.map((s: any) => s.slug)).not.toContain('dengan-claude-pribadi');
    const semua = await panggil('GET', '/skenario?semua=1');
    expect(semua.json.map((s: any) => s.slug)).toContain('dengan-claude-pribadi');
  });

  it('beranda perencanaan tidak lagi menanam nama skenario Claude', async () => {
    const { json } = await panggil('GET', '/beranda');
    expect(json.skenario).toHaveProperty('dasar');
    expect(json.skenario).not.toHaveProperty('dengan_claude');
  });
});
