import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, jumlahTransaksi, pasangSaldo } from './bantu.js';
import { seed } from '../src/db/seed.js';
import { ingestMessage } from '../src/gmail/ingest.js';
import { recordCashEvent } from '../src/domain/ledger.js';
import { accountBalance, balanceSummary } from '../src/domain/balances.js';
import { project } from '../src/domain/projection.js';
import { buatTransaksi } from '../src/domain/manualTx.js';
import {
  cariBayarGanda, gabungkanBayarGanda, pembersihan, pembersihanSekali, pembersihanSudahJalan,
} from '../src/domain/kemandirian.js';
import { addDays, today } from '../src/domain/time.js';
import type { MailMessage } from '../src/gmail/types.js';

function surat(p: Partial<MailMessage> & { from: string; subject: string; text: string }): MailMessage {
  return { id: `m-${Math.random().toString(36).slice(2)}`, date: '2026-11-10T09:00:00+07:00', headers: {}, labelIds: [], ...p };
}

const hitung = (d: DB, sql: string) => (d.prepare(sql).get() as { n: number }).n;

let database: DB;
beforeEach(() => {
  database = dbUji(); // dbUji memakai profil 'warisan' = database yang masih berisi data Sheet lama
});

describe('berdiri sendiri tanpa Sheet', () => {
  it('database lama berisi data Sheet; pembersihan melepaskannya tanpa menyentuh transaksi nyata', () => {
    expect(hitung(database, `SELECT COUNT(*) AS n FROM assumption WHERE source = 'sheet'`)).toBeGreaterThan(0);
    expect(hitung(database, `SELECT COUNT(*) AS n FROM invoice WHERE dedupe_key LIKE 'seed:%'`)).toBeGreaterThan(0);

    const nyata = buatTransaksi({ jenis: 'pengeluaran', jumlah_minor: 25_000, merchant: 'Warung', rekening_id: akun(database, 'Mandiri') }, 'uji', database);
    pasangSaldo(database, 'Mandiri', 1_000_000);

    const lap = pembersihan(database, { direktoriCadangan: null });
    expect(lap.asumsi_sheet).toBeGreaterThan(0);

    expect(hitung(database, `SELECT COUNT(*) AS n FROM assumption WHERE source = 'sheet'`)).toBe(0);
    expect(hitung(database, `SELECT COUNT(*) AS n FROM invoice WHERE dedupe_key LIKE 'seed:%'`)).toBe(0);
    expect(hitung(database, `SELECT COUNT(*) AS n FROM service`)).toBe(0);
    expect(hitung(database, `SELECT COUNT(*) AS n FROM import_run WHERE source = 'sheet'`)).toBe(0);

    // Transaksi, rekening, saldo, dan kategori utuh.
    expect(jumlahTransaksi(database)).toBe(1);
    expect(database.prepare(`SELECT status FROM cash_event WHERE id = ?`).get(nyata.id)).toEqual({ status: 'terkonfirmasi' });
    expect(hitung(database, `SELECT COUNT(*) AS n FROM reconciliation`)).toBe(1);
    expect(hitung(database, `SELECT COUNT(*) AS n FROM category`)).toBeGreaterThan(5);
  });

  it('layanan yang punya transaksi nyata tidak dihapus', () => {
    const svc = database.prepare(`SELECT id FROM service WHERE slug = 'idcloudhost-vps-company'`).get() as { id: number };
    recordCashEvent(
      { occurred_at: `${today()}T10:00:00+07:00`, direction: 'keluar', amount_minor: 410_700, account_id: akun(database, 'Mandiri'), kind: 'bayar_langganan', service_id: svc.id, merchant_raw: 'IDCloudHost', source: 'manual' },
      database,
    );
    pembersihan(database, { direktoriCadangan: null });
    expect(database.prepare(`SELECT 1 FROM service WHERE id = ?`).get(svc.id)).toBeTruthy();
    expect(hitung(database, `SELECT COUNT(*) AS n FROM service`)).toBe(1);
  });

  it('seed tidak menghidupkan lagi data Sheet pada database lama', () => {
    pembersihan(database, { direktoriCadangan: null });
    seed(database); // profil otomatis, seperti saat aplikasi dinyalakan
    expect(hitung(database, `SELECT COUNT(*) AS n FROM assumption`)).toBe(0);
    expect(hitung(database, `SELECT COUNT(*) AS n FROM service`)).toBe(0);
  });

  it('proyeksi tidak pernah memakai saldo awal dari Sheet, bahkan bila asumsinya masih ada', () => {
    expect(database.prepare(`SELECT 1 FROM assumption WHERE key = 'saldo_awal_sheet'`).get()).toBeTruthy();
    const p = project({ dari: today(), sampai: addDays(today(), 10) }, database);
    expect(p.dasar_saldo.minor).toBe(0);
    expect(p.dasar_saldo.sumber).not.toMatch(/Sheet/);
  });

  it('berjalan sekali saja dan aman diulang', () => {
    expect(pembersihanSudahJalan(database)).toBe(false);
    expect(pembersihanSekali(database)).not.toBeNull();
    expect(pembersihanSudahJalan(database)).toBe(true);
    expect(pembersihanSekali(database)).toBeNull();
  });

  it('uji kering tidak mengubah apa pun', () => {
    const asumsi = hitung(database, `SELECT COUNT(*) AS n FROM assumption`);
    const lap = pembersihan(database, { kering: true });
    expect(lap.kering).toBe(true);
    expect(lap.asumsi_sheet).toBe(asumsi);
    expect(hitung(database, `SELECT COUNT(*) AS n FROM assumption`)).toBe(asumsi);
    expect(pembersihanSudahJalan(database)).toBe(false);
  });
});

