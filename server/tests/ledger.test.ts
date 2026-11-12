import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, alokasiPer, dbUji, jumlahTransaksi, kategori, pasangSaldo } from './bantu.js';
import { LedgerError, recordCashEvent, matchInternalTransfer, getCashEvent } from '../src/domain/ledger.js';
import {
  bagiBiaya, jadikanCompanyLangsung, jadikanHadiah, jadikanPelunasanPiutang, jadikanReimburseCompany,
} from '../src/domain/applyDecision.js';
import { listReceivables } from '../src/domain/receivables.js';
import { balanceSummary, accountBalance } from '../src/domain/balances.js';
import { today, addDays } from '../src/domain/time.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
});

describe('deduplikasi bukti', () => {
  it('notifikasi bank ganda dengan referensi sama hanya menjadi satu transaksi', () => {
    const dasar = {
      occurred_at: `${today()}T08:00:00+07:00`,
      direction: 'keluar' as const,
      amount_minor: 75_000,
      account_id: akun(database, 'Mandiri'),
      kind: 'pengeluaran_pribadi' as const,
      merchant_raw: 'Toko Buku',
      reference_no: 'REF-123456',
      source: 'gmail' as const,
    };
    const a = recordCashEvent(dasar, database);
    const b = recordCashEvent({ ...dasar, occurred_at: `${today()}T08:00:40+07:00` }, database);

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.merged).toBe(true);
    expect(b.id).toBe(a.id);
    expect(jumlahTransaksi(database)).toBe(1);
  });

  it('kuitansi vendor dan notifikasi bank untuk pembayaran sama menjadi satu peristiwa dengan dua bukti', () => {
    const buktiBank = database
      .prepare(
        `INSERT INTO evidence (source, external_id, kind, received_at, from_email, subject, permalink,
           body_hash, parsed_json, parser, confidence, is_promo, needs_review, created_at)
         VALUES ('gmail','m1','notifikasi_bank','2026-01-01T00:00:00+07:00','bank@x','Notifikasi',NULL,'h1','{}','uji',0.9,0,0,'2026-01-01T00:00:00+07:00')`,
      )
      .run().lastInsertRowid as number;
    const buktiKuitansi = database
      .prepare(
        `INSERT INTO evidence (source, external_id, kind, received_at, from_email, subject, permalink,
           body_hash, parsed_json, parser, confidence, is_promo, needs_review, created_at)
         VALUES ('gmail','m2','kuitansi','2026-01-01T00:05:00+07:00','billing@v','Kuitansi',NULL,'h2','{}','uji',0.9,0,0,'2026-01-01T00:00:00+07:00')`,
      )
      .run().lastInsertRowid as number;

    const dasar = {
      occurred_at: `${today()}T14:05:00+07:00`,
      direction: 'keluar' as const,
      amount_minor: 198_690,
      account_id: akun(database, 'Mandiri'),
      kind: 'bayar_langganan' as const,
      merchant_raw: 'Biznet Gio',
      reference_no: 'BZ-77421',
      source: 'gmail' as const,
    };
    const a = recordCashEvent({ ...dasar, evidence: [{ evidence_id: buktiBank, role: 'notifikasi_bank' }] }, database);
    const b = recordCashEvent({ ...dasar, evidence: [{ evidence_id: buktiKuitansi, role: 'kuitansi' }] }, database);

    expect(b.created).toBe(false);
    expect(jumlahTransaksi(database)).toBe(1);
    const bukti = database
      .prepare(`SELECT COUNT(*) AS n FROM cash_event_evidence WHERE cash_event_id = ?`)
      .get(a.id) as { n: number };
    expect(bukti.n).toBe(2);
  });

  it('nomor referensi berbeda tetap menjadi dua transaksi terpisah', () => {
    const dasar = {
      occurred_at: `${today()}T08:00:00+07:00`,
      direction: 'keluar' as const,
      amount_minor: 50_000,
      account_id: akun(database, 'Mandiri'),
      kind: 'pengeluaran_pribadi' as const,
      merchant_raw: 'Kopi',
      source: 'gmail' as const,
    };
    recordCashEvent({ ...dasar, reference_no: 'A1' }, database);
    const b = recordCashEvent({ ...dasar, reference_no: 'B2' }, database);
    expect(b.created).toBe(true);
    expect(jumlahTransaksi(database)).toBe(2);
  });
});

