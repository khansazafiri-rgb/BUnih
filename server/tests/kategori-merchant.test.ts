import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, kategori, jumlahTransaksi } from './bantu.js';
import {
  CategoryError, categorySubtreeIds, createCategory, deactivateCategory, listCategoryTree, updateCategory,
} from '../src/domain/categories.js';
import {
  MerchantError, addAlias, listMerchants, mergeMerchants, resolveMerchant, setMerchantDefaultCategory,
} from '../src/domain/merchants.js';
import { recategorize, recordCashEvent, setAllocationCategory } from '../src/domain/ledger.js';
import { monthlyReport } from '../src/domain/reports.js';
import { today } from '../src/domain/time.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
});

describe('CRUD kategori', () => {
  it('membuat kategori dan subkategori', () => {
    const induk = createCategory({ name: 'Pendidikan Lanjut' }, 'uji', database);
    const anak = createCategory({ name: 'Buku Kuliah', parent_id: induk }, 'uji', database);
    const pohon = listCategoryTree({}, database);
    const node = pohon.find((n) => n.id === induk)!;
    expect(node.anak.map((a) => a.id)).toEqual([anak]);
  });

  it('menolak nama ganda dan nama terlalu pendek', () => {
    createCategory({ name: 'Olahraga' }, 'uji', database);
    expect(() => createCategory({ name: 'olahraga' }, 'uji', database)).toThrow(CategoryError);
    expect(() => createCategory({ name: 'a' }, 'uji', database)).toThrow(CategoryError);
  });

  it('mengganti nama dan memindahkan induk', () => {
    const a = createCategory({ name: 'Induk A' }, 'uji', database);
    const b = createCategory({ name: 'Induk B' }, 'uji', database);
    const c = createCategory({ name: 'Anak', parent_id: a }, 'uji', database);
    updateCategory(c, { name: 'Anak Baru', parent_id: b }, 'uji', database);
    expect(categorySubtreeIds(b, database)).toContain(c);
    expect(categorySubtreeIds(a, database)).not.toContain(c);
  });

  it('menolak lingkaran induk-anak', () => {
    const a = createCategory({ name: 'Satu' }, 'uji', database);
    const b = createCategory({ name: 'Dua', parent_id: a }, 'uji', database);
    expect(() => updateCategory(a, { parent_id: b }, 'uji', database)).toThrow(CategoryError);
    expect(() => updateCategory(a, { parent_id: a }, 'uji', database)).toThrow(CategoryError);
  });

  it('menonaktifkan tanpa menghapus: transaksi lama tetap menunjuk, anak naik ke induk di atasnya', () => {
    const kakek = createCategory({ name: 'Kakek' }, 'uji', database);
    const ayah = createCategory({ name: 'Ayah', parent_id: kakek }, 'uji', database);
    const cucu = createCategory({ name: 'Cucu', parent_id: ayah }, 'uji', database);
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 10_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        category_id: ayah,
        reference_no: 'KAT-001',
        source: 'manual',
      },
      database,
    );
    deactivateCategory(ayah, 'uji', database);

    const row = database.prepare(`SELECT category_id FROM cash_event WHERE id = ?`).get(ev.id) as { category_id: number };
    expect(row.category_id).toBe(ayah);
    const pohon = listCategoryTree({}, database);
    expect(pohon.flatMap((n) => [n.id, ...n.anak.map((a) => a.id)])).not.toContain(ayah);
    expect(categorySubtreeIds(kakek, database)).toContain(cucu);
    const semua = listCategoryTree({ termasukNonaktif: true }, database);
    expect(JSON.stringify(semua)).toContain('Ayah');
  });
});