describe('satu pembayaran, satu pengeluaran', () => {
  const idcloud = (p: { subject: string; text: string; date: string }) =>
    surat({ from: 'billing@idcloudhost.com', ...p });

  it('invoice, kuitansi, dan ucapan terima kasih IDCloudHost menjadi SATU pembayaran', () => {
    // Tiga email berbeda untuk pembayaran yang sama, tanpa nomor invoice yang konsisten.
    ingestMessage(idcloud({ subject: 'Invoice IDCloudHost', date: '2026-11-16T08:00:00+07:00', text: 'Amount due: Rp410.700\nDue Date: 23 November 2026' }), database);
    ingestMessage(idcloud({ subject: 'Payment receipt IDCloudHost', date: '2026-11-18T09:00:00+07:00', text: 'Your receipt\nTotal: Rp410.700\nInvoice Date: 18 November 2026\nPayment received' }), database);
    ingestMessage(idcloud({ subject: 'Thank you for your payment', date: '2026-11-19T10:00:00+07:00', text: 'Thanks for your payment.\nAmount paid: Rp410.700\nInvoice Date: 19 November 2026\nInvoice paid' }), database);
    ingestMessage(idcloud({ subject: 'Invoice paid', date: '2026-11-21T10:00:00+07:00', text: 'Invoice paid in full.\nTotal: Rp410.700\nInvoice Date: 21 November 2026' }), database);

    const bayar = database
      .prepare(`SELECT id FROM cash_event WHERE direction = 'keluar' AND status <> 'dibatalkan' AND amount_minor = 410700`)
      .all();
    expect(bayar).toHaveLength(1);
  });

  it('notifikasi bank yang datang belakangan melengkapi pembayaran yang sama', () => {
    ingestMessage(idcloud({ subject: 'Payment receipt IDCloudHost', date: '2026-11-18T09:00:00+07:00', text: 'Your receipt\nTotal: Rp410.700\nInvoice Date: 18 November 2026\nPayment received' }), database);
    ingestMessage(idcloud({ subject: 'Thank you for your payment', date: '2026-11-19T10:00:00+07:00', text: 'Thanks for your payment.\nAmount paid: Rp410.700\nInvoice Date: 19 November 2026' }), database);
    database.prepare(`UPDATE account SET last4 = '4821', verified = 1 WHERE name LIKE '%Mandiri%'`).run();
    ingestMessage(
      surat({
        from: 'notifikasi@bankmandiri.co.id',
        subject: 'Transaksi Berhasil',
        date: '2026-11-19T11:00:00+07:00',
        text: ['Pembayaran berhasil', 'Tanggal: 19 November 2026 11:00', 'Nominal: Rp410.700', 'Merchant: IDCLOUDHOST', 'Rekening Sumber: ****4821', 'No. Referensi: PAY20261119001'].join('\n'),
      }),
      database,
    );
    const bayar = database
      .prepare(`SELECT account_id FROM cash_event WHERE direction = 'keluar' AND status <> 'dibatalkan' AND amount_minor = 410700`)
      .all() as Array<{ account_id: number | null }>;
    expect(bayar).toHaveLength(1);
    expect(bayar[0]!.account_id).not.toBeNull();
  });

  it('data yang sudah terlanjur ganda digabung, dengan bukti dipindahkan', () => {
    const svc = database.prepare(`SELECT id FROM service WHERE slug = 'idcloudhost-vps-company'`).get() as { id: number };
    const ids: number[] = [];
    for (const [hari, ref] of [['2026-11-16', null], ['2026-11-18', null], ['2026-11-21', null]] as const) {
      const r = recordCashEvent(
        { occurred_at: `${hari}T10:00:00+07:00`, direction: 'keluar', amount_minor: 410_700, account_id: null, kind: 'bayar_langganan', service_id: svc.id, merchant_raw: `IDCloudHost ${hari}`, reference_no: ref, status: 'perlu_verifikasi', source: 'gmail' },
        database,
      );
      ids.push(r.id);
    }
    expect(cariBayarGanda(database)).toHaveLength(1);
    const lap = gabungkanBayarGanda(database);
    expect(lap).toHaveLength(1);
    expect(lap[0]!.dibatalkan).toHaveLength(2);
    const sisa = database.prepare(`SELECT id FROM cash_event WHERE status <> 'dibatalkan' AND service_id = ?`).all(svc.id);
    expect(sisa).toHaveLength(1);
    // Idempoten.
    expect(gabungkanBayarGanda(database)).toHaveLength(0);
  });

  it('dua pembayaran bernomor referensi bank berbeda tidak pernah digabung', () => {
    const svc = database.prepare(`SELECT id FROM service WHERE slug = 'idcloudhost-vps-company'`).get() as { id: number };
    for (const ref of ['REF-AAA-1', 'REF-BBB-2']) {
      recordCashEvent(
        { occurred_at: '2026-11-18T10:00:00+07:00', direction: 'keluar', amount_minor: 410_700, account_id: akun(database, 'Mandiri'), kind: 'bayar_langganan', service_id: svc.id, merchant_raw: 'IDCloudHost', reference_no: ref, source: 'gmail' },
        database,
      );
    }
    expect(cariBayarGanda(database)).toHaveLength(0);
  });

  it('pembelian bulan berikutnya (di luar 7 hari) tetap pembayaran terpisah', () => {
    const svc = database.prepare(`SELECT id FROM service WHERE slug = 'idcloudhost-vps-company'`).get() as { id: number };
    for (const hari of ['2026-10-23', '2026-11-23']) {
      recordCashEvent(
        { occurred_at: `${hari}T10:00:00+07:00`, direction: 'keluar', amount_minor: 410_700, account_id: akun(database, 'Mandiri'), kind: 'bayar_langganan', service_id: svc.id, merchant_raw: `IDCloudHost ${hari}`, source: 'gmail' },
        database,
      );
    }
    expect(cariBayarGanda(database)).toHaveLength(0);
  });

  it('transaksi buatanmu sendiri tidak pernah digabung otomatis', () => {
    const svc = database.prepare(`SELECT id FROM service WHERE slug = 'idcloudhost-vps-company'`).get() as { id: number };
    for (let i = 0; i < 2; i++) {
      recordCashEvent(
        { occurred_at: `2026-11-1${i}T10:00:00+07:00`, direction: 'keluar', amount_minor: 410_700, account_id: akun(database, 'Mandiri'), kind: 'bayar_langganan', service_id: svc.id, merchant_raw: 'IDCloudHost', source: 'manual' },
        database,
      );
    }
    expect(cariBayarGanda(database)).toHaveLength(0);
  });
});

