import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, alokasiPer, dbUji, jumlahTransaksi, kategori, pasangSaldo } from './bantu.js';
import { buatTransaksi, TransaksiError, ubahTransaksi } from '../src/domain/manualTx.js';
import { getCashEvent } from '../src/domain/ledger.js';
import { listReceivables } from '../src/domain/receivables.js';
import { accountBalance, balanceSummary } from '../src/domain/balances.js';
import { analitik, rincian } from '../src/domain/analytics.js';
import { auditFor } from '../src/domain/audit.js';
import { recordCashEvent } from '../src/domain/ledger.js';
import { createCategory } from '../src/domain/categories.js';
import { today } from '../src/domain/time.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
  pasangSaldo(database, 'Mandiri', 2_000_000, -1);
  pasangSaldo(database, 'BCA', 1_000_000, -1);
});

const mandiri = () => akun(database, 'Mandiri');
const bca = () => akun(database, 'BCA');

describe('contoh: fee desain MEDCOEL yang direimburse company', () => {
  it('mewakili arus kas keluar, kategori, merchant, penanggung akhir, piutang, dan proyek', () => {
    const fee = createCategory({ name: 'Fee desain' }, 'uji', database);
    const sebelum = accountBalance(mandiri(), undefined, database).balance_minor!;
    const r = buatTransaksi(
      {
        jenis: 'pengeluaran',
        jumlah_minor: 150_000,
        rekening_id: mandiri(),
        merchant: 'Desainer Lepas',
        kategori_id: fee,
        penanggung: 'company_bayar_dulu',
        proyek: 'MEDCOEL',
        catatan: 'Fee desain feed Instagram',
      },
      'uji',
      database,
    );

    const ev = getCashEvent(r.id, database)!;
    expect(ev.amount_minor).toBe(150_000);
    expect(ev.direction).toBe('keluar');
    expect(ev.account_id).toBe(mandiri());
    expect(ev.category_id).toBe(fee);
    expect(ev.merchant_raw).toBe('Desainer Lepas');
    expect(ev.project).toBe('MEDCOEL');
    // Saldo pribadi turun sampai reimburse benar-benar masuk.
    expect(accountBalance(mandiri(), undefined, database).balance_minor).toBe(sebelum - 150_000);
    // Penanggung akhir company, bukan biaya pribadi.
    expect(alokasiPer(database, r.id)['piutang_company']).toBe(150_000);
    expect(alokasiPer(database, r.id)['biaya_pribadi']).toBeUndefined();
    expect(listReceivables({ onlyOpen: true }, database).total_sisa_company_minor).toBe(150_000);
  });

  it('tidak masuk pengeluaran pribadi, tetapi bisa ditelusuri per proyek', () => {
    buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 150_000, rekening_id: mandiri(), penanggung: 'company_bayar_dulu', proyek: 'MEDCOEL', waktu: `${today()}T10:00` }, 'uji', database);
    buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 30_000, rekening_id: mandiri(), kategori_id: kategori(database, 'makan'), waktu: `${today()}T11:00` }, 'uji', database);
    const a = analitik({ preset: '7_hari' }, database);
    expect(a.ringkasan.pengeluaran_pribadi_neto_minor).toBe(30_000);
  });
});

