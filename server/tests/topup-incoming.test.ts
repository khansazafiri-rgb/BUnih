import { beforeEach, describe, expect, it } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, jumlahTransaksi } from './bantu.js';
import { parseMessage } from '../src/gmail/parsers/index.js';
import { ingestMessage } from '../src/gmail/ingest.js';
import type { MailMessage } from '../src/gmail/types.js';
import { ruteCommand } from '../src/telegram/ui/router.js';
import { tanganiCatat } from '../src/telegram/ui/catatUi.js';
import { terapkanJenis, jenisUntukArah } from '../src/domain/jenisTransaksi.js';
import { getCashEvent } from '../src/domain/ledger.js';
import { today } from '../src/domain/time.js';

let database: DB;
const ctx = { chatId: '6682914793' };
let id = 0;
function surat(bank: 'mandiri' | 'bca', text: string, subject = 'Notifikasi Transaksi'): MailMessage {
  return {
    id: 'incoming-fixture-' + ++id,
    from: bank === 'mandiri' ? 'noreply@bankmandiri.co.id' : 'noreply@bca.co.id',
    subject,
    date: today() + 'T10:00:00+07:00',
    text,
    headers: {},
  };
}
function incomingMandiri(nominal: number, no = 'INCOMING-REF-001'): MailMessage {
  return surat(
    'mandiri',
    [
      'Transfer berhasil — dana masuk',
      'Tanggal: ' + today() + ' 10:00',
      'Nominal: Rp' + nominal.toLocaleString('id-ID'),
      'Rekening Penerima: ****4821',
      'Pengirim: Keluarga',
      'No. Referensi: ' + no,
    ].join('\n'),
    'Transfer Berhasil',
  );
}

beforeEach(() => {
  database = dbUji();
  database.prepare(`UPDATE account SET last4 = '4821', verified = 1 WHERE name LIKE '%Mandiri%'`).run();
  database.prepare(`UPDATE account SET last4 = '7733', verified = 1 WHERE name LIKE '%BCA%'`).run();
});

describe('incoming bank transfers', () => {
  it('Mandiri: explicit dana masuk overrides generic transfer berhasil', () => {
    const mail = incomingMandiri(125_000);
    const parsed = parseMessage(mail);
    const tx = parsed?.items[0];
    expect(tx?.tipe).toBe('transaksi');
    if (tx?.tipe !== 'transaksi') return;
    expect(tx.direction).toBe('masuk');
    expect(tx.dest_bank).toBe('Mandiri');
    expect(tx.dest_account_tail).toBe('4821');
    expect(tx.source_bank).toBeNull();

    const n = jumlahTransaksi(database);
    const hasil = ingestMessage(mail, database);
    expect(hasil.transaksi_dibuat).toBe(1);
    expect(jumlahTransaksi(database)).toBe(n + 1);
    const ev = database.prepare(`SELECT direction, kind, account_id FROM cash_event ORDER BY id DESC LIMIT 1`).get() as {
      direction: string; kind: string; account_id: number | null;
    };
    expect(ev.direction).toBe('masuk');
    expect(ev.kind).toBe('pemasukan_luar');
    expect(ev.account_id).toBe(akun(database, 'Mandiri'));
    expect(ingestMessage(mail, database).transaksi_dibuat).toBe(0);
  });

  it('BCA: credit notification belongs to credited account', () => {
    const mail = surat('bca', [
      'Dana masuk',
      'Tanggal: ' + today() + ' 09:15',
      'Nominal: Rp200.000',
      'Rekening: ****7733',
      'Pengirim: Keluarga',
      'No. Referensi: BCA-882221',
    ].join('\n'));
    const hasil = ingestMessage(mail, database);
    expect(hasil.transaksi_dibuat).toBe(1);
    const ev = database.prepare(`SELECT direction, kind, account_id FROM cash_event ORDER BY id DESC LIMIT 1`).get() as {
      direction: string; kind: string; account_id: number | null;
    };
    expect(ev.direction).toBe('masuk');
    expect(ev.kind).toBe('pemasukan_luar');
    expect(ev.account_id).toBe(akun(database, 'BCA'));
  });

  it('incoming transfers expose top-up button without creating extra ledger event', () => {
    const mail = incomingMandiri(345_000, 'INCOMING-REF-002');
    ingestMessage(mail, database);
    const row = database.prepare(`SELECT id FROM cash_event ORDER BY id DESC LIMIT 1`).get() as { id: number };
    const before = jumlahTransaksi(database);
    expect(jenisUntukArah('masuk').some(x => x.kode === 'topup')).toBe(true);
    expect(terapkanJenis(row.id, 'topup', 'telegram', database).pesan).toContain('Top-up');
    expect(jumlahTransaksi(database)).toBe(before);
    const ev = getCashEvent(row.id, database)!;
    expect(ev.kind).toBe('pemasukan_luar');
    const alloc = database.prepare(`SELECT purpose FROM allocation WHERE cash_event_id = ?`).all(row.id) as Array<{ purpose: string }>;
    expect(alloc).toHaveLength(1);
    expect(alloc[0]?.purpose).toBe('pemasukan');
  });
});

