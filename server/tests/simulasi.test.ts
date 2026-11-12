import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { dbUji, pasangPeriode, pasangSaldo } from './bantu.js';
import { simulasiPembelian, bandingkanSkenario } from '../src/domain/simulate.js';
import { rebuildObligations } from '../src/domain/obligations.js';
import { setAssumption } from '../src/domain/assumptions.js';
import { addDays, today } from '../src/domain/time.js';

let database: DB;

/** Keadaan yang serba pasti, supaya pengujian verdict tidak terganggu ketidakpastian lain. */
function keadaanPasti(): DB {
  const d = dbUji();
  pasangSaldo(d, 'Mandiri', 5_000_000, -1);
  pasangSaldo(d, 'BCA', 0, -1);
  // Semua layanan dinonaktifkan agar tidak ada nominal perkiraan yang tersisa.
  d.prepare(`UPDATE service SET status = 'tidak_dilanjutkan', next_due_date = NULL`).run();
  d.prepare(`UPDATE invoice SET status = 'dibatalkan'`).run();
  setAssumption('anggaran_makan_harian', 30_000, { certainty: 'terverifikasi', source: 'manual', effectiveFrom: '1970-01-01' }, d);
  setAssumption('cadangan_minimal', 500_000, { certainty: 'terverifikasi', source: 'manual', effectiveFrom: '1970-01-01' }, d);
  rebuildObligations({}, d);
  return d;
}

beforeEach(() => {
  database = keadaanPasti();
});

describe('Bolehkah aku beli ini?', () => {
  it('pembelian kecil dengan semua angka pasti dinyatakan aman', () => {
    const h = simulasiPembelian({ label: 'Keyboard', harga_minor: 350_000, jenis: 'pribadi' }, database);
    expect(h.verdict).toBe('aman');
    expect(h.jawaban).toContain('Masih aman');
  });

  it('tidak pernah menyebut aman bila harga belum diketahui', () => {
    const h = simulasiPembelian({ label: 'Monitor bekas', harga_minor: null, jenis: 'pribadi' }, database);
    expect(h.verdict).toBe('belum_pasti');
    expect(h.jawaban).not.toContain('aman');
    expect(h.jawaban).toContain('belum');
  });

  it('tidak menyebut aman bila ada nominal yang masih perkiraan', () => {
    const d = dbUji();
    pasangSaldo(d, 'Mandiri', 5_000_000, -1);
    rebuildObligations({}, d);
    const h = simulasiPembelian({ label: 'Keyboard', harga_minor: 100_000, jenis: 'pribadi' }, d);
    expect(h.verdict).not.toBe('aman');
    expect(h.ketidakpastian.length).toBeGreaterThan(0);
  });

  it('memberi angka konkret saat menembus cadangan minimal', () => {
    const d = keadaanPasti();
    d.prepare(`DELETE FROM reconciliation`).run();
    pasangSaldo(d, 'Mandiri', 900_000, -1);
    const h = simulasiPembelian({ label: 'HP', harga_minor: 600_000, jenis: 'pribadi', bisa_ditunda: true }, d);
    expect(['hati_hati', 'tidak_aman']).toContain(h.verdict);
    expect(h.dampak.melewati_cadangan).toBe(true);
    expect(h.dampak.kekurangan_dari_cadangan_minor).toBeGreaterThan(0);
    expect(h.jawaban).toMatch(/di bawah batas|defisit/);
  });

  it('menyatakan tidak aman bila menyebabkan defisit', () => {
    const d = keadaanPasti();
    d.prepare(`DELETE FROM reconciliation`).run();
    pasangSaldo(d, 'Mandiri', 400_000, -1);
    const h = simulasiPembelian({ label: 'Laptop', harga_minor: 3_000_000, jenis: 'pribadi' }, d);
    expect(h.verdict).toBe('tidak_aman');
    expect(h.dampak.tanggal_defisit).not.toBeNull();
  });

  it('talangan menambah piutang dan beban pribadi menjadi nol', () => {
    const h = simulasiPembelian(
      { label: 'Tiket teman', harga_minor: 300_000, jenis: 'talangan', bagian_kembali_minor: 300_000 },
      database,
    );
    expect(h.dampak.piutang_bertambah_minor).toBe(300_000);
    expect(h.beban_pribadi_minor).toBe(0);
  });

  it('hadiah tetap menjadi beban pribadi penuh', () => {
    const h = simulasiPembelian({ label: 'Kado', harga_minor: 200_000, jenis: 'hadiah' }, database);
    expect(h.beban_pribadi_minor).toBe(200_000);
    expect(h.dampak.piutang_bertambah_minor).toBe(0);
  });

  it('pembayaran bersama hanya membebani bagianku', () => {
    const h = simulasiPembelian(
      { label: 'Makan bersama', harga_minor: 120_000, jenis: 'bersama', bagian_kembali_minor: 90_000 },
      database,
    );
    expect(h.beban_pribadi_minor).toBe(30_000);
    expect(h.dampak.piutang_bertambah_minor).toBe(90_000);
  });

  it('menyebut saldo terendah sebelum top-up berikutnya', () => {
    const d = keadaanPasti();
    pasangPeriode(d, 1);
    rebuildObligations({}, d);
    const h = simulasiPembelian({ label: 'Sepatu', harga_minor: 400_000, jenis: 'pribadi' }, d);
    expect(h.dampak.tanggal_topup_berikutnya).not.toBeNull();
    expect(h.dampak.saldo_terendah_sebelum_topup_minor).not.toBeNull();
  });
});

describe('perbandingan skenario', () => {
  it('membandingkan tanpa dan dengan Claude Pro pribadi', () => {
    const d = dbUji();
    pasangSaldo(d, 'Mandiri', 5_000_000, -1);
    d.prepare(`UPDATE service SET next_due_date = ? WHERE slug = 'claude-pro-pribadi'`).run(addDays(today(), 2));
    rebuildObligations({}, d);

    const hasil = bandingkanSkenario(['tanpa-claude-pribadi', 'dengan-claude-pribadi'], {}, d);
    expect(hasil).toHaveLength(2);
    expect(hasil[1]!.saldo_akhir_minor).toBeLessThan(hasil[0]!.saldo_akhir_minor);
    expect(hasil[0]!.asumsi_dipakai.some((a) => a.key === 'cadangan_minimal')).toBe(true);
  });
});
