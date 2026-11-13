import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, kategori, jumlahTransaksi, pasangSaldo } from './bantu.js';
import {
  BudgetError, amountAt, createBudget, dailyEquivalentForCategory, evaluateBudget, getBudget, reviseBudget,
  updateBudget, windowFor,
} from '../src/domain/budgets.js';
import {
  GoalError, addContribution, createGoal, evaluateGoal, getGoal, listGoals, updateGoal,
} from '../src/domain/goals.js';
import { recordCashEvent } from '../src/domain/ledger.js';
import { createCategory } from '../src/domain/categories.js';
import { project } from '../src/domain/projection.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
});

/** Pengeluaran pada tanggal tetap, supaya angka anggaran bisa dihitung manual. */
function belanja(tanggal: string, jumlah: number, slug: string | null, ref: string, extra: Record<string, unknown> = {}) {
  return recordCashEvent(
    {
      occurred_at: `${tanggal}T12:00:00+07:00`,
      direction: 'keluar',
      amount_minor: jumlah,
      account_id: akun(database, 'Mandiri'),
      kind: 'pengeluaran_pribadi',
      category_id: slug ? kategori(database, slug) : null,
      reference_no: ref,
      source: 'manual',
      ...extra,
    },
    database,
  );
}

describe('jendela anggaran', () => {
  const dasar = { id: 1, name: 'x', category_id: null, amount_minor: 1, end_date: null, rollover: 0, active: 1, note: null };

  it('bulanan berulang memakai bulan kalender dari tanggal acuan', () => {
    const b = { ...dasar, period: 'bulanan' as const, start_date: '2026-01-15', recurring: 1 };
    expect(windowFor(b, '2026-11-12')).toEqual({ dari: '2026-11-01', sampai: '2026-11-30' });
  });

  it('mingguan berulang memakai Senin sampai Minggu', () => {
    const b = { ...dasar, period: 'mingguan' as const, start_date: '2026-01-01', recurring: 1 };
    expect(windowFor(b, '2026-11-12')).toEqual({ dari: '2026-11-09', sampai: '2026-11-15' });
  });

  it('mingguan sekali berjalan tujuh hari dari tanggal mulai', () => {
    const b = { ...dasar, period: 'mingguan' as const, start_date: '2026-11-04', recurring: 0 };
    expect(windowFor(b, '2026-12-25')).toEqual({ dari: '2026-11-04', sampai: '2026-11-10' });
  });

  it('kustom memakai rentang yang diberikan', () => {
    const b = { ...dasar, period: 'kustom' as const, start_date: '2026-11-01', end_date: '2026-11-20', recurring: 0 };
    expect(windowFor(b, '2026-11-12')).toEqual({ dari: '2026-11-01', sampai: '2026-11-20' });
  });
});

