/**
 * Mengisi database dengan CONTOH kasus nyata agar aplikasi bisa dilihat bekerja
 * sebelum Gmail dan Telegram disambungkan.
 *
 * Jalankan: node server/dist/scripts/contoh.js
 * Hapus dengan: node server/dist/scripts/contoh.js --hapus
 *
 * Semua baris yang dibuat skrip ini diberi catatan "[CONTOH]" supaya mudah
 * dikenali dan dihapus. Jangan dijalankan di database yang sudah berisi data asli.
 */
import { db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { nowIso, today, addDays } from '../domain/time.js';
import { recordCashEvent } from '../domain/ledger.js';
import { recordReconciliation } from '../domain/balances.js';
import { setAssumption } from '../domain/assumptions.js';
import { rebuildObligations } from '../domain/obligations.js';
import { bagiBiaya, jadikanPelunasanPiutang, jadikanReimburseCompany } from '../domain/applyDecision.js';
import { setTopupStatus } from '../domain/topup.js';
import { applyInvoiceStatus } from '../domain/services.js';
import { formatIDR } from '../domain/money.js';

const TANDA = '[CONTOH]';

function hapus(): void {
  const database = db();
  const run = database.transaction(() => {
    database.prepare(`DELETE FROM cash_event WHERE note LIKE '%${TANDA}%'`).run();
    database.prepare(`DELETE FROM evidence WHERE subject LIKE '%${TANDA}%'`).run();
    database.prepare(`DELETE FROM reconciliation WHERE note LIKE '%${TANDA}%'`).run();
    database.prepare(`DELETE FROM purchase WHERE note LIKE '%${TANDA}%'`).run();
    database.prepare(`DELETE FROM receivable WHERE id NOT IN (SELECT receivable_id FROM receivable_settlement)`).run();
  });
  run();
  console.log('Data contoh dihapus.');
}

function akunId(nama: string): number {
  const row = db().prepare(`SELECT id FROM account WHERE name LIKE ?`).get(`%${nama}%`) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`Rekening ${nama} tidak ditemukan.`);
  return row.id;
}

function kategoriId(slug: string): number | null {
  const row = db().prepare(`SELECT id FROM category WHERE slug = ?`).get(slug) as { id: number } | undefined;
  return row?.id ?? null;
}

function buktiPalsu(kind: string, subject: string, from: string): number {
  const res = db()
    .prepare(
      `INSERT OR IGNORE INTO evidence
        (source, external_id, kind, received_at, from_email, subject, permalink, body_hash,
         parsed_json, parser, confidence, is_promo, needs_review, created_at)
       VALUES ('manual', ?, ?, ?, ?, ?, NULL, ?, '{}', 'contoh', 0.9, 0, 0, ?)`,
    )
    .run(
      `contoh-${subject}`,
      kind,
      nowIso(),
      from,
      `${TANDA} ${subject}`,
      `contoh:${subject}`,
      nowIso(),
    );
  if (res.changes) return Number(res.lastInsertRowid);
  const row = db().prepare(`SELECT id FROM evidence WHERE body_hash = ?`).get(`contoh:${subject}`) as {
    id: number;
  };
  return row.id;
}