describe('peran pembayar dan penanggung', () => {
  it('pengeluaran biasa menjadi biaya pribadi', () => {
    const r = buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 25_000, rekening_id: mandiri(), merchant: 'Kantin', kategori_id: kategori(database, 'makan') }, 'uji', database);
    expect(alokasiPer(database, r.id)).toEqual({ biaya_pribadi: 25_000 });
  });

  it('company bayar langsung: saldo pribadi tidak berubah dan tidak jadi pengeluaran pribadi', () => {
    const sebelum = balanceSummary(undefined, database).total_terverifikasi_minor;
    const r = buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 410_700, penanggung: 'company_langsung', merchant: 'IDCloudHost' }, 'uji', database);
    expect(balanceSummary(undefined, database).total_terverifikasi_minor).toBe(sebelum);
    expect(alokasiPer(database, r.id)).toEqual({ biaya_company_langsung: 410_700 });
    expect(getCashEvent(r.id, database)!.account_id).toBeNull();
  });

  it('bagian pribadi + bagian reimburse company dalam satu transaksi', () => {
    const r = buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 200_000, rekening_id: mandiri(), penanggung: 'company_bayar_dulu', bagian_saya_minor: 50_000 }, 'uji', database);
    expect(alokasiPer(database, r.id)).toEqual({ piutang_company: 150_000, biaya_pribadi: 50_000 });
  });

  it('hadiah tetap biaya pribadi', () => {
    const r = buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 100_000, rekening_id: mandiri(), penanggung: 'hadiah' }, 'uji', database);
    expect(alokasiPer(database, r.id)).toEqual({ biaya_pribadi: 100_000 });
    expect(listReceivables({ onlyOpen: true }, database).total_sisa_minor).toBe(0);
  });

  it('talangan menjadi piutang', () => {
    const r = buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 80_000, rekening_id: mandiri(), penanggung: 'talangan', orang: [{ nama: 'Rizki', jumlah_minor: 80_000 }] }, 'uji', database);
    expect(alokasiPer(database, r.id)).toEqual({ piutang_teman: 80_000 });
    expect(listReceivables({ onlyOpen: true }, database).per_orang[0]!.debtor_name).toBe('Rizki');
  });

  it('patungan: Rp120.000 berempat, bagianku Rp30.000, tiga teman masing-masing Rp30.000', () => {
    const r = buatTransaksi(
      {
        jenis: 'pengeluaran',
        jumlah_minor: 120_000,
        rekening_id: mandiri(),
        kategori_id: kategori(database, 'makan'),
        orang: [{ nama: 'A', jumlah_minor: 30_000 }, { nama: 'B', jumlah_minor: 30_000 }, { nama: 'C', jumlah_minor: 30_000 }],
      },
      'uji',
      database,
    );
    expect(alokasiPer(database, r.id)).toEqual({ biaya_pribadi: 30_000, piutang_teman: 90_000 });
    expect(getCashEvent(r.id, database)!.amount_minor).toBe(120_000);
  });

  it('menolak pembagian orang yang tidak pas dengan total', () => {
    expect(() =>
      buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 100_000, rekening_id: mandiri(), bagian_saya_minor: 30_000, orang: [{ nama: 'A', jumlah_minor: 50_000 }] }, 'uji', database),
    ).toThrow(TransaksiError);
  });
});

describe('pembagian kategori', () => {
  it('memecah satu transaksi ke beberapa kategori tanpa mengubah totalnya', () => {
    const r = buatTransaksi(
      {
        jenis: 'pengeluaran',
        jumlah_minor: 100_000,
        rekening_id: mandiri(),
        merchant: 'Toko Serba Ada',
        pembagian_kategori: [
          { kategori_id: kategori(database, 'makan'), jumlah_minor: 60_000 },
          { kategori_id: kategori(database, 'kebutuhan-harian'), jumlah_minor: 40_000 },
        ],
      },
      'uji',
      database,
    );
    expect(getCashEvent(r.id, database)!.amount_minor).toBe(100_000);
    const a = analitik({ preset: '7_hari' }, database);
    const per = Object.fromEntries(a.kategori.map((k) => [k.nama, k.jumlah_minor]));
    expect(per['Makan']).toBe(60_000);
    expect(per['Kebutuhan harian']).toBe(40_000);
  });

  it('menolak pembagian yang jumlahnya tidak sama dengan nominal', () => {
    expect(() =>
      buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 100_000, rekening_id: mandiri(), pembagian_kategori: [{ kategori_id: kategori(database, 'makan'), jumlah_minor: 60_000 }, { kategori_id: null, jumlah_minor: 30_000 }] }, 'uji', database),
    ).toThrow(/sama persis/);
  });

  it('menolak kategori yang sudah dinonaktifkan', () => {
    const k = createCategory({ name: 'Lama' }, 'uji', database);
    database.prepare(`UPDATE category SET active = 0 WHERE id = ?`).run(k);
    expect(() => buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 1000, rekening_id: mandiri(), kategori_id: k }, 'uji', database)).toThrow(/dinonaktifkan/);
  });
});

