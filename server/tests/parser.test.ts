import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, jumlahTransaksi } from './bantu.js';
import { parseMessage } from '../src/gmail/parsers/index.js';
import { detectDocKind, findVendor } from '../src/gmail/parsers/vendors.js';
import { isPromotional } from '../src/gmail/classify.js';
import { ingestMessage } from '../src/gmail/ingest.js';
import { parseAmount } from '../src/domain/money.js';
import { parseDateLoose } from '../src/gmail/parsers/helpers.js';
import type { MailMessage } from '../src/gmail/types.js';

function surat(p: Partial<MailMessage> & { from: string; subject: string; text: string }): MailMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    date: '2026-10-21T14:05:00+07:00',
    headers: {},
    labelIds: [],
    ...p,
  };
}

let database: DB;
beforeEach(() => {
  database = dbUji();
  database.prepare(`UPDATE account SET last4 = '4821', verified = 1 WHERE name LIKE '%Mandiri%'`).run();
  database.prepare(`UPDATE account SET last4 = '7733', verified = 1 WHERE name LIKE '%BCA%'`).run();
});

describe('pembacaan nominal dan tanggal', () => {
  it('membaca format rupiah Indonesia', () => {
    expect(parseAmount('Rp349.000')?.minor).toBe(349_000);
    expect(parseAmount('Rp 198.690,00')?.minor).toBe(198_690);
    expect(parseAmount('IDR 410,700')?.minor).toBe(410_700);
  });

  it('membaca nominal mata uang asing sebagai sen', () => {
    const usd = parseAmount('USD 20.00');
    expect(usd?.currency).toBe('USD');
    expect(usd?.minor).toBe(2000);
  });

  it('mengembalikan null bila tidak ada angka', () => {
    expect(parseAmount('tidak ada nominal')).toBeNull();
  });

  it('membaca tanggal Indonesia dan ISO', () => {
    expect(parseDateLoose('21 Oktober 2026')).toBe('2026-10-21');
    expect(parseDateLoose('23/11/2026')).toBe('2026-11-23');
    expect(parseDateLoose('2026-11-23')).toBe('2026-11-23');
    expect(parseDateLoose('November 23, 2026')).toBe('2026-11-23');
  });
});

describe('penyaringan email promosi', () => {
  it('email promosi tidak menjadi transaksi', () => {
    const msg = surat({
      from: 'promo@bankmandiri.co.id',
      subject: 'Promo diskon 50% khusus untukmu!',
      text: 'Jangan lewatkan penawaran ini. Diskon hingga Rp500.000. Daftar sekarang.',
      headers: { 'list-unsubscribe': '<mailto:unsub@x>' },
      labelIds: ['CATEGORY_PROMOTIONS'],
    });
    expect(isPromotional(msg).promo).toBe(true);
    const hasil = parseMessage(msg);
    expect(hasil?.items.length ?? 0).toBe(0);

    ingestMessage(msg, database);
    expect(jumlahTransaksi(database)).toBe(0);
  });

  it('kuitansi asli dengan header berlangganan tetap diproses', () => {
    const msg = surat({
      from: 'billing@biznetgio.com',
      subject: 'Payment receipt — Invoice INV-2026-10-55',
      text: [
        'Thank you for your payment.',
        'Invoice Number: INV-2026-10-55',
        'Total: Rp198.690',
        'Tanggal: 21 Oktober 2026',
      ].join('\n'),
      headers: { 'list-unsubscribe': '<mailto:unsub@biznetgio.com>' },
    });
    expect(isPromotional(msg).promo).toBe(false);
    expect(detectDocKind(msg)).toBe('kuitansi');
  });
});