function isi(): void {
  const database = db();
  const hariIni = today();
  const mandiri = akunId('Mandiri');
  const bca = akunId('BCA');

  console.log('--- Mengisi data contoh ---');

  // 1. Asumsi awal yang dikonfirmasi: tanggal awal periode.
  setAssumption(
    'periode_mulai',
    addDays(hariIni, -12),
    {
      effectiveFrom: addDays(hariIni, -12),
      certainty: 'terverifikasi',
      source: 'manual',
      note: `${TANDA} tanggal awal periode untuk contoh`,
      actor: 'contoh',
    },
    database,
  );

  // 2. Titik tambat saldo: Rp2.450.000 di Mandiri, 13 hari lalu.
  recordReconciliation(
    {
      account_id: mandiri,
      as_of: `${addDays(hariIni, -13)}T23:59:59+07:00`,
      statement_balance_minor: 2_450_000,
      source: 'manual',
      note: `${TANDA} saldo terkonfirmasi dari mutasi`,
    },
    database,
  );
  recordReconciliation(
    {
      account_id: bca,
      as_of: `${addDays(hariIni, -13)}T23:59:59+07:00`,
      statement_balance_minor: 1_200_000,
      source: 'manual',
      note: `${TANDA} saldo terkonfirmasi dari mutasi`,
    },
    database,
  );

  // 3. Makan sehari-hari (realisasi di bawah dan di atas anggaran).
  const makan = [
    [-11, 28_000], [-10, 32_000], [-9, 25_000], [-8, 45_000], [-7, 30_000],
    [-6, 22_000], [-5, 36_000], [-4, 30_000], [-3, 18_000], [-2, 41_000], [-1, 27_000],
  ] as const;
  for (const [offset, nominal] of makan) {
    recordCashEvent(
      {
        occurred_at: `${addDays(hariIni, offset)}T12:30:00+07:00`,
        direction: 'keluar',
        amount_minor: nominal,
        account_id: mandiri,
        kind: 'pengeluaran_pribadi',
        merchant_raw: 'Warung dekat kampus',
        category_id: kategoriId('makan'),
        source: 'manual',
        note: `${TANDA} makan harian`,
        actor: 'contoh',
      },
      database,
    );
  }

  // 4. KASUS: makan bersama Rp120.000, bagianku Rp30.000, tiga teman masing-masing Rp30.000.
  const bersama = recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -6)}T19:10:00+07:00`,
      direction: 'keluar',
      amount_minor: 120_000,
      account_id: mandiri,
      kind: 'pengeluaran_pribadi',
      merchant_raw: 'Makan malam berempat',
      category_id: kategoriId('makan'),
      source: 'manual',
      note: `${TANDA} makan bersama tiga teman`,
      actor: 'contoh',
    },
    database,
  );
  bagiBiaya(
    bersama.id,
    {
      orang: [
        { nama: 'Rizki', nominal_minor: 30_000 },
        { nama: 'Dinda', nominal_minor: 30_000 },
        { nama: 'Yoga', nominal_minor: 30_000 },
      ],
      bagian_saya_minor: 30_000,
      actor: 'contoh',
    },
    database,
  );
  console.log('• Makan bersama Rp120.000 → biaya pribadi Rp30.000 + piutang Rp90.000');

  // 5. Dua dari tiga teman membayar (Rp60.000 kembali, sisa piutang Rp30.000).
  const piutangTeman = database
    .prepare(
      `SELECT r.id FROM receivable r JOIN allocation a ON a.id = r.allocation_id
        WHERE a.cash_event_id = ? AND r.debtor_type = 'teman' ORDER BY r.id`,
    )
    .all(bersama.id) as Array<{ id: number }>;
  for (const p of piutangTeman.slice(0, 2)) {
    const masuk = recordCashEvent(
      {
        occurred_at: `${addDays(hariIni, -4)}T09:00:00+07:00`,
        direction: 'masuk',
        amount_minor: 30_000,
        account_id: mandiri,
        kind: 'pemasukan_luar',
        merchant_raw: 'Transfer dari teman',
        source: 'manual',
        note: `${TANDA} pelunasan sebagian`,
        actor: 'contoh',
      },
      database,
    );
    jadikanPelunasanPiutang(masuk.id, p.id, 'contoh', database);
  }
  console.log('• Rp60.000 kembali → sisa piutang teman Rp30.000, bukan pemasukan baru');

  // 6. KASUS: transfer Mandiri → BCA milikku (setoran tabungan), dua sisi terlihat.
  recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -9)}T10:00:00+07:00`,
      direction: 'keluar',
      amount_minor: 500_000,
      account_id: mandiri,
      kind: 'setoran_tabungan',
      merchant_raw: 'Transfer ke BCA sendiri',
      reference_no: 'TF-CONTOH-001',
      source: 'manual',
      note: `${TANDA} setoran tabungan sisi keluar`,
      actor: 'contoh',
    },
    database,
  );
  recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -9)}T10:01:00+07:00`,
      direction: 'masuk',
      amount_minor: 500_000,
      account_id: bca,
      kind: 'transfer_internal',
      merchant_raw: 'Transfer dari Mandiri sendiri',
      reference_no: 'TF-CONTOH-001-IN',
      source: 'manual',
      note: `${TANDA} setoran tabungan sisi masuk`,
      actor: 'contoh',
    },
    database,
  );
  console.log('• Transfer Mandiri → BCA Rp500.000 dicocokkan sebagai satu perpindahan, bukan pengeluaran');

  // 7. KASUS: transfer ke rekening BCA ORANG LAIN = transaksi biasa.
  recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -5)}T15:20:00+07:00`,
      direction: 'keluar',
      amount_minor: 250_000,
      account_id: mandiri,
      kind: 'pengeluaran_pribadi',
      merchant_raw: 'Transfer ke BCA milik Bu Ani (bayar les)',
      reference_no: 'TF-CONTOH-002',
      category_id: kategoriId('pendidikan'),
      source: 'manual',
      note: `${TANDA} transfer ke rekening BCA orang lain, bukan transfer internal`,
      actor: 'contoh',
    },
    database,
  );

  // 8. KASUS: transfer internal yang baru terlihat satu sisi.
  recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -2)}T08:30:00+07:00`,
      direction: 'keluar',
      amount_minor: 300_000,
      account_id: mandiri,
      kind: 'setoran_tabungan',
      merchant_raw: 'Transfer ke BCA sendiri',
      reference_no: 'TF-CONTOH-003',
      source: 'manual',
      note: `${TANDA} sisi masuk BCA belum terlihat`,
      actor: 'contoh',
    },
    database,
  );
  console.log('• Satu setoran tabungan ditandai menunggu pasangan');

  // 9. KASUS: aku menalangi biaya server company, akan direimburse.
  const server = recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -8)}T11:00:00+07:00`,
      direction: 'keluar',
      amount_minor: 410_700,
      account_id: mandiri,
      kind: 'pengeluaran_pribadi',
      merchant_raw: 'IDCloudHost VPS',
      category_id: kategoriId('server-hosting'),
      source: 'manual',
      note: `${TANDA} aku bayar dulu biaya server company`,
      actor: 'contoh',
    },
    database,
  );
  jadikanReimburseCompany(server.id, { actor: 'contoh' }, database);
  console.log('• Server company Rp410.700 kubayar dulu → saldoku turun, piutang company bertambah');

  // 10. KASUS: company membayar langsung (saldoku tidak berubah).
  recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -7)}T09:00:00+07:00`,
      direction: 'keluar',
      amount_minor: 410_700,
      account_id: null,
      is_cash: false,
      kind: 'pengeluaran_company_langsung',
      merchant_raw: 'IDCloudHost VPS (dibayar company)',
      category_id: kategoriId('server-hosting'),
      source: 'manual',
      note: `${TANDA} company membayar langsung, saldo pribadiku tidak berubah`,
      actor: 'contoh',
    },
    database,
  );

  // 11. KASUS: invoice + kuitansi + notifikasi bank untuk SATU pembayaran.
  const svcBiznet = database.prepare(`SELECT id FROM service WHERE slug = 'biznet-gio-pribadi'`).get() as
    | { id: number }
    | undefined;
  const invBiznet = database
    .prepare(`SELECT id FROM invoice WHERE service_id = ? ORDER BY id LIMIT 1`)
    .get(svcBiznet?.id ?? 0) as { id: number } | undefined;

  const buktiNotif = buktiPalsu('notifikasi_bank', 'Notifikasi Mandiri Biznet', 'noreply@bankmandiri.co.id');
  const buktiKuitansi = buktiPalsu('kuitansi', 'Kuitansi Biznet Gio', 'billing@biznetgio.com');
  const buktiInvoice = buktiPalsu('invoice', 'Invoice Biznet Gio', 'billing@biznetgio.com');

  const bayarBiznet = recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -3)}T14:05:00+07:00`,
      direction: 'keluar',
      amount_minor: 198_690,
      account_id: mandiri,
      kind: 'bayar_langganan',
      merchant_raw: 'Biznet Gio',
      reference_no: 'BZ-CONTOH-77421',
      service_id: svcBiznet?.id ?? null,
      invoice_id: invBiznet?.id ?? null,
      category_id: kategoriId('server-hosting'),
      source: 'manual',
      note: `${TANDA} pembayaran Biznet Gio`,
      evidence: [{ evidence_id: buktiNotif, role: 'notifikasi_bank' }],
      actor: 'contoh',
    },
    database,
  );

  // Kuitansi vendor untuk pembayaran yang SAMA — harus digabung, bukan jadi transaksi baru.
  const ulang = recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -3)}T14:05:00+07:00`,
      direction: 'keluar',
      amount_minor: 198_690,
      account_id: mandiri,
      kind: 'bayar_langganan',
      merchant_raw: 'Biznet Gio',
      reference_no: 'BZ-CONTOH-77421',
      source: 'manual',
      note: `${TANDA} kuitansi vendor untuk pembayaran yang sama`,
      evidence: [{ evidence_id: buktiKuitansi, role: 'kuitansi' }],
      actor: 'contoh',
    },
    database,
  );
  console.log(
    `• Invoice + kuitansi + notifikasi bank → ${ulang.created ? 'DUPLIKAT (salah)' : 'satu transaksi, tiga bukti (benar)'}`,
  );

  if (invBiznet) {
    database
      .prepare(`INSERT OR IGNORE INTO invoice_evidence (invoice_id, evidence_id, role) VALUES (?, ?, 'invoice')`)
      .run(invBiznet.id, buktiInvoice);
    database
      .prepare(`INSERT OR IGNORE INTO invoice_evidence (invoice_id, evidence_id, role) VALUES (?, ?, 'kuitansi')`)
      .run(invBiznet.id, buktiKuitansi);
    applyInvoiceStatus(
      {
        invoice_id: invBiznet.id,
        status: 'lunas_terkonfirmasi',
        occurred_at: `${addDays(hariIni, -3)}T14:10:00+07:00`,
        evidence_id: buktiKuitansi,
        note: `${TANDA} kuitansi diterima`,
        actor: 'contoh',
      },
      database,
    );
  }
  void bayarBiznet;

  // 12. KASUS: notifikasi bank ganda untuk transaksi yang sama.
  const kopi1 = recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -3)}T08:00:00+07:00`,
      direction: 'keluar',
      amount_minor: 75_000,
      account_id: mandiri,
      kind: 'pengeluaran_pribadi',
      merchant_raw: 'Toko Buku',
      reference_no: 'TB-CONTOH-991',
      category_id: kategoriId('belanja-barang'),
      source: 'manual',
      note: `${TANDA} notifikasi pertama`,
      actor: 'contoh',
    },
    database,
  );
  const kopi2 = recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -3)}T08:00:30+07:00`,
      direction: 'keluar',
      amount_minor: 75_000,
      account_id: mandiri,
      kind: 'pengeluaran_pribadi',
      merchant_raw: 'Toko Buku',
      reference_no: 'TB-CONTOH-991',
      source: 'manual',
      note: `${TANDA} notifikasi kedua (duplikat)`,
      actor: 'contoh',
    },
    database,
  );
  console.log(
    `• Notifikasi bank ganda → ${kopi2.created ? 'DUPLIKAT (salah)' : 'satu transaksi (benar)'} (id ${kopi1.id})`,
  );

  // 13. KASUS: top-up rencana yang TIDAK diterima.
  rebuildObligations({}, database);
  const topupLewat = database
    .prepare(`SELECT id FROM topup_plan WHERE plan_date < ? AND status = 'rencana' ORDER BY plan_date LIMIT 1`)
    .get(hariIni) as { id: number } | undefined;
  if (topupLewat) {
    setTopupStatus(topupLewat.id, 'tidak_diterima', { actor: 'contoh', note: `${TANDA} tidak diterima` }, database);
    console.log('• Satu rencana top-up ditandai tidak diterima → proyeksi dihitung ulang tanpa uang itu');
  }
  // Satu top-up yang benar-benar diterima.
  const topupDiterima = database
    .prepare(`SELECT id, plan_amount_minor, plan_date FROM topup_plan WHERE status = 'rencana' AND plan_date < ? ORDER BY plan_date LIMIT 1`)
    .get(hariIni) as { id: number; plan_amount_minor: number; plan_date: string } | undefined;
  if (topupDiterima) {
    const masuk = recordCashEvent(
      {
        occurred_at: `${topupDiterima.plan_date}T07:30:00+07:00`,
        direction: 'masuk',
        amount_minor: topupDiterima.plan_amount_minor,
        account_id: mandiri,
        kind: 'pemasukan_luar',
        merchant_raw: 'Top-up diterima',
        source: 'manual',
        note: `${TANDA} top-up masuk`,
        actor: 'contoh',
      },
      database,
    );
    setTopupStatus(
      topupDiterima.id,
      'diterima',
      {
        actual_amount_minor: topupDiterima.plan_amount_minor,
        actual_date: topupDiterima.plan_date,
        cash_event_id: masuk.id,
        actor: 'contoh',
      },
      database,
    );
  }

  // 14. KASUS: belanja tanpa harga.
  database
    .prepare(
      `INSERT INTO purchase
        (name, qty, unit_price_minor, total_minor, price_unknown, currency, planned, wanted_on,
         category_id, final_bearer, payment_status, note, created_at, updated_at)
       VALUES ('Monitor bekas', 1, NULL, NULL, 1, 'IDR', 1, ?, ?, 'saya', 'belum_dibayar', ?, ?, ?)`,
    )
    .run(addDays(hariIni, 6), kategoriId('belanja-barang'), `${TANDA} harga belum diketahui`, nowIso(), nowIso());
  console.log('• Belanja "Monitor bekas" tanpa harga → risiko anggaran yang belum dapat dihitung');

  // 15. Hadiah untuk orang lain (tetap biaya pribadiku).
  recordCashEvent(
    {
      occurred_at: `${addDays(hariIni, -1)}T16:00:00+07:00`,
      direction: 'keluar',
      amount_minor: 150_000,
      account_id: mandiri,
      kind: 'hadiah',
      merchant_raw: 'Kado ulang tahun Dinda',
      category_id: kategoriId('hadiah'),
      source: 'manual',
      note: `${TANDA} hadiah, bukan piutang`,
      actor: 'contoh',
    },
    database,
  );

  rebuildObligations({}, database);
  console.log('--- Selesai ---');
  console.log(`Saldo Mandiri titik tambat: ${formatIDR(2_450_000)} pada ${addDays(hariIni, -13)}`);
  console.log('Buka web untuk melihat hasilnya. Hapus dengan: node server/dist/scripts/contoh.js --hapus');
}

const database = db();
migrate(database);
seed(database);

if (process.argv.includes('--hapus')) hapus();
else isi();