describe('pemasukan, refund, dan pelunasan', () => {
  it('pemasukan masuk ke pemasukan nyata', () => {
    buatTransaksi({ jenis: 'pemasukan', jumlah_minor: 2_500_000, rekening_id: mandiri(), merchant: 'Klien Freelance', waktu: `${today()}T09:00` }, 'uji', database);
    expect(analitik({ preset: '7_hari' }, database).ringkasan.pemasukan_minor).toBe(2_500_000);
  });

  it('pemasukan yang melunasi piutang mengurangi piutang dan bukan pemasukan baru', () => {
    const t = buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 60_000, rekening_id: mandiri(), penanggung: 'talangan', orang: [{ nama: 'Rizki', jumlah_minor: 60_000 }], waktu: `${today()}T08:00` }, 'uji', database);
    const p = database.prepare(`SELECT r.id FROM receivable r JOIN allocation a ON a.id = r.allocation_id WHERE a.cash_event_id = ?`).get(t.id) as { id: number };
    buatTransaksi({ jenis: 'pemasukan', jumlah_minor: 60_000, rekening_id: mandiri(), melunasi_piutang_id: p.id, waktu: `${today()}T09:00` }, 'uji', database);
    expect(listReceivables({ onlyOpen: true }, database).total_sisa_minor).toBe(0);
    expect(analitik({ preset: '7_hari' }, database).ringkasan.pemasukan_minor).toBe(0);
  });

  it('refund mengurangi pengeluaran dan bukan pemasukan', () => {
    buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 300_000, rekening_id: mandiri(), kategori_id: kategori(database, 'belanja-barang'), waktu: `${today()}T08:00` }, 'uji', database);
    buatTransaksi({ jenis: 'refund', jumlah_minor: 100_000, rekening_id: mandiri(), kategori_id: kategori(database, 'belanja-barang'), waktu: `${today()}T09:00` }, 'uji', database);
    const a = analitik({ preset: '7_hari' }, database);
    expect(a.ringkasan.pengeluaran_pribadi_neto_minor).toBe(200_000);
    expect(a.ringkasan.pemasukan_minor).toBe(0);
  });
});

