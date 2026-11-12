import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, jumlahTransaksi } from './bantu.js';
import { importSheetTab, inspectSheetCsv } from '../src/importer/sheet.js';
import { importBankCsv, inspectBankCsv, pdfTextToCsv } from '../src/importer/bank.js';
import { accountBalance } from '../src/domain/balances.js';
import { parseCsv, detectDelimiter } from '../src/importer/csv.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
});

const CSV_LANGGANAN = `Layanan;Nominal;Siklus;Tanggal;Penanggung;Status;Catatan
ChatGPT Plus;Rp349.000;Bulanan;17;Pribadi;Aktif;perkiraan
Notion AI;Rp120.000;Bulanan;2026-12-01;Pribadi;Aktif;
Figma;belum tahu;Bulanan;2026-12-05;Company;Perlu verifikasi;nominal belum pasti
`;

const CSV_TOPUP = `Tanggal;Rencana;Aktual;Status;Sumber
2026-11-01;Rp350.000;Rp350.000;;Orang tua
2026-11-06;Rp350.000;;;Orang tua
2026-11-11;Rp350.000;;Tidak diterima;Orang tua
`;

const CSV_BELANJA = `Barang;Jumlah;Harga satuan;Total;Tanggal;Penanggung;Status
Keyboard;1;Rp350.000;Rp350.000;2026-11-20;Saya;Belum dibayar
Monitor bekas;1;belum tahu;;2026-11-25;Saya;Belum dibayar
`;

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

describe('impor tab LANGGANAN', () => {
  it('mengusulkan pemetaan kolom dari judul berbahasa Indonesia', () => {
    const hasil = inspectSheetCsv('LANGGANAN', CSV_LANGGANAN);
    expect(hasil.pemetaan_usulan['name']).toBe(0);
    expect(hasil.pemetaan_usulan['amount']).toBe(1);
    expect(hasil.pemetaan_usulan['due_date']).toBe(3);
    expect(hasil.jumlah_baris).toBe(3);
  });

  it('nominal yang tidak terbaca dibiarkan kosong, bukan nol', () => {
    importSheetTab({ tab: 'LANGGANAN', csv: CSV_LANGGANAN }, database);
    const figma = database.prepare(`SELECT amount_minor FROM service WHERE name = 'Figma'`).get() as {
      amount_minor: number | null;
    };
    expect(figma.amount_minor).toBeNull();
  });

  it('tanggal yang hanya berupa hari dalam bulan dilaporkan sebagai tidak jelas', () => {
    const hasil = importSheetTab({ tab: 'LANGGANAN', csv: CSV_LANGGANAN }, database);
    expect(hasil.tidak_jelas.some((t) => t.alasan.includes('hari dalam bulan'))).toBe(true);
  });

  it('impor ulang memperbarui, tidak menduplikasi', () => {
    importSheetTab({ tab: 'LANGGANAN', csv: CSV_LANGGANAN }, database);
    const jumlah1 = (database.prepare(`SELECT COUNT(*) AS n FROM service`).get() as { n: number }).n;
    const hasil2 = importSheetTab({ tab: 'LANGGANAN', csv: CSV_LANGGANAN }, database);
    const jumlah2 = (database.prepare(`SELECT COUNT(*) AS n FROM service`).get() as { n: number }).n;
    expect(jumlah2).toBe(jumlah1);
    expect(hasil2.diperbarui).toBeGreaterThan(0);
    expect(hasil2.dibuat).toBe(0);
  });

  it('tidak menimpa nominal yang sudah terverifikasi dengan asumsi Sheet', () => {
    importSheetTab({ tab: 'LANGGANAN', csv: CSV_LANGGANAN }, database);
    database
      .prepare(`UPDATE service SET amount_minor = 400000, amount_certainty = 'terverifikasi' WHERE name = 'Notion AI'`)
      .run();
    importSheetTab({ tab: 'LANGGANAN', csv: CSV_LANGGANAN }, database);
    const notion = database.prepare(`SELECT amount_minor FROM service WHERE name = 'Notion AI'`).get() as {
      amount_minor: number;
    };
    expect(notion.amount_minor).toBe(400_000);
  });

  it('uji coba tidak menyimpan apa pun', () => {
    const sebelum = (database.prepare(`SELECT COUNT(*) AS n FROM service`).get() as { n: number }).n;
    importSheetTab({ tab: 'LANGGANAN', csv: CSV_LANGGANAN, dryRun: true }, database);
    const sesudah = (database.prepare(`SELECT COUNT(*) AS n FROM service`).get() as { n: number }).n;
    expect(sesudah).toBe(sebelum);
  });
});

describe('impor tab TOPUP', () => {
  it('angka aktual di Sheet tidak otomatis menjadi pemasukan yang terbukti', () => {
    const hasil = importSheetTab({ tab: 'TOPUP', csv: CSV_TOPUP }, database);
    expect(jumlahTransaksi(database)).toBe(0);
    const baris = database.prepare(`SELECT status FROM topup_plan WHERE plan_date = '2026-11-01'`).get() as {
      status: string;
    };
    expect(baris.status).toBe('rencana');
    expect(hasil.tidak_jelas.some((t) => t.alasan.includes('belum ada bukti masuk'))).toBe(true);
  });

  it('status "tidak diterima" dari Sheet dihormati', () => {
    importSheetTab({ tab: 'TOPUP', csv: CSV_TOPUP }, database);
    const baris = database.prepare(`SELECT status FROM topup_plan WHERE plan_date = '2026-11-11'`).get() as {
      status: string;
    };
    expect(baris.status).toBe('tidak_diterima');
  });
});

describe('impor tab BELANJA', () => {
  it('barang tanpa harga ditandai, bukan dianggap gratis', () => {
    const hasil = importSheetTab({ tab: 'BELANJA', csv: CSV_BELANJA }, database);
    const monitor = database.prepare(`SELECT total_minor, price_unknown FROM purchase WHERE name = 'Monitor bekas'`).get() as {
      total_minor: number | null;
      price_unknown: number;
    };
    expect(monitor.total_minor).toBeNull();
    expect(monitor.price_unknown).toBe(1);
    expect(hasil.tidak_jelas.some((t) => t.alasan.includes('belum diketahui'))).toBe(true);
  });
});

describe('tab hasil rumus tidak menjadi transaksi', () => {
  it('ARUS HARIAN hanya dipakai sebagai pembanding', () => {
    const csv = `Tanggal;Saldo awal;Pemasukan;Rutin;Belanja;Tagihan;Saldo akhir;Status
2026-11-01;200000;350000;30000;0;0;520000;AMAN
`;
    const hasil = importSheetTab({ tab: 'ARUS_HARIAN', csv }, database);
    expect(jumlahTransaksi(database)).toBe(0);
    expect(hasil.catatan.join(' ')).toContain('pembanding');
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