describe('Telegram /topup manual fallback', () => {
  it('presents a confirmation flow and creates exactly one incoming transaction', () => {
    const before = jumlahTransaksi(database);
    const awal = ruteCommand('topup', '250rb', ctx, database);
    expect(awal?.layar?.teks).toMatch(/rekening/i);
    const pilihRekening = tanganiCatat(['c', 'a', String(akun(database, 'Mandiri'))], ctx, database);
    expect(pilihRekening.layar?.teks).toMatch(/Simpan transaksi ini/i);
    const hasil = tanganiCatat(['c', 'ok'], ctx, database);
    expect(hasil.layar?.teks).toContain('Tersimpan');
    expect(jumlahTransaksi(database)).toBe(before + 1);
    const ev = database.prepare(`SELECT direction, amount_minor, kind, account_id FROM cash_event ORDER BY id DESC LIMIT 1`).get() as {
      direction: string; amount_minor: number; kind: string; account_id: number | null;
    };
    expect(ev.direction).toBe('masuk');
    expect(ev.amount_minor).toBe(250_000);
    expect(ev.kind).toBe('pemasukan_luar');
    expect(ev.account_id).toBe(akun(database, 'Mandiri'));
    // Tombol Simpan ditekan ulang setelah draft dihapus.
    tanganiCatat(['c', 'ok'], ctx, database);
    expect(jumlahTransaksi(database)).toBe(before + 1);
  });

  it('reuses incoming event that already exists, rather than creating a second', () => {
    const mail = incomingMandiri(175_000, 'INCOMING-REF-003');
    ingestMessage(mail, database);
    const ev = database.prepare(`SELECT id FROM cash_event ORDER BY id DESC LIMIT 1`).get() as { id: number };
    const before = jumlahTransaksi(database);
    ruteCommand('topup', '175rb', ctx, database);
    tanganiCatat(['c', 'a', String(akun(database, 'Mandiri'))], ctx, database);
    const warning = tanganiCatat(['c', 'ok'], ctx, database);
    expect(warning.layar?.teks).toMatch(/Sudah ada uang masuk/);
    const linked = tanganiCatat(['c', 'link', String(ev.id)], ctx, database);
    expect(linked.layar?.teks).toContain('Tidak membuat transaksi baru');
    expect(jumlahTransaksi(database)).toBe(before);
  });

  it('merges later bank credit with a uniquely matching manual top-up', () => {
    ruteCommand('topup', '235rb', ctx, database);
    tanganiCatat(['c', 'a', String(akun(database, 'Mandiri'))], ctx, database);
    tanganiCatat(['c', 'ok'], ctx, database);
    const before = jumlahTransaksi(database);
    const mail = incomingMandiri(235_000, 'INCOMING-REF-004');
    const hasil = ingestMessage(mail, database);
    expect(hasil.transaksi_dibuat).toBe(0);
    expect(hasil.transaksi_digabung).toBe(1);
    expect(jumlahTransaksi(database)).toBe(before);
    expect(ingestMessage(mail, database).transaksi_dibuat).toBe(0);
  });
});