describe('transfer sendiri dan tabungan', () => {
  it('Mandiri ke BCA milikku: satu perpindahan, netral untuk total uang, bukan pengeluaran', () => {
    const total = balanceSummary(undefined, database).total_terverifikasi_minor;
    const r = buatTransaksi({ jenis: 'tabungan', jumlah_minor: 500_000, rekening_id: mandiri(), tujuan_rekening_id: bca(), waktu: `${today()}T10:00` }, 'uji', database);
    expect(r.ids).toHaveLength(2);
    expect(balanceSummary(undefined, database).total_terverifikasi_minor).toBe(total);
    expect(getCashEvent(r.ids[0]!, database)!.transfer_group_id).not.toBeNull();
    expect(getCashEvent(r.ids[0]!, database)!.kind).toBe('setoran_tabungan');
    const a = analitik({ preset: '7_hari' }, database);
    expect(a.ringkasan.pengeluaran_pribadi_neto_minor).toBe(0);
    expect(a.ringkasan.tabungan_neto_minor).toBe(500_000);
    expect(accountBalance(bca(), undefined, database).balance_minor).toBe(1_500_000);
  });

  it('tabungan tanpa tujuan memilih rekening tabungan', () => {
    const r = buatTransaksi({ jenis: 'tabungan', jumlah_minor: 100_000, rekening_id: mandiri() }, 'uji', database);
    expect(accountBalance(bca(), undefined, database).balance_minor).toBe(1_100_000);
    expect(r.ids).toHaveLength(2);
  });

  it('menolak rekening asal dan tujuan yang sama', () => {
    expect(() => buatTransaksi({ jenis: 'transfer_sendiri', jumlah_minor: 1000, rekening_id: mandiri(), tujuan_rekening_id: mandiri() }, 'uji', database)).toThrow(TransaksiError);
  });

  it('dua transfer identik di waktu berbeda tidak tertukar pasangannya', () => {
    const a = buatTransaksi({ jenis: 'transfer_sendiri', jumlah_minor: 100_000, rekening_id: mandiri(), tujuan_rekening_id: bca(), waktu: `${today()}T09:00` }, 'uji', database);
    const b = buatTransaksi({ jenis: 'transfer_sendiri', jumlah_minor: 100_000, rekening_id: mandiri(), tujuan_rekening_id: bca(), waktu: `${today()}T15:00` }, 'uji', database);
    const ga = getCashEvent(a.ids[0]!, database)!.transfer_group_id;
    const gb = getCashEvent(b.ids[0]!, database)!.transfer_group_id;
    expect(ga).not.toBeNull();
    expect(gb).not.toBeNull();
    expect(ga).not.toBe(gb);
    expect(getCashEvent(a.ids[1]!, database)!.transfer_group_id).toBe(ga);
  });
});

describe('validasi dan pencegahan duplikat', () => {
  it('menolak nominal nol, desimal, dan negatif', () => {
    for (const jumlah of [0, -5, 10.5]) {
      expect(() => buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: jumlah, rekening_id: mandiri() }, 'uji', database)).toThrow(TransaksiError);
    }
  });

  it('menolak pengeluaran tanpa rekening kecuali tunai atau company langsung', () => {
    expect(() => buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 1000 }, 'uji', database)).toThrow(/rekening/);
    expect(() => buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 1000, tunai: true }, 'uji', database)).not.toThrow();
  });

  it('tombol simpan ditekan dua kali tidak membuat dua transaksi', () => {
    const input = { jenis: 'pengeluaran' as const, jumlah_minor: 25_000, rekening_id: mandiri(), merchant: 'Kopi', waktu: `${today()}T12:00:00` };
    buatTransaksi(input, 'uji', database);
    const kedua = buatTransaksi(input, 'uji', database);
    expect(kedua.dibuat).toBe(false);
    expect(jumlahTransaksi(database)).toBe(1);
  });

  it('transaksi nyata kedua dengan jumlah sama beberapa jam kemudian tetap tercatat', () => {
    buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 25_000, rekening_id: mandiri(), merchant: 'Kopi', waktu: `${today()}T09:00` }, 'uji', database);
    buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 25_000, rekening_id: mandiri(), merchant: 'Kopi', waktu: `${today()}T15:00` }, 'uji', database);
    expect(jumlahTransaksi(database)).toBe(2);
  });
});