describe('pembagian biaya dan piutang', () => {
  it('makan bersama Rp120.000 menjadi biaya pribadi Rp30.000 dan piutang Rp90.000', () => {
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T19:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 120_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        merchant_raw: 'Makan berempat',
        category_id: kategori(database, 'makan'),
        source: 'manual',
      },
      database,
    );
    bagiBiaya(
      ev.id,
      {
        bagian_saya_minor: 30_000,
        orang: [
          { nama: 'A', nominal_minor: 30_000 },
          { nama: 'B', nominal_minor: 30_000 },
          { nama: 'C', nominal_minor: 30_000 },
        ],
      },
      database,
    );

    const alokasi = alokasiPer(database, ev.id);
    expect(alokasi['biaya_pribadi']).toBe(30_000);
    expect(alokasi['piutang_teman']).toBe(90_000);
    // Arus kas keluar tetap Rp120.000 — tidak berubah oleh pembagian.
    expect(getCashEvent(ev.id, database)!.amount_minor).toBe(120_000);
    expect(listReceivables({ onlyOpen: true }, database).total_sisa_minor).toBe(90_000);
  });

  it('uang kembali Rp60.000 mengurangi piutang menjadi Rp30.000 dan bukan pemasukan baru', () => {
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T19:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 120_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        source: 'manual',
      },
      database,
    );
    bagiBiaya(
      ev.id,
      {
        bagian_saya_minor: 30_000,
        orang: [
          { nama: 'A', nominal_minor: 30_000 },
          { nama: 'B', nominal_minor: 30_000 },
          { nama: 'C', nominal_minor: 30_000 },
        ],
      },
      database,
    );
    const piutang = database
      .prepare(`SELECT r.id FROM receivable r JOIN allocation a ON a.id = r.allocation_id WHERE a.cash_event_id = ? ORDER BY r.id`)
      .all(ev.id) as Array<{ id: number }>;

    for (const p of piutang.slice(0, 2)) {
      const masuk = recordCashEvent(
        {
          occurred_at: `${today()}T20:00:00+07:00`,
          direction: 'masuk',
          amount_minor: 30_000,
          account_id: akun(database, 'Mandiri'),
          kind: 'pemasukan_luar',
          reference_no: `KEMBALI-${p.id}`,
          source: 'manual',
        },
        database,
      );
      jadikanPelunasanPiutang(masuk.id, p.id, 'uji', database);
      const alokasi = alokasiPer(database, masuk.id);
      expect(alokasi['pelunasan_piutang']).toBe(30_000);
      expect(alokasi['pemasukan']).toBeUndefined();
    }

    expect(listReceivables({ onlyOpen: true }, database).total_sisa_minor).toBe(30_000);
  });

  it('pelunasan melebihi sisa piutang ditolak', () => {
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 50_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'talangan',
        source: 'manual',
      },
      database,
    );
    const p = database.prepare(`SELECT r.id FROM receivable r JOIN allocation a ON a.id = r.allocation_id WHERE a.cash_event_id = ?`).get(ev.id) as { id: number };
    const masuk = recordCashEvent(
      {
        occurred_at: `${today()}T11:00:00+07:00`,
        direction: 'masuk',
        amount_minor: 80_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pemasukan_luar',
        source: 'manual',
      },
      database,
    );
    // Kelebihan dicatat sebagai pemasukan, bukan menambah piutang negatif.
    jadikanPelunasanPiutang(masuk.id, p.id, 'uji', database);
    const alokasi = alokasiPer(database, masuk.id);
    expect(alokasi['pelunasan_piutang']).toBe(50_000);
    expect(alokasi['pemasukan']).toBe(30_000);
  });

  it('pembagian yang tidak pas ditolak', () => {
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 100_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        source: 'manual',
      },
      database,
    );
    expect(() =>
      bagiBiaya(ev.id, { bagian_saya_minor: 30_000, orang: [{ nama: 'A', nominal_minor: 50_000 }] }, database),
    ).toThrow();
  });

  it('alokasi yang jumlahnya tidak sama dengan nominal transaksi ditolak', () => {
    expect(() =>
      recordCashEvent(
        {
          occurred_at: `${today()}T10:00:00+07:00`,
          direction: 'keluar',
          amount_minor: 100_000,
          account_id: akun(database, 'Mandiri'),
          kind: 'pengeluaran_pribadi',
          source: 'manual',
          allocations: [{ amount_minor: 40_000, purpose: 'biaya_pribadi', bearer_type: 'saya' }],
        },
        database,
      ),
    ).toThrow(LedgerError);
  });
});

describe('hadiah, talangan, dan company', () => {
  it('hadiah tetap pengeluaran pribadi, bukan piutang', () => {
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 150_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        source: 'manual',
      },
      database,
    );
    jadikanHadiah(ev.id, 'uji', database);
    expect(alokasiPer(database, ev.id)['biaya_pribadi']).toBe(150_000);
    expect(listReceivables({ onlyOpen: true }, database).total_sisa_minor).toBe(0);
  });

  it('aku menalangi biaya company: saldoku turun dan piutang company bertambah', () => {
    pasangSaldo(database, 'Mandiri', 1_000_000);
    const sebelum = accountBalance(akun(database, 'Mandiri'), undefined, database).balance_minor;

    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 410_700,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        merchant_raw: 'IDCloudHost',
        source: 'manual',
      },
      database,
    );
    jadikanReimburseCompany(ev.id, { actor: 'uji' }, database);

    const sesudah = accountBalance(akun(database, 'Mandiri'), undefined, database).balance_minor;
    expect(sesudah).toBe((sebelum ?? 0) - 410_700);
    expect(alokasiPer(database, ev.id)['piutang_company']).toBe(410_700);
    expect(listReceivables({ onlyOpen: true }, database).total_sisa_company_minor).toBe(410_700);
  });

  it('company membayar langsung: saldoku tidak berubah', () => {
    pasangSaldo(database, 'Mandiri', 1_000_000);
    const sebelum = accountBalance(akun(database, 'Mandiri'), undefined, database).balance_minor;

    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 410_700,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        merchant_raw: 'IDCloudHost',
        source: 'manual',
      },
      database,
    );
    jadikanCompanyLangsung(ev.id, 'uji', database);

    const sesudah = accountBalance(akun(database, 'Mandiri'), undefined, database).balance_minor;
    expect(sesudah).toBe(sebelum);
    expect(alokasiPer(database, ev.id)['biaya_company_langsung']).toBe(410_700);
    expect(getCashEvent(ev.id, database)!.account_id).toBeNull();
  });
});

