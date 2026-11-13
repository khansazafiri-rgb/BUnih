import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { dbUji, akun } from './bantu.js';
import { formatIDR, formatMoney, parseAmount, splitEvenly, toMinor } from '../src/domain/money.js';
import {
  addDays, addMonths, diffDays, eachDay, endOfMonth, formatTanggal, isValidDate, startOfWeek,
  toJakartaInstant, nowIso, dateOf,
} from '../src/domain/time.js';
import { detectIntent, parseRupiah, parseJumlahOrang } from '../src/telegram/nlu.js';
import { encryptJson, decryptJson, redact } from '../src/util/crypto.js';
import { createDecision, listDecisions, answerDecision, countOpenDecisions } from '../src/domain/decisions.js';
import { periodStartFor } from '../src/domain/periods.js';

describe('uang', () => {
  it('format rupiah Indonesia', () => {
    expect(formatIDR(349_000)).toBe('Rp349.000');
    expect(formatIDR(1_234_567)).toBe('Rp1.234.567');
    expect(formatIDR(-50_000)).toBe('-Rp50.000');
    expect(formatIDR(null)).toBe('belum diketahui');
  });

  it('mata uang asing memakai sen', () => {
    expect(toMinor(20, 'USD')).toBe(2000);
    expect(formatMoney(2000, 'USD')).toBe('USD 20,00');
  });

  it('pembagian rata tidak kehilangan rupiah', () => {
    const bagian = splitEvenly(100_000, 3);
    expect(bagian.reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(bagian).toEqual([33_334, 33_333, 33_333]);
  });

  it('membaca nominal dari teks', () => {
    expect(parseAmount('Rp1.500.000')?.minor).toBe(1_500_000);
    expect(parseAmount('tanpa angka')).toBeNull();
  });
});

describe('waktu Asia/Jakarta', () => {
  it('tanggal valid dan tidak valid', () => {
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2024-02-29')).toBe(true);
  });

  it('aritmetika tanggal melewati batas bulan dan tahun', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(diffDays('2026-11-01', '2026-11-23')).toBe(22);
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
  });

  it('minggu dimulai hari Senin', () => {
    expect(startOfWeek('2026-11-12')).toBe('2026-11-09');
  });

  it('eachDay menghasilkan rentang tertutup', () => {
    expect(eachDay('2026-11-01', '2026-11-03')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });

  it('format tanggal Indonesia', () => {
    expect(formatTanggal('2026-11-23')).toBe('23 November 2026');
  });

  it('instan tanpa zona dianggap waktu Jakarta', () => {
    expect(toJakartaInstant('2026-11-23T10:00:00')).toBe('2026-11-23T10:00:00+07:00');
    expect(dateOf(nowIso()).length).toBe(10);
  });

  it('UTC diubah ke Jakarta', () => {
    expect(toJakartaInstant('2026-11-23T03:00:00Z')).toBe('2026-11-23T10:00:00+07:00');
  });
});

describe('blok periode', () => {
  it('menghitung awal blok dari titik jangkar', () => {
    expect(periodStartFor('2026-11-12', '2026-11-01', 5)).toBe('2026-11-11');
    expect(periodStartFor('2026-11-01', '2026-11-01', 5)).toBe('2026-11-01');
    expect(periodStartFor('2026-10-30', '2026-11-01', 5)).toBe('2026-10-27');
  });
});

describe('pemahaman bahasa Indonesia', () => {
  it('membaca nominal sehari-hari', () => {
    expect(parseRupiah('30 ribu')).toBe(30_000);
    expect(parseRupiah('1,5jt')).toBe(1_500_000);
    expect(parseRupiah('25rb')).toBe(25_000);
    expect(parseRupiah('Rp350.000')).toBe(350_000);
  });

  it('membaca jumlah orang', () => {
    expect(parseJumlahOrang('makan berempat')).toBe(4);
    expect(parseJumlahOrang('3 teman')).toBe(4);
  });

  it('"itu makan berempat, aku cuma bayar 30 ribu"', () => {
    const n = detectIntent('itu makan berempat, aku cuma bayar 30 ribu');
    expect(n.intent).toBe('bagi_biaya');
    expect(n.bagian_saya_minor).toBe(30_000);
    expect(n.jumlah_orang).toBe(4);
  });

  it('"server ini direimburse company"', () => {
    expect(detectIntent('server ini direimburse company').intent).toBe('set_reimburse');
  });

  it('"transfer 500 ribu ke BCA aku"', () => {
    const n = detectIntent('transfer 500 ribu ke rekening aku sendiri');
    expect(n.intent).toBe('transfer_sendiri');
  });

  it('"kalau aku beli hp 3 juta hari ini gimana?"', () => {
    const n = detectIntent('kalau aku beli hp 3 juta hari ini gimana?');
    expect(n.intent).toBe('simulasi');
    expect(n.nominal_minor).toBe(3_000_000);
  });

  it('"top up hari ini tidak masuk"', () => {
    expect(detectIntent('top up hari ini tidak masuk').intent).toBe('topup_tidak_diterima');
  });

  it('"makan 25 ribu" menjadi pengeluaran dengan kategori makan', () => {
    const n = detectIntent('makan 25 ribu');
    expect(n.intent).toBe('catat_pengeluaran');
    expect(n.nominal_minor).toBe(25_000);
    expect(n.kategori_tebakan).toBe('makan');
  });
});

describe('keamanan', () => {
  it('token terenkripsi bolak-balik', () => {
    const asal = { refresh_token: 'rahasia-sekali', expiry_date: 123 };
    const terenkripsi = encryptJson(asal);
    expect(terenkripsi).not.toContain('rahasia');
    expect(decryptJson(terenkripsi)).toEqual(asal);
  });

  it('redaksi menyembunyikan nomor panjang dan email', () => {
    const hasil = redact('rekening 1234567890123 milik orang@contoh.com');
    expect(hasil).not.toContain('1234567890123');
    expect(hasil).toContain('0123');
    expect(hasil).not.toContain('orang@contoh.com');
  });
});

describe('antrean keputusan', () => {
  let database: DB;
  beforeEach(() => {
    database = dbUji();
  });

  it('pertanyaan yang sama tidak dibuat dua kali', () => {
    const a = createDecision(
      { kind: 'kategori_transaksi', question: 'Benar?', dedupe_key: 'x1', options: [] },
      database,
    );
    const b = createDecision(
      { kind: 'kategori_transaksi', question: 'Benar?', dedupe_key: 'x1', options: [] },
      database,
    );
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(countOpenDecisions(database)).toBe(1);
  });

  it('pertanyaan yang sudah dijawab tidak lagi terbuka', () => {
    const id = createDecision(
      { kind: 'kategori_transaksi', question: 'Benar?', dedupe_key: 'x2', options: [] },
      database,
    )!;
    answerDecision(id, { optionId: 'benar' }, 'uji', database);
    expect(countOpenDecisions(database)).toBe(0);
    expect(listDecisions({ state: 'dijawab' }, database)).toHaveLength(1);
  });
});

describe('rekening', () => {
  it('seed membuat rekening Mandiri dan BCA yang belum terverifikasi', () => {
    const database = dbUji();
    expect(akun(database, 'Mandiri')).toBeGreaterThan(0);
    const bca = database.prepare(`SELECT verified, is_savings_target FROM account WHERE name = 'BCA'`).get() as {
      verified: number;
      is_savings_target: number;
    };
    expect(bca.verified).toBe(0);
    expect(bca.is_savings_target).toBe(1);
  });
});