describe('perubahan kategori pada transaksi terbagi', () => {
  function transaksiTerbagi() {
    return recordCashEvent(
      {
        occurred_at: `${today()}T12:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 100_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        merchant_raw: 'Toko Serba Ada',
        category_id: kategori(database, 'makan'),
        reference_no: 'SPLIT-001',
        source: 'manual',
        allocations: [
          { amount_minor: 60_000, purpose: 'biaya_pribadi', bearer_type: 'saya', category_id: kategori(database, 'makan') },
          { amount_minor: 40_000, purpose: 'biaya_pribadi', bearer_type: 'saya', category_id: kategori(database, 'transport') },
        ],
      },
      database,
    );
  }

  function perKategori() {
    const lap = monthlyReport(today().slice(0, 7), database);
    return Object.fromEntries(lap.biaya_pribadi_per_kategori.map((k) => [k.kategori, k.minor]));
  }

  it('hanya potongan berkategori lama yang ikut berganti; potongan lain tetap', () => {
    const ev = transaksiTerbagi();
    recategorize(ev.id, { category_id: kategori(database, 'hiburan') }, 'uji', database);

    const per = perKategori();
    expect(per['Hiburan']).toBe(60_000);
    expect(per['Transport']).toBe(40_000);
    expect(per['Makan']).toBeUndefined();
    // Total tetap utuh.
    expect(Object.values(per).reduce((a, b) => a + b, 0)).toBe(100_000);
  });

  it('mengubah kategori satu potongan saja', () => {
    const ev = transaksiTerbagi();
    const potongan = database
      .prepare(`SELECT id FROM allocation WHERE cash_event_id = ? AND amount_minor = 40000`)
      .get(ev.id) as { id: number };
    setAllocationCategory(potongan.id, kategori(database, 'kesehatan'), 'uji', database);
    const per = perKategori();
    expect(per['Kesehatan']).toBe(40_000);
    expect(per['Makan']).toBe(60_000);
  });

  it('menolak mengganti kategori potongan yang bukan pengeluaran (transfer)', () => {
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T12:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 100_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'setoran_tabungan',
        reference_no: 'TAB-001',
        source: 'manual',
      },
      database,
    );
    const potongan = database.prepare(`SELECT id FROM allocation WHERE cash_event_id = ?`).get(ev.id) as { id: number };
    expect(() => setAllocationCategory(potongan.id, kategori(database, 'makan'), 'uji', database)).toThrow();
  });

  it('mengosongkan kategori memperbarui potongan yang ikut kategori lama', () => {
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T12:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 30_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        category_id: kategori(database, 'makan'),
        reference_no: 'CLR-001',
        source: 'manual',
      },
      database,
    );
    recategorize(ev.id, { category_id: null }, 'uji', database);
    const a = database.prepare(`SELECT category_id FROM allocation WHERE cash_event_id = ?`).get(ev.id) as { category_id: number | null };
    expect(a.category_id).toBeNull();
  });
});

describe('merchant dan alias', () => {
  it('menyatukan penulisan berbeda dari merchant yang sama', () => {
    const a = resolveMerchant('Kantin Kampus', database)!;
    const b = resolveMerchant('KANTIN  KAMPUS!!', database)!;
    expect(b.id).toBe(a.id);
    expect(b.baru).toBe(false);
  });

  it('TIDAK menyatukan nama yang hanya mirip', () => {
    const a = resolveMerchant('Warung Bu Sri', database)!;
    const b = resolveMerchant('Warung Sri', database)!;
    expect(b.id).not.toBe(a.id);
  });

  it('alias manual mengelompokkan transaksi lama dan baru ke satu merchant', () => {
    const dasar = {
      direction: 'keluar' as const,
      amount_minor: 20_000,
      account_id: akun(database, 'Mandiri'),
      kind: 'pengeluaran_pribadi' as const,
      source: 'manual' as const,
    };
    const e1 = recordCashEvent({ ...dasar, occurred_at: `${today()}T08:00:00+07:00`, merchant_raw: 'QRIS KOPI KENANGAN 0123', reference_no: 'AL-001' }, database);
    const e2 = recordCashEvent({ ...dasar, occurred_at: `${today()}T09:00:00+07:00`, merchant_raw: 'Kopi Kenangan', reference_no: 'AL-002' }, database);
    const m1 = (database.prepare(`SELECT merchant_id FROM cash_event WHERE id = ?`).get(e1.id) as { merchant_id: number }).merchant_id;
    const m2 = (database.prepare(`SELECT merchant_id FROM cash_event WHERE id = ?`).get(e2.id) as { merchant_id: number }).merchant_id;
    expect(m1).not.toBe(m2);

    addAlias(m2, 'QRIS KOPI KENANGAN 0123', 'uji', database);
    const lama = (database.prepare(`SELECT merchant_id FROM cash_event WHERE id = ?`).get(e1.id) as { merchant_id: number }).merchant_id;
    expect(lama).toBe(m2);

    const e3 = recordCashEvent({ ...dasar, occurred_at: `${today()}T10:00:00+07:00`, merchant_raw: 'qris kopi kenangan 0123', reference_no: 'AL-003' }, database);
    expect((database.prepare(`SELECT merchant_id FROM cash_event WHERE id = ?`).get(e3.id) as { merchant_id: number }).merchant_id).toBe(m2);
  });

  it('menolak alias yang dipakai merchant yang sudah diatur pengguna', () => {
    const a = resolveMerchant('Toko A', database)!;
    const b = resolveMerchant('Toko B', database)!;
    setMerchantDefaultCategory(b.id, kategori(database, 'makan'), 'uji', database);
    expect(() => addAlias(a.id, 'Toko B', 'uji', database)).toThrow(MerchantError);
  });

  it('alias yang dipakai merchant buatan otomatis langsung memindahkannya (tanpa langkah gabung manual)', () => {
    const a = resolveMerchant('Toko A', database)!;
    const otomatis = resolveMerchant('QRIS TOKO A 0099', database)!;
    expect(otomatis.id).not.toBe(a.id);
    addAlias(a.id, 'QRIS TOKO A 0099', 'uji', database);
    const aktif = listMerchants({}, database).map((m) => m.id);
    expect(aktif).toContain(a.id);
    expect(aktif).not.toContain(otomatis.id);
    expect(resolveMerchant('qris toko a 0099', database)!.id).toBe(a.id);
  });

  it('penggabungan eksplisit memindahkan transaksi dan alias, dan menonaktifkan sumbernya', () => {
    const dasar = {
      direction: 'keluar' as const,
      amount_minor: 15_000,
      account_id: akun(database, 'Mandiri'),
      kind: 'pengeluaran_pribadi' as const,
      source: 'manual' as const,
    };
    const e1 = recordCashEvent({ ...dasar, occurred_at: `${today()}T08:00:00+07:00`, merchant_raw: 'Bakso Pak Eko', reference_no: 'MG-001' }, database);
    const e2 = recordCashEvent({ ...dasar, occurred_at: `${today()}T09:00:00+07:00`, merchant_raw: 'Bakso Eko', reference_no: 'MG-002' }, database);
    const dari = (database.prepare(`SELECT merchant_id FROM cash_event WHERE id = ?`).get(e1.id) as { merchant_id: number }).merchant_id;
    const ke = (database.prepare(`SELECT merchant_id FROM cash_event WHERE id = ?`).get(e2.id) as { merchant_id: number }).merchant_id;

    const hasil = mergeMerchants(dari, ke, 'uji', database);
    expect(hasil.transaksi_dipindah).toBe(1);
    const aktif = listMerchants({}, database).filter((m) => m.id === dari || m.id === ke);
    expect(aktif.map((m) => m.id)).toEqual([ke]);
    expect(aktif[0]!.jumlah_transaksi).toBe(2);
    expect(aktif[0]!.alias.length).toBeGreaterThanOrEqual(2);
  });

  it('kategori bawaan merchant dipakai untuk transaksi baru tanpa kategori, tetapi kategori eksplisit menang', () => {
    const m = resolveMerchant('Kantin Kampus', database)!;
    setMerchantDefaultCategory(m.id, kategori(database, 'makan'), 'uji', database);
    const dasar = {
      direction: 'keluar' as const,
      amount_minor: 18_000,
      account_id: akun(database, 'Mandiri'),
      kind: 'pengeluaran_pribadi' as const,
      merchant_raw: 'Kantin Kampus',
      source: 'manual' as const,
    };
    const otomatis = recordCashEvent({ ...dasar, occurred_at: `${today()}T08:00:00+07:00`, reference_no: 'DEF-001' }, database);
    const eksplisit = recordCashEvent({ ...dasar, occurred_at: `${today()}T09:00:00+07:00`, reference_no: 'DEF-002', category_id: kategori(database, 'hiburan') }, database);
    const ambil = (id: number) => (database.prepare(`SELECT category_id FROM cash_event WHERE id = ?`).get(id) as { category_id: number }).category_id;
    expect(ambil(otomatis.id)).toBe(kategori(database, 'makan'));
    expect(ambil(eksplisit.id)).toBe(kategori(database, 'hiburan'));
  });

  it('kategori bawaan merchant tidak dipakai untuk uang masuk atau transfer', () => {
    const m = resolveMerchant('Transfer Rutin', database)!;
    setMerchantDefaultCategory(m.id, kategori(database, 'makan'), 'uji', database);
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T08:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 100_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'setoran_tabungan',
        merchant_raw: 'Transfer Rutin',
        reference_no: 'TF-DEF',
        source: 'manual',
      },
      database,
    );
    const r = database.prepare(`SELECT category_id FROM cash_event WHERE id = ?`).get(ev.id) as { category_id: number | null };
    expect(r.category_id).toBeNull();
  });
});

describe('pencegahan duplikat lintas sumber', () => {
  const dasar = () => ({
    direction: 'keluar' as const,
    amount_minor: 25_000,
    account_id: akun(database, 'Mandiri'),
    kind: 'pengeluaran_pribadi' as const,
    merchant_raw: 'Kopi Kenangan',
  });

  it('kirim ganda dalam hitungan detik (tombol ditekan dua kali) digabung', () => {
    const waktu = `${today()}T12:00:00+07:00`;
    const a = recordCashEvent({ ...dasar(), occurred_at: waktu, source: 'manual' }, database);
    const b = recordCashEvent({ ...dasar(), occurred_at: waktu, source: 'manual' }, database);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(jumlahTransaksi(database)).toBe(1);
  });

  it('dua pembelian identik di jam berbeda tetap dua transaksi', () => {
    recordCashEvent({ ...dasar(), occurred_at: `${today()}T09:00:00+07:00`, source: 'manual' }, database);
    recordCashEvent({ ...dasar(), occurred_at: `${today()}T16:00:00+07:00`, source: 'manual' }, database);
    expect(jumlahTransaksi(database)).toBe(2);
  });

  it('bukti bank melengkapi catatan manual yang sama, bukan membuat transaksi kedua', () => {
    const manual = recordCashEvent({ ...dasar(), occurred_at: `${today()}T12:00:00+07:00`, source: 'manual' }, database);
    const bank = recordCashEvent(
      { ...dasar(), occurred_at: `${today()}T12:03:00+07:00`, reference_no: 'BANK-998877', source: 'gmail', merchant_raw: 'QRIS KOPI KENANGAN' },
      database,
    );
    expect(bank.created).toBe(false);
    expect(bank.id).toBe(manual.id);
    expect(jumlahTransaksi(database)).toBe(1);
    const row = database.prepare(`SELECT reference_no FROM cash_event WHERE id = ?`).get(manual.id) as { reference_no: string };
    expect(row.reference_no).toBe('BANK-998877');

    // Email bank yang sama diproses ulang: tetap satu transaksi.
    const ulang = recordCashEvent(
      { ...dasar(), occurred_at: `${today()}T12:03:00+07:00`, reference_no: 'BANK-998877', source: 'gmail', merchant_raw: 'QRIS KOPI KENANGAN' },
      database,
    );
    expect(ulang.created).toBe(false);
    expect(jumlahTransaksi(database)).toBe(1);
  });

  it('bila ada dua catatan manual yang mirip, tidak menebak: bukti bank menjadi transaksi terpisah', () => {
    recordCashEvent({ ...dasar(), occurred_at: `${today()}T09:00:00+07:00`, source: 'manual' }, database);
    recordCashEvent({ ...dasar(), occurred_at: `${today()}T15:00:00+07:00`, source: 'manual' }, database);
    const bank = recordCashEvent(
      { ...dasar(), occurred_at: `${today()}T15:02:00+07:00`, reference_no: 'BANK-112233', source: 'gmail' },
      database,
    );
    expect(bank.created).toBe(true);
    expect(jumlahTransaksi(database)).toBe(3);
  });

  it('bukti bank untuk jumlah berbeda tidak digabung dengan catatan manual', () => {
    recordCashEvent({ ...dasar(), occurred_at: `${today()}T12:00:00+07:00`, source: 'manual' }, database);
    const bank = recordCashEvent(
      { ...dasar(), amount_minor: 26_000, occurred_at: `${today()}T12:03:00+07:00`, reference_no: 'BANK-445566', source: 'gmail' },
      database,
    );
    expect(bank.created).toBe(true);
  });
});