describe('perhitungan anggaran', () => {
  it('menghitung terpakai, sisa, persen, dan hari tersisa dari pengeluaran nyata', () => {
    const id = createBudget(
      { name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 900_000, start_date: '2026-11-01' },
      'uji',
      database,
    );
    belanja('2026-11-02', 100_000, 'makan', 'B-1');
    belanja('2026-11-05', 150_000, 'makan', 'B-2');
    belanja('2026-11-05', 80_000, 'transport', 'B-3'); // bukan makan: tidak ikut

    const e = evaluateBudget(getBudget(id, database)!, '2026-11-10', database);
    expect(e.terpakai_minor).toBe(250_000);
    expect(e.dialokasikan_minor).toBe(900_000);
    expect(e.sisa_minor).toBe(650_000);
    expect(e.persen_terpakai).toBe(28);
    expect(e.hari_berjalan).toBe(10);
    expect(e.hari_tersisa).toBe(21);
    // 650.000 / 21 hari = 30.952 -> dibulatkan ke bawah
    expect(e.sisa_per_hari_minor).toBe(30_952);
  });

  it('perkiraan akhir bulan adalah ESTIMASI linear dan ditandai dengan jelas', () => {
    const id = createBudget(
      { name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 600_000, start_date: '2026-11-01' },
      'uji',
      database,
    );
    belanja('2026-11-02', 200_000, 'makan', 'F-1');
    belanja('2026-11-05', 100_000, 'makan', 'F-2');
    const e = evaluateBudget(getBudget(id, database)!, '2026-11-10', database);
    // 300.000 dalam 10 hari -> 30 hari = 900.000
    expect(e.perkiraan_akhir_minor).toBe(900_000);
    expect(e.status).toBe('berisiko');
    expect(e.terpakai_minor).toBeLessThan(e.dialokasikan_minor);
  });

  it('data terlalu sedikit di awal periode tidak menghasilkan perkiraan yang menyesatkan', () => {
    const id = createBudget(
      { name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 600_000, start_date: '2026-11-01' },
      'uji',
      database,
    );
    belanja('2026-11-01', 100_000, 'makan', 'D-1');
    const e = evaluateBudget(getBudget(id, database)!, '2026-11-02', database);
    expect(e.perkiraan_akhir_minor).toBeNull();
    expect(e.perkiraan_terbatas).toBe(true);
    expect(e.status).toBe('aman');
  });

  it('status lewat saat terpakai melebihi batas', () => {
    const id = createBudget({ name: 'Hiburan', category_id: kategori(database, 'hiburan'), period: 'bulanan', amount_minor: 200_000, start_date: '2026-11-01' }, 'uji', database);
    belanja('2026-11-03', 250_000, 'hiburan', 'L-1');
    const e = evaluateBudget(getBudget(id, database)!, '2026-11-12', database);
    expect(e.status).toBe('lewat');
    expect(e.sisa_minor).toBe(-50_000);
  });

  it('refund mengurangi pemakaian, bukan menambah pemasukan', () => {
    const id = createBudget({ name: 'Belanja', category_id: kategori(database, 'belanja-barang'), period: 'bulanan', amount_minor: 500_000, start_date: '2026-11-01' }, 'uji', database);
    belanja('2026-11-04', 300_000, 'belanja-barang', 'R-1');
    recordCashEvent(
      {
        occurred_at: '2026-11-06T10:00:00+07:00',
        direction: 'masuk',
        amount_minor: 100_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'refund',
        category_id: kategori(database, 'belanja-barang'),
        reference_no: 'R-2',
        source: 'manual',
      },
      database,
    );
    expect(evaluateBudget(getBudget(id, database)!, '2026-11-10', database).terpakai_minor).toBe(200_000);
  });

  it('transfer sendiri, piutang teman, dan biaya company langsung tidak mengurangi anggaran', () => {
    const id = createBudget({ name: 'Total', category_id: null, period: 'bulanan', amount_minor: 1_000_000, start_date: '2026-11-01' }, 'uji', database);
    belanja('2026-11-02', 50_000, 'makan', 'X-1');
    recordCashEvent({ occurred_at: '2026-11-03T10:00:00+07:00', direction: 'keluar', amount_minor: 500_000, account_id: akun(database, 'Mandiri'), kind: 'setoran_tabungan', reference_no: 'X-2', source: 'manual' }, database);
    recordCashEvent({ occurred_at: '2026-11-04T10:00:00+07:00', direction: 'keluar', amount_minor: 120_000, account_id: akun(database, 'Mandiri'), kind: 'talangan', reference_no: 'X-3', source: 'manual' }, database);
    recordCashEvent({ occurred_at: '2026-11-05T10:00:00+07:00', direction: 'keluar', amount_minor: 410_700, account_id: null, kind: 'pengeluaran_company_langsung', reference_no: 'X-4', source: 'manual' }, database);
    expect(evaluateBudget(getBudget(id, database)!, '2026-11-10', database).terpakai_minor).toBe(50_000);
  });

  it('anggaran induk mencakup turunan kategorinya', () => {
    const induk = kategori(database, 'makan');
    const anak = createCategory({ name: 'Kopi dan jajan', parent_id: induk }, 'uji', database);
    const id = createBudget({ name: 'Makan', category_id: induk, period: 'bulanan', amount_minor: 500_000, start_date: '2026-11-01' }, 'uji', database);
    recordCashEvent({ occurred_at: '2026-11-03T10:00:00+07:00', direction: 'keluar', amount_minor: 30_000, account_id: akun(database, 'Mandiri'), kind: 'pengeluaran_pribadi', category_id: anak, reference_no: 'S-1', source: 'manual' }, database);
    expect(evaluateBudget(getBudget(id, database)!, '2026-11-10', database).terpakai_minor).toBe(30_000);
  });

  it('anggaran harian dan mingguan', () => {
    const harian = createBudget({ name: 'Makan harian', category_id: kategori(database, 'makan'), period: 'harian', amount_minor: 30_000, start_date: '2026-11-01' }, 'uji', database);
    const mingguan = createBudget({ name: 'Transport mingguan', category_id: kategori(database, 'transport'), period: 'mingguan', amount_minor: 100_000, start_date: '2026-11-01' }, 'uji', database);
    belanja('2026-11-12', 35_000, 'makan', 'H-1');
    belanja('2026-11-10', 40_000, 'transport', 'H-2'); // Selasa pekan yang sama
    expect(evaluateBudget(getBudget(harian, database)!, '2026-11-12', database).status).toBe('lewat');
    const m = evaluateBudget(getBudget(mingguan, database)!, '2026-11-12', database);
    expect(m.terpakai_minor).toBe(40_000);
    expect(m.hari_tersisa).toBe(4);
  });

  it('rollover membawa sisa periode lalu, tetapi tidak membawa kelebihan', () => {
    const id = createBudget(
      { name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 500_000, start_date: '2026-09-01', rollover: true },
      'uji',
      database,
    );
    belanja('2026-09-10', 400_000, 'makan', 'RO-1'); // sisa 100.000
    belanja('2026-10-10', 700_000, 'makan', 'RO-2'); // lebih 200.000 -> tidak dibawa
    const e = evaluateBudget(getBudget(id, database)!, '2026-11-10', database);
    expect(e.carry_minor).toBe(100_000);
    expect(e.dialokasikan_minor).toBe(600_000);
  });

  it('tanpa rollover tidak ada carry', () => {
    const id = createBudget({ name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 500_000, start_date: '2026-09-01' }, 'uji', database);
    belanja('2026-09-10', 100_000, 'makan', 'NR-1');
    expect(evaluateBudget(getBudget(id, database)!, '2026-11-10', database).carry_minor).toBe(0);
  });

  it('menolak nominal nol, kategori tidak ada, dan kustom tanpa tanggal', () => {
    expect(() => createBudget({ name: 'x', period: 'bulanan', amount_minor: 0 }, 'uji', database)).toThrow(BudgetError);
    expect(() => createBudget({ name: 'x', period: 'bulanan', amount_minor: 100, category_id: 99999 }, 'uji', database)).toThrow(BudgetError);
    expect(() => createBudget({ name: 'x', period: 'kustom', amount_minor: 100 }, 'uji', database)).toThrow(BudgetError);
  });
});

