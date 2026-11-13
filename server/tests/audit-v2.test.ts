import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, kategori, jumlahTransaksi } from './bantu.js';
import { recordCashEvent, recategorize } from '../src/domain/ledger.js';
import { monthlyReport } from '../src/domain/reports.js';
import { jadikanPelunasanPiutang } from '../src/domain/applyDecision.js';
import { listReceivables } from '../src/domain/receivables.js';
import { today } from '../src/domain/time.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
});

/** Bukti temuan audit v1. Tes ini ditulis SEBELUM perbaikan dan harus gagal di kode lama. */
describe('temuan audit v1', () => {
  it('T1: mengganti kategori harus mengubah laporan bulanan', () => {
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T12:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 50_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        merchant_raw: 'Warung',
        category_id: kategori(database, 'makan'),
        reference_no: 'T1-REF-001',
        source: 'manual',
      },
      database,
    );
    recategorize(ev.id, { category_id: kategori(database, 'transport') }, 'uji', database);

    const lap = monthlyReport(today().slice(0, 7), database);
    const makan = lap.biaya_pribadi_per_kategori.find((k) => k.kategori === 'Makan')?.minor ?? 0;
    const transport = lap.biaya_pribadi_per_kategori.find((k) => k.kategori === 'Transport')?.minor ?? 0;
    expect(makan).toBe(0);
    expect(transport).toBe(50_000);
  });

  it('T2: dua pembelian manual identik di hari yang sama adalah dua transaksi', () => {
    const dasar = {
      occurred_at: `${today()}T12:00:00+07:00`,
      direction: 'keluar' as const,
      amount_minor: 25_000,
      account_id: akun(database, 'Mandiri'),
      kind: 'pengeluaran_pribadi' as const,
      merchant_raw: 'Kopi Kenangan',
      source: 'manual' as const,
    };
    recordCashEvent(dasar, database);
    // Beberapa menit kemudian: pembelian kedua yang sungguhan.
    recordCashEvent({ ...dasar, occurred_at: `${today()}T15:40:00+07:00` }, database);
    expect(jumlahTransaksi(database)).toBe(2);
  });

  it('T3: dua uang masuk Rp30.000 tanpa referensi tidak boleh menyelesaikan piutang dengan satu uang', () => {
    // Dua piutang teman Rp30.000 masing-masing.
    const keluar = recordCashEvent(
      {
        occurred_at: `${today()}T19:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 60_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        reference_no: 'T3-KELUAR',
        source: 'manual',
        allocations: [
          { amount_minor: 30_000, purpose: 'piutang_teman', bearer_type: 'teman' },
          { amount_minor: 30_000, purpose: 'piutang_teman', bearer_type: 'teman' },
        ],
      },
      database,
    );
    const piutang = database
      .prepare(`SELECT r.id FROM receivable r JOIN allocation a ON a.id = r.allocation_id WHERE a.cash_event_id = ? ORDER BY r.id`)
      .all(keluar.id) as Array<{ id: number }>;
    expect(piutang).toHaveLength(2);

    const masukDasar = {
      occurred_at: `${today()}T20:00:00+07:00`,
      direction: 'masuk' as const,
      amount_minor: 30_000,
      account_id: akun(database, 'Mandiri'),
      kind: 'pemasukan_luar' as const,
      merchant_raw: 'Transfer dari teman',
      source: 'manual' as const,
    };
    const m1 = recordCashEvent(masukDasar, database);
    jadikanPelunasanPiutang(m1.id, piutang[0]!.id, 'uji', database);
    const m2 = recordCashEvent({ ...masukDasar, occurred_at: `${today()}T20:30:00+07:00` }, database);
    expect(m2.id).not.toBe(m1.id);
    jadikanPelunasanPiutang(m2.id, piutang[1]!.id, 'uji', database);

    // Uang yang benar-benar masuk: 2 x 30.000 = 60.000; piutang kembali harus sama persis.
    const kembali = database.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS n FROM receivable_settlement`).get() as { n: number };
    const uangMasuk = database
      .prepare(`SELECT COALESCE(SUM(amount_minor),0) AS n FROM cash_event WHERE direction='masuk'`)
      .get() as { n: number };
    expect(kembali.n).toBe(uangMasuk.n);
    expect(listReceivables({ onlyOpen: true }, database).total_sisa_minor).toBe(0);
  });

  it('T4: membagi ulang transaksi yang sudah melunasi piutang tidak boleh melunasi dua kali', async () => {
    const { resplitCashEvent } = await import('../src/domain/ledger.js');
    const keluar = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 100_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'talangan',
        reference_no: 'T4-KELUAR',
        source: 'manual',
      },
      database,
    );
    const p = database.prepare(`SELECT r.id FROM receivable r JOIN allocation a ON a.id = r.allocation_id WHERE a.cash_event_id = ?`).get(keluar.id) as { id: number };
    const masuk = recordCashEvent(
      {
        occurred_at: `${today()}T11:00:00+07:00`,
        direction: 'masuk',
        amount_minor: 30_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pemasukan_luar',
        reference_no: 'T4-MASUK',
        source: 'manual',
      },
      database,
    );
    jadikanPelunasanPiutang(masuk.id, p.id, 'uji', database);
    // Sisa piutang masih Rp70.000, jadi tanpa penjagaan ini bagi-ulang akan melunasi lagi Rp30.000.
    expect(() =>
      resplitCashEvent(
        masuk.id,
        [{ amount_minor: 30_000, purpose: 'pelunasan_piutang', bearer_type: 'saya', receivable_id: p.id }],
        'uji',
        database,
      ),
    ).toThrow();
    const kembali = database.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS n FROM receivable_settlement`).get() as { n: number };
    expect(kembali.n).toBe(30_000);
  });
});