describe('parser notifikasi bank Mandiri', () => {
  it('membaca nominal, arah, merchant, dan nomor referensi', () => {
    const msg = surat({
      from: 'noreply@bankmandiri.co.id',
      subject: 'Transaksi Berhasil',
      text: [
        'Transfer berhasil',
        'Tanggal: 21 Oktober 2026 14:05',
        'Nominal: Rp198.690',
        'Rekening Sumber: ****4821',
        'Penerima: Biznet Gio',
        'No. Referensi: 998877665544',
      ].join('\n'),
    });
    const hasil = parseMessage(msg);
    expect(hasil?.parser).toBe('mandiri-livin');
    const tx = hasil!.items[0] as { tipe: string; amount_minor: number; direction: string; reference_no: string };
    expect(tx.tipe).toBe('transaksi');
    expect(tx.amount_minor).toBe(198_690);
    expect(tx.direction).toBe('keluar');
    expect(tx.reference_no).toBe('998877665544');
  });

  it('transfer ke rekening BCA milikku dicatat sebagai setoran tabungan', () => {
    const msg = surat({
      from: 'noreply@bankmandiri.co.id',
      subject: 'Transfer Berhasil',
      text: [
        'Transfer berhasil',
        'Tanggal: 12 November 2026 10:00',
        'Nominal: Rp500.000',
        'Rekening Sumber: ****4821',
        'Bank Tujuan: BCA',
        'Rekening Tujuan: ****7733',
        'No. Referensi: TF20261112001',
      ].join('\n'),
    });
    ingestMessage(msg, database);
    const ev = database.prepare(`SELECT kind, amount_minor FROM cash_event ORDER BY id DESC LIMIT 1`).get() as {
      kind: string;
      amount_minor: number;
    };
    expect(ev.kind).toBe('setoran_tabungan');
    expect(ev.amount_minor).toBe(500_000);
  });

  it('transfer ke rekening BCA orang lain tidak menjadi transfer internal', () => {
    const msg = surat({
      from: 'noreply@bankmandiri.co.id',
      subject: 'Transfer Berhasil',
      text: [
        'Transfer berhasil',
        'Tanggal: 12 November 2026 10:00',
        'Nominal: Rp250.000',
        'Rekening Sumber: ****4821',
        'Bank Tujuan: BCA',
        'Rekening Tujuan: ****1199',
        'Penerima: Bu Ani',
        'No. Referensi: TF20261112002',
      ].join('\n'),
    });
    ingestMessage(msg, database);
    const ev = database.prepare(`SELECT kind FROM cash_event ORDER BY id DESC LIMIT 1`).get() as { kind: string };
    expect(ev.kind).not.toBe('setoran_tabungan');
    expect(ev.kind).not.toBe('transfer_internal');
  });
});

describe('parser vendor', () => {
  it('invoice tidak dianggap sudah dibayar', () => {
    const msg = surat({
      from: 'billing@idcloudhost.com',
      subject: 'Invoice #INV-11-2026 — IDCloudHost',
      text: [
        'Invoice Number: INV-11-2026',
        'Amount due: Rp410.700',
        'Due Date: 23 November 2026',
        'Periode: 23 November 2026 - 22 Desember 2026',
      ].join('\n'),
    });
    const hasil = parseMessage(msg);
    const inv = hasil!.items.find((i) => i.tipe === 'invoice') as {
      status: string;
      amount_minor: number;
      due_date: string;
    };
    expect(inv.status).toBe('tagihan_baru');
    expect(inv.amount_minor).toBe(410_700);
    expect(inv.due_date).toBe('2026-11-23');
  });

  it('gagal bayar menghasilkan status gagal_bayar', () => {
    const msg = surat({
      from: 'billing@openai.com',
      subject: 'Your payment failed',
      text: 'We could not process your payment of USD 20.00 for ChatGPT Plus. Please update your card.',
      date: '2026-09-17T09:00:00+07:00',
    });
    const hasil = parseMessage(msg);
    const st = hasil!.items.find((i) => i.tipe === 'status_tagihan') as { status: string };
    expect(st.status).toBe('gagal_bayar');
  });

  it('pemberitahuan perpanjangan bukan kuitansi', () => {
    const msg = surat({
      from: 'billing@anthropic.com',
      subject: 'Your subscription will renew soon',
      text: 'Your Claude Pro subscription will automatically renew on 27 November 2026 for USD 20.00.',
    });
    expect(detectDocKind(msg)).toBe('perpanjangan');
  });

  it('vendor yang belum dikenal menjadi kandidat berkepastian rendah', () => {
    const msg = surat({
      from: 'billing@layanan-ai-baru.io',
      subject: 'Invoice for your subscription',
      text: 'Invoice Number: X-1\nAmount due: Rp120.000\nDue Date: 1 Desember 2026\nTotal: Rp120.000',
    });
    expect(findVendor(msg)).toBeNull();
    const hasil = parseMessage(msg);
    expect(hasil?.parser).toBe('invoice-umum');
    expect(hasil!.confidence).toBeLessThan(0.5);
    const inv = hasil!.items[0] as { status: string };
    expect(inv.status).toBe('perlu_verifikasi');
  });

  it('tagihan Anthropic tidak otomatis dipetakan ke satu layanan karena ada versi pribadi dan company', () => {
    const msg = surat({
      from: 'billing@anthropic.com',
      subject: 'Your receipt from Anthropic',
      text: 'Payment received. Amount paid: USD 20.00. Invoice Number: ANT-99',
    });
    const hasil = parseMessage(msg);
    const inv = hasil!.items.find((i) => i.tipe === 'invoice') as { service_slug: string | null };
    expect(inv.service_slug).toBeNull();
    expect(hasil!.catatan?.join(' ')).toContain('pribadi atau company');
  });
});