describe('transfer antar rekening', () => {
  it('transfer Mandiri ke BCA milikku dicocokkan dan netral terhadap total uangku', () => {
    pasangSaldo(database, 'Mandiri', 2_000_000);
    pasangSaldo(database, 'BCA', 1_000_000);
    const totalSebelum = balanceSummary(undefined, database).total_terverifikasi_minor;

    const keluar = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 500_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'setoran_tabungan',
        reference_no: 'TF-1',
        source: 'manual',
      },
      database,
    );
    recordCashEvent(
      {
        occurred_at: `${today()}T10:01:00+07:00`,
        direction: 'masuk',
        amount_minor: 500_000,
        account_id: akun(database, 'BCA'),
        kind: 'transfer_internal',
        reference_no: 'TF-1-IN',
        source: 'manual',
      },
      database,
    );

    const ringkas = balanceSummary(undefined, database);
    expect(ringkas.total_terverifikasi_minor).toBe(totalSebelum);
    expect(getCashEvent(keluar.id, database)!.transfer_group_id).not.toBeNull();
    expect(getCashEvent(keluar.id, database)!.status).toBe('terkonfirmasi');
  });

  it('transfer yang hanya terlihat satu sisi ditandai menunggu pasangan, uang tidak hilang', () => {
    pasangSaldo(database, 'Mandiri', 2_000_000);
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 300_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'setoran_tabungan',
        reference_no: 'TF-2',
        source: 'manual',
      },
      database,
    );
    const row = getCashEvent(ev.id, database)!;
    expect(row.status).toBe('menunggu_pasangan');
    expect(row.transfer_group_id).toBeNull();

    const ringkas = balanceSummary(undefined, database);
    expect(ringkas.dalam_perjalanan_minor).toBe(300_000);
    expect(ringkas.dalam_perjalanan_jumlah).toBe(1);

    // Ketika sisi pasangan muncul, keduanya tercocokkan.
    recordCashEvent(
      {
        occurred_at: `${today()}T10:02:00+07:00`,
        direction: 'masuk',
        amount_minor: 300_000,
        account_id: akun(database, 'BCA'),
        kind: 'transfer_internal',
        reference_no: 'TF-2-IN',
        source: 'manual',
      },
      database,
    );
    expect(getCashEvent(ev.id, database)!.transfer_group_id).not.toBeNull();
  });

  it('transfer ke rekening BCA orang lain tetap pengeluaran biasa', () => {
    pasangSaldo(database, 'Mandiri', 2_000_000);
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 250_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        merchant_raw: 'Transfer ke BCA Bu Ani',
        source: 'manual',
      },
      database,
    );
    const hasil = matchInternalTransfer(ev.id, 3, database);
    expect(hasil.matched).toBe(false);
    expect(alokasiPer(database, ev.id)['biaya_pribadi']).toBe(250_000);
    expect(balanceSummary(undefined, database).dalam_perjalanan_minor).toBe(0);
  });
});

describe('saldo tidak diklaim tanpa bukti', () => {
  it('tanpa rekonsiliasi, saldo rekening bernilai null dan diberi penjelasan', () => {
    const bal = accountBalance(akun(database, 'Mandiri'), undefined, database);
    expect(bal.balance_minor).toBeNull();
    expect(bal.catatan.join(' ')).toContain('rekonsiliasi');
  });

  it('total hanya menjumlahkan rekening yang punya titik tambat', () => {
    pasangSaldo(database, 'Mandiri', 1_500_000);
    const ringkas = balanceSummary(undefined, database);
    expect(ringkas.total_terverifikasi_minor).toBe(1_500_000);
    expect(ringkas.akun_belum_terverifikasi).toContain('BCA');
    expect(ringkas.lengkap).toBe(false);
  });

  it('pembayaran tanpa rekening tidak mengubah saldo rekening mana pun', () => {
    pasangSaldo(database, 'Mandiri', 1_000_000);
    recordCashEvent(
      {
        occurred_at: `${addDays(today(), -1)}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 349_000,
        account_id: null,
        kind: 'bayar_langganan',
        merchant_raw: 'ChatGPT Plus',
        status: 'perlu_verifikasi',
        source: 'gmail',
        note: 'Diketahui dari kuitansi, rekening belum diketahui.',
      },
      database,
    );
    expect(accountBalance(akun(database, 'Mandiri'), undefined, database).balance_minor).toBe(1_000_000);
  });
});
