import { describe, expect, it, beforeEach } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import { akun, dbUji, kategori, pasangPeriode, pasangSaldo } from './bantu.js';
import { recordCashEvent } from '../src/domain/ledger.js';
import { jadikanCompanyLangsung } from '../src/domain/applyDecision.js';
import { project } from '../src/domain/projection.js';
import { rebuildObligations } from '../src/domain/obligations.js';
import { setTopupStatus } from '../src/domain/topup.js';
import { periodReport } from '../src/domain/periods.js';
import { setAssumption, assumptionAt } from '../src/domain/assumptions.js';
import { addDays, today } from '../src/domain/time.js';
import { nowIso } from '../src/domain/time.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
  pasangSaldo(database, 'Mandiri', 1_000_000, -20);
});

function hari(p: ReturnType<typeof project>, tanggal: string) {
  const h = p.hari.find((x) => x.tanggal === tanggal);
  if (!h) throw new Error(`hari ${tanggal} tidak ada dalam proyeksi`);
  return h;
}

describe('rencana makan versus realisasi', () => {
  it('hari depan memakai anggaran penuh', () => {
    const besok = addDays(today(), 1);
    const p = project({ dari: today(), sampai: addDays(today(), 3) }, database);
    expect(hari(p, besok).makan_rencana_minor).toBe(30_000);
    expect(hari(p, besok).makan_aktual_minor).toBe(0);
  });

  it('hari ini: rencana hanya sisa anggaran, tidak ditambahkan dua kali', () => {
    recordCashEvent(
      {
        occurred_at: `${today()}T12:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 18_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        category_id: kategori(database, 'makan'),
        source: 'manual',
      },
      database,
    );
    const p = project({ dari: today(), sampai: addDays(today(), 2) }, database);
    const h = hari(p, today());
    expect(h.makan_aktual_minor).toBe(18_000);
    expect(h.makan_rencana_minor).toBe(12_000);
    expect(h.makan_aktual_minor + h.makan_rencana_minor).toBe(30_000);
  });

  it('realisasi makan di atas anggaran tidak menambah rencana', () => {
    recordCashEvent(
      {
        occurred_at: `${today()}T12:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 45_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        category_id: kategori(database, 'makan'),
        source: 'manual',
      },
      database,
    );
    const h = hari(project({ dari: today(), sampai: today() }, database), today());
    expect(h.makan_rencana_minor).toBe(0);
    expect(h.selisih_makan_minor).toBe(-15_000);
  });

  it('hari lampau memakai realisasi saja', () => {
    const kemarin = addDays(today(), -1);
    recordCashEvent(
      {
        occurred_at: `${kemarin}T12:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 22_000,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        category_id: kategori(database, 'makan'),
        source: 'manual',
      },
      database,
    );
    const h = hari(project({ dari: kemarin, sampai: today() }, database), kemarin);
    expect(h.makan_aktual_minor).toBe(22_000);
    expect(h.makan_rencana_minor).toBe(0);
  });
});

describe('top-up rencana versus aktual', () => {
  it('rencana top-up masa depan dihitung sebagai pemasukan rencana', () => {
    pasangPeriode(database, 0);
    rebuildObligations({}, database);
    const mulai = String(assumptionAt<string>('periode_mulai', today(), database)!.value);
    const p = project({ dari: today(), sampai: addDays(today(), 10) }, database);
    expect(hari(p, mulai).masuk_rencana_minor).toBeGreaterThan(0);
  });

  it('top-up yang ditandai tidak diterima langsung hilang dari proyeksi', () => {
    pasangPeriode(database, 0);
    rebuildObligations({}, database);
    const rencana = database
      .prepare(`SELECT id, plan_date FROM topup_plan ORDER BY plan_date LIMIT 1`)
      .get() as { id: number; plan_date: string };

    const sebelum = project({ dari: today(), sampai: addDays(today(), 10) }, database);
    const akhirSebelum = sebelum.ringkasan.saldo_akhir_minor;

    setTopupStatus(rencana.id, 'tidak_diterima', { actor: 'uji' }, database);

    const sesudah = project({ dari: today(), sampai: addDays(today(), 10) }, database);
    expect(sesudah.ringkasan.saldo_akhir_minor).toBe(akhirSebelum - 350_000);
    expect(hari(sesudah, rencana.plan_date).masuk_rencana_minor).toBe(0);
  });

  it('top-up yang sudah diterima tidak dihitung dua kali', () => {
    pasangPeriode(database, 0);
    rebuildObligations({}, database);
    const rencana = database
      .prepare(`SELECT id, plan_date, plan_amount_minor FROM topup_plan ORDER BY plan_date LIMIT 1`)
      .get() as { id: number; plan_date: string; plan_amount_minor: number };

    const masuk = recordCashEvent(
      {
        occurred_at: `${rencana.plan_date}T08:00:00+07:00`,
        direction: 'masuk',
        amount_minor: rencana.plan_amount_minor,
        account_id: akun(database, 'Mandiri'),
        kind: 'pemasukan_luar',
        source: 'manual',
      },
      database,
    );
    setTopupStatus(
      rencana.id,
      'diterima',
      { actual_amount_minor: rencana.plan_amount_minor, actual_date: rencana.plan_date, cash_event_id: masuk.id, actor: 'uji' },
      database,
    );

    const p = project({ dari: rencana.plan_date, sampai: rencana.plan_date }, database);
    const h = hari(p, rencana.plan_date);
    expect(h.masuk_aktual_minor).toBe(rencana.plan_amount_minor);
    expect(h.masuk_rencana_minor).toBe(0);
  });

  it('rencana top-up yang sudah lewat dan belum dikonfirmasi tidak menjadi uang, tetapi muncul sebagai risiko', () => {
    pasangPeriode(database, -5);
    rebuildObligations({}, database);
    const p = project({ dari: addDays(today(), -5), sampai: addDays(today(), 2) }, database);
    const lewat = p.hari.find((h) => h.tanggal === addDays(today(), -5))!;
    expect(lewat.masuk_rencana_minor).toBe(0);
    expect(p.risiko.some((r) => r.tipe === 'topup_belum_dikonfirmasi')).toBe(true);
  });
});

describe('tagihan dan belanja', () => {
  it('tagihan yang sudah dibayar tidak lagi memotong saldo', () => {
    const svc = database.prepare(`SELECT id FROM service WHERE slug = 'idcloudhost-vps-company'`).get() as { id: number };
    const inv = database
      .prepare(`SELECT id, due_date, amount_minor FROM invoice WHERE service_id = ? AND due_date >= ? ORDER BY due_date LIMIT 1`)
      .get(svc.id, today()) as { id: number; due_date: string; amount_minor: number };

    rebuildObligations({}, database);
    const sebelum = project({ dari: today(), sampai: addDays(today(), 60) }, database);
    const akhirSebelum = sebelum.ringkasan.saldo_akhir_minor;

    recordCashEvent(
      {
        occurred_at: `${inv.due_date}T09:00:00+07:00`,
        direction: 'keluar',
        amount_minor: inv.amount_minor,
        account_id: akun(database, 'Mandiri'),
        kind: 'bayar_langganan',
        invoice_id: inv.id,
        service_id: svc.id,
        source: 'manual',
      },
      database,
    );
    rebuildObligations({}, database);

    const sesudah = project({ dari: today(), sampai: addDays(today(), 60) }, database);
    // Uang keluar dicatat sekali: saldo akhir sama, bukan turun dua kali.
    expect(sesudah.ringkasan.saldo_akhir_minor).toBe(akhirSebelum);
  });

  it('belanja tanpa harga tidak dianggap gratis dan muncul sebagai risiko', () => {
    database
      .prepare(
        `INSERT INTO purchase (name, qty, unit_price_minor, total_minor, price_unknown, currency, planned,
           wanted_on, final_bearer, payment_status, note, created_at, updated_at)
         VALUES ('Monitor bekas', 1, NULL, NULL, 1, 'IDR', 1, ?, 'saya', 'belum_dibayar', 'uji', ?, ?)`,
      )
      .run(addDays(today(), 3), nowIso(), nowIso());
    rebuildObligations({}, database);

    const p = project({ dari: today(), sampai: addDays(today(), 7) }, database);
    const h = hari(p, addDays(today(), 3));
    expect(h.belanja_minor).toBe(0);
    expect(h.risiko_belum_terhitung.join(' ')).toContain('Monitor bekas');
    expect(p.risiko.some((r) => r.tipe === 'harga_belum_diketahui')).toBe(true);
  });

  it('tagihan terlambat dibawa ke hari ini, bukan diabaikan', () => {
    rebuildObligations({}, database);
    const p = project({ dari: today(), sampai: addDays(today(), 5) }, database);
    expect(hari(p, today()).tagihan_minor).toBeGreaterThan(0);
    expect(p.risiko.some((r) => r.tipe === 'tagihan_terlambat')).toBe(true);
  });
});

describe('skenario', () => {
  it('Claude Pro pribadi hanya memotong saldo pada skenario yang mengaktifkannya', () => {
    database
      .prepare(`UPDATE service SET next_due_date = ? WHERE slug = 'claude-pro-pribadi'`)
      .run(addDays(today(), 3));
    rebuildObligations({}, database);

    const tanpa = project({ dari: today(), sampai: addDays(today(), 10) }, database);
    const dengan = project({ dari: today(), sampai: addDays(today(), 10), skenario: 'dengan-claude-pribadi' }, database);

    expect(dengan.ringkasan.saldo_akhir_minor).toBe(tanpa.ringkasan.saldo_akhir_minor - 370_000);
  });

  it('override skenario mengubah anggaran makan tanpa mengubah asumsi tersimpan', () => {
    const dasar = project({ dari: today(), sampai: addDays(today(), 4) }, database);
    const naik = project({ dari: today(), sampai: addDays(today(), 4), skenario: 'makan-naik' }, database);
    expect(naik.ringkasan.saldo_akhir_minor).toBeLessThan(dasar.ringkasan.saldo_akhir_minor);
    expect(assumptionAt<number>('anggaran_makan_harian', today(), database)!.value).toBe(30_000);
  });
});

describe('dana tagihan dan skenario', () => {
  it('tagihan khusus skenario tidak ikut dijumlahkan di skenario dasar', async () => {
    const { tagihanMendekat } = await import('../src/domain/services.js');
    database.prepare(`UPDATE service SET next_due_date = ? WHERE slug = 'claude-pro-pribadi'`).run(addDays(today(), 3));
    rebuildObligations({}, database);

    const dasar = tagihanMendekat({ hari: 30 }, database);
    const dengan = tagihanMendekat({ hari: 30, skenario: 'dengan-claude-pribadi' }, database);

    const claude = dasar.daftar.find((d) => d.label.includes('Claude Pro (pribadi)'));
    expect(claude).toBeDefined();
    expect(claude!.aktif_di_skenario).toBe(false);
    expect(dasar.jumlah_hanya_skenario_lain).toBeGreaterThan(0);

    // Tetap ditampilkan di kedua skenario, tetapi hanya dijumlahkan di yang mengaktifkannya.
    expect(dengan.dana_perlu_disiapkan_minor - dasar.dana_perlu_disiapkan_minor).toBe(370_000);
  });
});

describe('status risiko harian', () => {
  it('menandai RENDAH di bawah cadangan minimal dan DEFISIT di bawah nol', () => {
    const db2 = dbUji();
    pasangSaldo(db2, 'Mandiri', 60_000, -1);
    const p = project({ dari: today(), sampai: addDays(today(), 3) }, db2);
    expect(p.hari[0]!.status).toBe('rendah');
    const terakhir = p.hari[p.hari.length - 1]!;
    expect(['rendah', 'defisit']).toContain(terakhir.status);
  });

  it('melaporkan kebutuhan tambahan agar tidak defisit', () => {
    const db2 = dbUji();
    pasangSaldo(db2, 'Mandiri', 20_000, -1);
    const p = project({ dari: today(), sampai: addDays(today(), 5) }, db2);
    expect(p.ringkasan.kekurangan_agar_tidak_defisit_minor).toBeGreaterThan(0);
    expect(p.ringkasan.tanggal_defisit).not.toBeNull();
  });
});

describe('biaya company langsung', () => {
  it('tidak memotong saldo proyeksi tetapi tetap dilaporkan', () => {
    const ev = recordCashEvent(
      {
        occurred_at: `${today()}T10:00:00+07:00`,
        direction: 'keluar',
        amount_minor: 410_700,
        account_id: akun(database, 'Mandiri'),
        kind: 'pengeluaran_pribadi',
        source: 'manual',
      },
      database,
    );
    const sebelum = project({ dari: today(), sampai: today() }, database).hari[0]!.saldo_akhir_minor;
    jadikanCompanyLangsung(ev.id, 'uji', database);
    const p = project({ dari: today(), sampai: today() }, database);
    expect(p.hari[0]!.saldo_akhir_minor).toBe(sebelum + 410_700);
    expect(p.hari[0]!.biaya_company_minor).toBe(410_700);
  });
});

describe('asumsi berversi', () => {
  it('mengubah asumsi hari ini tidak mengubah hari-hari sebelumnya', () => {
    const kemarin = addDays(today(), -1);
    setAssumption(
      'anggaran_makan_harian',
      50_000,
      { effectiveFrom: today(), certainty: 'terverifikasi', source: 'manual', actor: 'uji' },
      database,
    );
    expect(assumptionAt<number>('anggaran_makan_harian', kemarin, database)!.value).toBe(30_000);
    expect(assumptionAt<number>('anggaran_makan_harian', today(), database)!.value).toBe(50_000);

    const p = project({ dari: kemarin, sampai: today() }, database);
    expect(hari(p, kemarin).anggaran_makan_minor).toBe(30_000);
    expect(hari(p, today()).anggaran_makan_minor).toBe(50_000);
  });
});

describe('periode lima hari', () => {
  it('tidak tersedia sampai tanggal awal periode dikonfirmasi', () => {
    const rep = periodReport({}, database);
    expect(rep.tersedia).toBe(false);
    expect(rep.alasan).toContain('periode_mulai');
  });

  it('membentuk blok lima hari dan menandai blok yang sedang berjalan', () => {
    pasangPeriode(database, -12);
    rebuildObligations({}, database);
    const rep = periodReport({}, database);
    expect(rep.tersedia).toBe(true);
    expect(rep.panjang_hari).toBe(5);
    expect(rep.berjalan).not.toBeNull();
    const b = rep.berjalan!;
    expect(b.mulai <= today() && b.akhir >= today()).toBe(true);
    const panjang = Math.round((Date.parse(`${b.akhir}T00:00:00Z`) - Date.parse(`${b.mulai}T00:00:00Z`)) / 86_400_000) + 1;
    expect(panjang).toBe(5);
  });
});