describe('idempotensi pemrosesan email', () => {
  it('memproses ulang email yang sama tidak membuat transaksi baru', () => {
    const msg = surat({
      from: 'noreply@bankmandiri.co.id',
      subject: 'Transaksi Berhasil',
      text: 'Transfer berhasil\nNominal: Rp75.000\nRekening Sumber: ****4821\nPenerima: Toko Buku\nNo. Referensi: ABC123456',
    });
    const a = ingestMessage(msg, database);
    const b = ingestMessage(msg, database);
    expect(a.transaksi_dibuat).toBe(1);
    expect(b.evidence_baru).toBe(false);
    expect(b.transaksi_dibuat).toBe(0);
    expect(jumlahTransaksi(database)).toBe(1);
  });

  it('kuitansi tanpa notifikasi bank dicatat tanpa rekening dan meminta konfirmasi', () => {
    const msg = surat({
      from: 'billing@biznetgio.com',
      subject: 'Payment receipt',
      text: 'Thank you for your payment.\nTotal: Rp198.690\nInvoice Number: INV-77\nTanggal: 21 Oktober 2026',
    });
    ingestMessage(msg, database);
    const ev = database
      .prepare(`SELECT account_id, status FROM cash_event ORDER BY id DESC LIMIT 1`)
      .get() as { account_id: number | null; status: string };
    expect(ev.account_id).toBeNull();
    expect(ev.status).toBe('perlu_verifikasi');

    const keputusan = database
      .prepare(`SELECT COUNT(*) AS n FROM pending_decision WHERE kind = 'konfirmasi_kuitansi'`)
      .get() as { n: number };
    expect(keputusan.n).toBeGreaterThan(0);
  });

  it('notifikasi bank yang datang kemudian melengkapi pembayaran dari kuitansi, bukan membuat transaksi baru', () => {
    const kuitansi = surat({
      from: 'billing@biznetgio.com',
      subject: 'Payment receipt',
      text: 'Thank you for your payment.\nTotal: Rp198.690\nInvoice Number: INV-78\nTanggal: 21 Oktober 2026',
    });
    ingestMessage(kuitansi, database);
    expect(jumlahTransaksi(database)).toBe(1);

    const notif = surat({
      from: 'noreply@bankmandiri.co.id',
      subject: 'Transaksi Berhasil',
      text: [
        'Pembayaran berhasil',
        'Tanggal: 21 Oktober 2026 14:05',
        'Nominal: Rp198.690',
        'Rekening Sumber: ****4821',
        'Penerima: Biznet Gio',
        'No. Referensi: BZ998877',
      ].join('\n'),
    });
    ingestMessage(notif, database);

    expect(jumlahTransaksi(database)).toBe(1);
    const ev = database
      .prepare(`SELECT account_id, status, amount_minor FROM cash_event ORDER BY id LIMIT 1`)
      .get() as { account_id: number | null; status: string; amount_minor: number };
    expect(ev.account_id).toBe(akun(database, 'Mandiri'));
    expect(ev.status).toBe('terkonfirmasi');
    expect(ev.amount_minor).toBe(198_690);
  });
});