describe('edit transaksi dengan jejak audit', () => {
  function dasar() {
    return buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 50_000, rekening_id: mandiri(), merchant: 'Warung', kategori_id: kategori(database, 'makan'), waktu: `${today()}T12:00` }, 'uji', database);
  }

  it('mengubah kategori memperbarui laporan dan meninggalkan jejak', () => {
    const r = dasar();
    ubahTransaksi(r.id, { kategori_id: kategori(database, 'transport') }, 'uji', database);
    const a = analitik({ preset: '7_hari' }, database);
    expect(a.kategori.map((k) => [k.nama, k.jumlah_minor])).toEqual([['Transport', 50_000]]);
    const jejak = auditFor('cash_event', r.id, database) as Array<{ action: string }>;
    expect(jejak.map((j) => j.action)).toContain('diedit');
    expect(jejak.map((j) => j.action)).toContain('kategori_diubah');
  });

  it('mengubah nominal pada transaksi sederhana memperbarui alokasi dan laporan', () => {
    const r = dasar();
    ubahTransaksi(r.id, { jumlah_minor: 65_000 }, 'uji', database);
    expect(getCashEvent(r.id, database)!.amount_minor).toBe(65_000);
    expect(alokasiPer(database, r.id)).toEqual({ biaya_pribadi: 65_000 });
    expect(analitik({ preset: '7_hari' }, database).ringkasan.pengeluaran_pribadi_neto_minor).toBe(65_000);
  });

  it('menolak mengubah nominal transaksi yang punya bukti bank', () => {
    const bukti = database
      .prepare(`INSERT INTO evidence (source,external_id,kind,received_at,body_hash,created_at) VALUES ('gmail','x','notifikasi_bank','2026-01-01T00:00:00+07:00','hh','2026-01-01T00:00:00+07:00')`)
      .run().lastInsertRowid as number;
    const ev = recordCashEvent(
      { occurred_at: `${today()}T10:00:00+07:00`, direction: 'keluar', amount_minor: 90_000, account_id: mandiri(), kind: 'pengeluaran_pribadi', reference_no: 'BANK-EDIT-1', source: 'gmail', evidence: [{ evidence_id: bukti, role: 'notifikasi_bank' }] },
      database,
    );
    expect(() => ubahTransaksi(ev.id, { jumlah_minor: 10_000 }, 'uji', database)).toThrow(/bukti dari bank/);
    expect(getCashEvent(ev.id, database)!.amount_minor).toBe(90_000);
  });

  it('menolak mengubah nominal transaksi yang terbagi', () => {
    const r = buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 120_000, rekening_id: mandiri(), orang: [{ nama: 'A', jumlah_minor: 60_000 }] }, 'uji', database);
    expect(() => ubahTransaksi(r.id, { jumlah_minor: 100_000 }, 'uji', database)).toThrow(TransaksiError);
  });

  it('mengubah merchant memindahkannya ke merchant kanonik yang cocok', () => {
    const r = dasar();
    ubahTransaksi(r.id, { merchant: 'Warung Bu Sri' }, 'uji', database);
    const row = database.prepare(`SELECT merchant_raw, merchant_id FROM cash_event WHERE id = ?`).get(r.id) as { merchant_raw: string; merchant_id: number };
    expect(row.merchant_raw).toBe('Warung Bu Sri');
    expect(row.merchant_id).toBeGreaterThan(0);
  });

  it('"ingat untuk merchant" menjadikan kategori itu bawaan transaksi berikutnya', () => {
    const r = dasar();
    ubahTransaksi(r.id, { kategori_id: kategori(database, 'hiburan'), ingat_untuk_merchant: true }, 'uji', database);
    const lanjut = buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 20_000, rekening_id: mandiri(), merchant: 'Warung', waktu: `${today()}T18:00` }, 'uji', database);
    expect(getCashEvent(lanjut.id, database)!.category_id).toBe(kategori(database, 'hiburan'));
  });

  it('mengubah waktu, proyek, dan catatan tercatat di audit', () => {
    const r = dasar();
    ubahTransaksi(r.id, { waktu: `${today()}T08:30`, proyek: 'MEDCOEL', catatan: 'dikoreksi' }, 'uji', database);
    const ev = getCashEvent(r.id, database)!;
    expect(ev.occurred_at.slice(11, 16)).toBe('08:30');
    expect(ev.project).toBe('MEDCOEL');
    expect(ev.note).toBe('dikoreksi');
  });

  it('drill-down per proyek menemukan transaksinya', () => {
    const r = dasar();
    ubahTransaksi(r.id, { proyek: 'MEDCOEL' }, 'uji', database);
    const hasil = rincian({ dari: today(), sampai: today(), proyek: 'medcoel' }, database);
    expect(hasil.jumlah_transaksi).toBe(1);
  });
});
