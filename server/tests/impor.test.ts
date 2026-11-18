import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, jumlahTransaksi } from './bantu.js';
import { importBankCsv, inspectBankCsv, pdfTextToCsv } from '../src/importer/bank.js';
import { accountBalance } from '../src/domain/balances.js';
import { parseCsv, detectDelimiter } from '../src/importer/csv.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
});

const CSV_MUTASI = `Tanggal;Keterangan;Debit;Kredit;Saldo
01/11/2026;SALDO AWAL;;;2.000.000
02/11/2026;TRSF E-BANKING DB BIZNET;198.690;;1.801.310
03/11/2026;TRANSFER MASUK;;350.000;2.151.310
04/11/2026;QRIS WARUNG;25.000;;2.126.310
`;

describe('pembacaan CSV', () => {
  it('mengenali pemisah titik koma dan koma', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('menangani tanda kutip', () => {
    const rows = parseCsv('a;b\n"isi; dengan titik koma";2');
    expect(rows[1]![0]).toBe('isi; dengan titik koma');
  });
});

describe('impor mutasi bank', () => {
  it('mengenali kolom debit, kredit, dan saldo', () => {
    const p = inspectBankCsv(CSV_MUTASI);
    expect(p.pemetaan_usulan.tanggal).toBe(0);
    expect(p.pemetaan_usulan.debit).toBe(2);
    expect(p.pemetaan_usulan.kredit).toBe(3);
    expect(p.pemetaan_usulan.saldo).toBe(4);
  });

  it('membuat transaksi dan titik tambat saldo dari baris terakhir', () => {
    const id = akun(database, 'Mandiri');
    const hasil = importBankCsv({ account_id: id, csv: CSV_MUTASI }, database);
    // Baris "SALDO AWAL" bukan mutasi, jadi hanya 3 transaksi yang dibuat.
    expect(hasil.transaksi_dibuat).toBe(3);
    expect(hasil.tidak_jelas.length).toBe(1);
    expect(hasil.rekonsiliasi?.saldo_minor).toBe(2_126_310);
    expect(accountBalance(id, '2026-11-30T00:00:00+07:00', database).balance_minor).toBe(2_126_310);
  });

  it('impor ulang mutasi yang sama tidak menduplikasi', () => {
    const id = akun(database, 'Mandiri');
    importBankCsv({ account_id: id, csv: CSV_MUTASI }, database);
    const jumlah1 = jumlahTransaksi(database);
    const hasil2 = importBankCsv({ account_id: id, csv: CSV_MUTASI }, database);
    expect(jumlahTransaksi(database)).toBe(jumlah1);
    expect(hasil2.transaksi_dibuat).toBe(0);
    expect(hasil2.transaksi_digabung).toBe(3);
  });

  it('mengubah teks PDF menjadi baris mutasi', () => {
    const teks = [
      '01/11/2026  TRSF E-BANKING DB BIZNET      198.690  DB   1.801.310',
      '03/11/2026  TRANSFER MASUK                350.000  CR   2.151.310',
      'baris lain yang bukan mutasi',
    ].join('\n');
    const csv = pdfTextToCsv(teks);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(3); // header + 2 baris
    expect(rows[1]![2]).toBe('198.690');
  });
});