describe('saldo negatif karena pemasukan tidak tercatat', () => {
  it('ditandai tidak wajar dan dijelaskan, bukan disajikan seperti fakta', () => {
    pasangSaldo(database, 'Mandiri', 100_000, -3);
    const mandiri = akun(database, 'Mandiri');
    recordCashEvent(
      { occurred_at: `${addDays(today(), -1)}T10:00:00+07:00`, direction: 'keluar', amount_minor: 600_000, account_id: mandiri, kind: 'pengeluaran_pribadi', merchant_raw: 'Toko', source: 'manual' },
      database,
    );
    const bal = accountBalance(mandiri, undefined, database);
    expect(bal.balance_minor).toBe(-500_000);
    expect(bal.tidak_wajar).toBe(true);
    expect(bal.catatan.join(' ')).toMatch(/uang masuk yang belum tercatat/);
    expect(balanceSummary(undefined, database).ada_saldo_tidak_wajar).toBe(true);
  });

  it('mencatat pemasukan menghilangkan tanda tidak wajar', () => {
    pasangSaldo(database, 'Mandiri', 100_000, -3);
    const mandiri = akun(database, 'Mandiri');
    recordCashEvent(
      { occurred_at: `${addDays(today(), -1)}T10:00:00+07:00`, direction: 'keluar', amount_minor: 600_000, account_id: mandiri, kind: 'pengeluaran_pribadi', merchant_raw: 'Toko', source: 'manual' },
      database,
    );
    buatTransaksi({ jenis: 'pemasukan', jumlah_minor: 1_000_000, rekening_id: mandiri, merchant: 'Gaji' }, 'uji', database);
    const bal = accountBalance(mandiri, undefined, database);
    expect(bal.balance_minor).toBe(500_000);
    expect(bal.tidak_wajar).toBe(false);
  });
});