describe('penyesuaian anggaran tanpa menghapus riwayat', () => {
  it('revisi berlaku mulai tanggalnya dan nominal masa lalu tidak berubah', () => {
    const id = createBudget({ name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 500_000, start_date: '2026-09-01' }, 'uji', database);
    reviseBudget(id, 700_000, { effective_from: '2026-11-01' }, 'uji', database);
    const b = getBudget(id, database)!;
    expect(amountAt(b, '2026-10-15', database)).toBe(500_000);
    expect(amountAt(b, '2026-11-15', database)).toBe(700_000);
    expect(evaluateBudget(b, '2026-10-20', database).dialokasikan_minor).toBe(500_000);
    expect(evaluateBudget(b, '2026-11-20', database).dialokasikan_minor).toBe(700_000);
  });

  it('menonaktifkan anggaran tidak menghapus datanya', () => {
    const id = createBudget({ name: 'Makan', period: 'bulanan', amount_minor: 500_000, start_date: '2026-11-01' }, 'uji', database);
    updateBudget(id, { active: false }, 'uji', database);
    expect(getBudget(id, database)).toBeDefined();
    expect(getBudget(id, database)!.active).toBe(0);
  });
});

describe('anggaran makan menjadi sumber rencana makan di proyeksi', () => {
  it('setara harian dari anggaran bulanan', () => {
    createBudget({ name: 'Makan', category_id: kategori(database, 'makan'), period: 'bulanan', amount_minor: 900_000, start_date: '2026-11-01' }, 'uji', database);
    expect(dailyEquivalentForCategory('makan', '2026-11-12', database)).toBe(30_000); // 900.000 / 30 hari
    expect(dailyEquivalentForCategory('makan', '2026-12-12', database)).toBe(29_032); // 900.000 / 31 hari
    expect(dailyEquivalentForCategory('transport', '2026-11-12', database)).toBeNull();
  });

  it('proyeksi memakai anggaran makan bila ada, dan asumsi lama bila tidak ada', () => {
    pasangSaldo(database, 'Mandiri', 5_000_000, -1);
    const hari = (p: ReturnType<typeof project>) => p.hari.find((h) => h.tanggal > p.hari_ini)!;
    const tanpa = project({ dari: new Date().toISOString().slice(0, 10), sampai: undefined }, database);
    expect(hari(tanpa).makan_rencana_minor).toBe(30_000); // asumsi lama

    createBudget({ name: 'Makan', category_id: kategori(database, 'makan'), period: 'harian', amount_minor: 45_000, start_date: '2026-01-01' }, 'uji', database);
    const dengan = project({}, database);
    expect(hari(dengan).makan_rencana_minor).toBe(45_000);
  });
});

describe('tujuan keuangan', () => {
  it('membuat beberapa tujuan secara independen', () => {
    const a = createGoal({ name: 'Laptop', target_minor: 5_000_000 }, 'uji', database);
    const b = createGoal({ name: 'Dana darurat', target_minor: 10_000_000, start_minor: 1_000_000 }, 'uji', database);
    expect(listGoals({}, database).map((g) => g.id)).toEqual([a, b]);
  });

  it('menyisihkan uang untuk tujuan TIDAK membuat atau memindahkan uang', () => {
    pasangSaldo(database, 'Mandiri', 2_000_000);
    const g = createGoal({ name: 'Laptop', target_minor: 5_000_000 }, 'uji', database);
    const sebelum = jumlahTransaksi(database);
    addContribution(g, { amount_minor: 500_000, kind: 'disisihkan', occurred_on: '2026-11-05' }, 'uji', database);
    expect(jumlahTransaksi(database)).toBe(sebelum);
    const e = evaluateGoal(getGoal(g, database)!, '2026-11-10', database);
    expect(e.terkumpul_minor).toBe(500_000);
    expect(e.disisihkan_minor).toBe(500_000);
    expect(e.dari_transfer_tercatat_minor).toBe(0);
  });

  it('membedakan transfer tabungan nyata dari sekadar penanda dan menolak hitung ganda', () => {
    const g = createGoal({ name: 'Liburan', target_minor: 2_000_000 }, 'uji', database);
    const tf = recordCashEvent(
      { occurred_at: '2026-11-05T10:00:00+07:00', direction: 'keluar', amount_minor: 300_000, account_id: akun(database, 'Mandiri'), kind: 'setoran_tabungan', reference_no: 'G-TF', source: 'manual' },
      database,
    );
    addContribution(g, { amount_minor: 300_000, kind: 'transfer_tercatat', cash_event_id: tf.id, occurred_on: '2026-11-05' }, 'uji', database);
    expect(() => addContribution(g, { amount_minor: 300_000, kind: 'transfer_tercatat', cash_event_id: tf.id }, 'uji', database)).toThrow(GoalError);
    const e = evaluateGoal(getGoal(g, database)!, '2026-11-10', database);
    expect(e.dari_transfer_tercatat_minor).toBe(300_000);
    expect(e.terkumpul_minor).toBe(300_000);
  });

  it('menghitung sisa, persen, dan kebutuhan setoran per bulan/minggu', () => {
    const g = createGoal({ name: 'Laptop', target_minor: 5_000_000, start_minor: 1_000_000, target_date: '2027-02-28' }, 'uji', database);
    const e = evaluateGoal(getGoal(g, database)!, '2026-11-30', database);
    expect(e.sisa_minor).toBe(4_000_000);
    expect(e.persen).toBe(20);
    expect(e.hari_tersisa).toBe(90);
    // 4.000.000 x 30,4375 hari/bulan / 90 hari = 1.352.777,8 -> dibulatkan ke atas
    expect(e.perlu_per_bulan_minor).toBe(1_352_778);
    expect(e.perlu_per_minggu_minor).toBe(311_112);
  });

  it('menjelaskan bila tujuan berisiko gagal tepat waktu', () => {
    const g = createGoal({ name: 'Laptop', target_minor: 5_000_000, target_date: '2027-02-28' }, 'uji', database);
    addContribution(g, { amount_minor: 300_000, occurred_on: '2026-11-15' }, 'uji', database);
    const e = evaluateGoal(getGoal(g, database)!, '2026-11-30', database);
    expect(e.risiko).toBe('berisiko');
    expect(e.penjelasan).toContain('2027-02-28');
    expect(e.perkiraan_tercapai).not.toBeNull();
    expect(e.perkiraan_tercapai! > '2027-02-28').toBe(true);
  });

  it('tepat waktu bila laju cukup, dan belum ada setoran bila kosong', () => {
    const baik = createGoal({ name: 'A', target_minor: 1_000_000, target_date: '2027-02-28' }, 'uji', database);
    addContribution(baik, { amount_minor: 900_000, occurred_on: '2026-11-20' }, 'uji', database);
    expect(evaluateGoal(getGoal(baik, database)!, '2026-11-30', database).risiko).toBe('tepat');

    const kosong = createGoal({ name: 'B', target_minor: 1_000_000, target_date: '2027-02-28' }, 'uji', database);
    expect(evaluateGoal(getGoal(kosong, database)!, '2026-11-30', database).risiko).toBe('belum_ada_setoran');
  });

  it('terlambat bila tanggal target sudah lewat dan belum tercapai', () => {
    const g = createGoal({ name: 'A', target_minor: 1_000_000, target_date: '2026-10-01' }, 'uji', database);
    expect(evaluateGoal(getGoal(g, database)!, '2026-11-10', database).risiko).toBe('terlambat');
  });

  it('otomatis tercapai ketika terkumpul mencapai target, dan kembali aktif bila diambil', () => {
    const g = createGoal({ name: 'A', target_minor: 500_000 }, 'uji', database);
    addContribution(g, { amount_minor: 500_000, occurred_on: '2026-11-10' }, 'uji', database);
    expect(getGoal(g, database)!.status).toBe('tercapai');
    addContribution(g, { amount_minor: -100_000, occurred_on: '2026-11-11' }, 'uji', database);
    expect(getGoal(g, database)!.status).toBe('aktif');
  });

  it('tujuan dijeda tidak dihitung risikonya, dan yang dibatalkan tidak bisa diisi', () => {
    const g = createGoal({ name: 'A', target_minor: 500_000, target_date: '2027-01-01' }, 'uji', database);
    updateGoal(g, { status: 'dijeda' }, 'uji', database);
    expect(evaluateGoal(getGoal(g, database)!, '2026-11-10', database).risiko).toBe('dijeda');
    updateGoal(g, { status: 'dibatalkan' }, 'uji', database);
    expect(() => addContribution(g, { amount_minor: 1000 }, 'uji', database)).toThrow(GoalError);
  });

  it('menolak target nol dan nominal setoran nol', () => {
    expect(() => createGoal({ name: 'A', target_minor: 0 }, 'uji', database)).toThrow(GoalError);
    const g = createGoal({ name: 'A', target_minor: 1000 }, 'uji', database);
    expect(() => addContribution(g, { amount_minor: 0 }, 'uji', database)).toThrow(GoalError);
  });
});
