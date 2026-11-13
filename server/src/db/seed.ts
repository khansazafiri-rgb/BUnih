import type { Database as DB } from 'better-sqlite3';
import { nowIso } from '../domain/time.js';
import { config } from '../config.js';

/**
 * Seed hanya mengisi KATALOG dan ASUMSI.
 * Seed TIDAK PERNAH membuat cash_event, sehingga tidak ada rupiah palsu
 * yang masuk ke saldo. Angka yang berasal dari Sheet ditandai 'asumsi_sheet'
 * dan memunculkan keputusan yang harus dikonfirmasi lewat Telegram/web.
 */

type SeedStats = Record<string, number>;

const CATEGORIES: Array<[string, string, string, number]> = [
  ['makan', 'Makan', 'makan', 1],
  ['transport', 'Transport', 'transport', 1],
  ['kebutuhan-harian', 'Kebutuhan harian', 'harian', 1],
  ['langganan-ai', 'Langganan AI', 'langganan', 0],
  ['langganan-lain', 'Langganan lain', 'langganan', 0],
  ['server-hosting', 'Server & hosting', 'server', 0],
  ['kredit-api', 'Kredit API / sesuai pemakaian', 'server', 0],
  ['belanja-barang', 'Belanja barang', 'belanja', 0],
  ['hadiah', 'Hadiah', 'belanja', 0],
  ['kesehatan', 'Kesehatan', 'lainnya', 0],
  ['pendidikan', 'Pendidikan', 'lainnya', 0],
  ['tabungan', 'Tabungan', 'tabungan', 0],
  ['biaya-admin', 'Biaya admin bank', 'lainnya', 0],
  ['lainnya', 'Lainnya', 'lainnya', 0],
  ['groceries', 'Belanja bahan makanan', 'belanja', 0],
  ['hiburan', 'Hiburan', 'lainnya', 0],
  ['fee-profesional', 'Fee profesional', 'bisnis', 0],
  ['bisnis', 'Biaya bisnis', 'bisnis', 0],
];

/** Ikon bawaan supaya daftar kategori mudah dikenali sekilas. Tidak menimpa ikon pilihan pengguna. */
const IKON_KATEGORI: Record<string, string> = {
  makan: '🍚',
  transport: '🚌',
  'kebutuhan-harian': '🧴',
  'langganan-ai': '🤖',
  'langganan-lain': '📺',
  'server-hosting': '🖥️',
  'kredit-api': '🔌',
  'belanja-barang': '🛍️',
  hadiah: '🎁',
  kesehatan: '💊',
  pendidikan: '📚',
  tabungan: '🐷',
  'biaya-admin': '🏦',
  lainnya: '📦',
  groceries: '🛒',
  hiburan: '🎮',
  'fee-profesional': '🧾',
  bisnis: '💼',
};

/**
 * Nilai dari tab PENGATURAN Sheet. Semuanya 'asumsi_sheet' sampai dikonfirmasi.
 * effective_from sengaja jauh ke belakang agar laporan historis punya asumsi.
 */
const ASSUMPTIONS: Array<{ key: string; value: unknown; note: string }> = [
  {
    key: 'anggaran_makan_harian',
    value: 30000,
    note: 'Sheet PENGATURAN: makan Rp30.000/hari. Rencana, bukan realisasi.',
  },
  {
    key: 'cadangan_minimal',
    value: 100000,
    note: 'Sheet PENGATURAN: cadangan minimal Rp100.000.',
  },
  {
    key: 'topup_nominal',
    value: 350000,
    note: 'Sheet TOPUP: rencana top-up Rp350.000 setiap periode.',
  },
  { key: 'topup_interval_hari', value: 5, note: 'Sheet TOPUP: tiap 5 hari.' },
  { key: 'periode_panjang_hari', value: 5, note: 'Sheet PERIODE 5 HARI: blok 5 hari.' },
  {
    key: 'saldo_awal_sheet',
    value: 200000,
    note:
      'Sheet PENGATURAN: saldo awal Rp200.000. BELUM dipakai sebagai saldo bank; ' +
      'perlu dikonfirmasi lewat rekonsiliasi sebelum menjadi titik tambat saldo.',
  },
  {
    key: 'reimburse_lag_hari',
    value: 14,
    note: 'Perkiraan jeda sampai reimburse masuk. Dipakai hanya untuk proyeksi, bukan realisasi.',
  },
  { key: 'target_tabungan_bulanan', value: 0, note: 'Belum ditentukan.' },
];

type ServiceSeed = {
  slug: string;
  name: string;
  vendor: string;
  plan?: string;
  bearer: 'pribadi' | 'company' | 'belum_jelas';
  paid_by: 'saya' | 'company' | 'belum_jelas';
  billing_cycle: 'bulanan' | 'tahunan' | 'sesuai_pemakaian' | 'sekali' | 'belum_jelas';
  amount_minor: number | null;
  currency?: string;
  amount_certainty: 'terverifikasi' | 'perkiraan' | 'asumsi_sheet';
  next_due_date: string | null;
  due_date_certainty: 'terverifikasi' | 'perkiraan' | 'asumsi_sheet';
  status:
    | 'aktif'
    | 'opsional_skenario'
    | 'lunas_periode_ini'
    | 'akan_perpanjang'
    | 'dibatalkan'
    | 'tidak_dilanjutkan'
    | 'perlu_verifikasi'
    | 'kandidat';
  scenario_tag?: string | null;
  cancelled_at?: string | null;
  benefit_period_start?: string | null;
  benefit_period_end?: string | null;
  reserve_for_renewal_minor?: number | null;
  note: string;
};

const SERVICES: ServiceSeed[] = [
  {
    slug: 'chatgpt-plus-pribadi',
    name: 'ChatGPT Plus (pribadi)',
    vendor: 'OpenAI',
    plan: 'Plus',
    bearer: 'pribadi',
    paid_by: 'saya',
    billing_cycle: 'bulanan',
    amount_minor: 349000,
    amount_certainty: 'asumsi_sheet',
    next_due_date: null,
    due_date_certainty: 'asumsi_sheet',
    status: 'perlu_verifikasi',
    note:
      'Sheet memakai Rp349.000 dan tanggal 17 sebagai PERKIRAAN, bukan tagihan terverifikasi. ' +
      'Ada laporan gagal bayar September 2026 — status terbaru harus dicari dari email.',
  },
  {
    slug: 'biznet-gio-pribadi',
    name: 'Biznet Gio (pribadi)',
    vendor: 'Biznet Gio',
    bearer: 'pribadi',
    paid_by: 'saya',
    billing_cycle: 'bulanan',
    amount_minor: 198690,
    amount_certainty: 'perkiraan',
    next_due_date: null,
    due_date_certainty: 'perkiraan',
    status: 'perlu_verifikasi',
    note:
      'Ada bukti pembayaran Rp198.690 pada 21 Oktober 2026. Satu pembayaran TIDAK membuktikan ' +
      'nominal dan tanggal yang berulang setiap bulan; pola harus dikonfirmasi dari beberapa bukti.',
  },
  {
    slug: 'claude-pro-pribadi',
    name: 'Claude Pro (pribadi)',
    vendor: 'Anthropic',
    plan: 'Pro',
    bearer: 'pribadi',
    paid_by: 'saya',
    billing_cycle: 'bulanan',
    amount_minor: 370000,
    amount_certainty: 'asumsi_sheet',
    next_due_date: '2026-11-27',
    due_date_certainty: 'asumsi_sheet',
    status: 'opsional_skenario',
    scenario_tag: 'claude_pro_pribadi',
    note:
      'Perkiraan Sheet Rp370.000 mulai 27 November 2026. Diperlakukan sebagai KEPUTUSAN/SKENARIO ' +
      'sampai ada konfirmasi aktivasi dan penagihan. Tidak memotong saldo di skenario dasar.',
  },
  {
    slug: 'idcloudhost-vps-company',
    name: 'IDCloudHost VPS (company)',
    vendor: 'IDCloudHost',
    bearer: 'company',
    paid_by: 'belum_jelas',
    billing_cycle: 'bulanan',
    amount_minor: 410700,
    amount_certainty: 'perkiraan',
    next_due_date: '2026-11-23',
    due_date_certainty: 'perkiraan',
    status: 'aktif',
    note:
      'Invoice Oktober Rp410.700 dinyatakan lunas; invoice November Rp410.700 jatuh tempo ' +
      '23 November 2026. Untuk SETIAP pembayaran harus ditentukan: company bayar langsung, ' +
      'atau saya menalangi lalu direimburse.',
  },
  {
    slug: 'claude-pro-company',
    name: 'Claude Pro (company)',
    vendor: 'Anthropic',
    plan: 'Pro',
    bearer: 'company',
    paid_by: 'belum_jelas',
    billing_cycle: 'belum_jelas',
    amount_minor: null,
    amount_certainty: 'perkiraan',
    next_due_date: null,
    due_date_certainty: 'perkiraan',
    status: 'perlu_verifikasi',
    note:
      'Nominal dan status terbaru perlu diverifikasi. JANGAN dicampur dengan Claude Pro pribadi — ' +
      'ini layanan terpisah dengan penanggung berbeda.',
  },
  {
    slug: 'google-ai-pro-5tb',
    name: 'Google AI Pro 5 TB',
    vendor: 'Google',
    plan: 'AI Pro 5 TB',
    bearer: 'pribadi',
    paid_by: 'saya',
    billing_cycle: 'belum_jelas',
    amount_minor: null,
    amount_certainty: 'perkiraan',
    next_due_date: null,
    due_date_certainty: 'perkiraan',
    status: 'lunas_periode_ini',
    note:
      'Sheet menyatakan sudah dibayar. Periode manfaat dan tanggal perpanjangan belum diketahui — ' +
      'periode yang sudah dibayar TIDAK boleh ditagih ulang dalam proyeksi.',
  },
  {
    slug: 'tencent-cloud-hermes',
    name: 'Tencent Cloud (Hermes agent)',
    vendor: 'Tencent Cloud',
    bearer: 'pribadi',
    paid_by: 'saya',
    billing_cycle: 'tahunan',
    amount_minor: null,
    amount_certainty: 'perkiraan',
    next_due_date: null,
    due_date_certainty: 'perkiraan',
    status: 'lunas_periode_ini',
    reserve_for_renewal_minor: null,
    note:
      'Dibayar tahunan dan dipakai untuk Hermes agent. Pembayaran tahunan yang sudah lewat TIDAK ' +
      'boleh memotong saldo bulanan. Dana cadangan perpanjangan ditampilkan sebagai rencana terpisah ' +
      'setelah periode dan biayanya diverifikasi.',
  },
  {
    slug: 'cloudflare-pro',
    name: 'Cloudflare Pro',
    vendor: 'Cloudflare',
    plan: 'Pro',
    bearer: 'pribadi',
    paid_by: 'saya',
    billing_cycle: 'bulanan',
    amount_minor: null,
    amount_certainty: 'perkiraan',
    next_due_date: null,
    due_date_certainty: 'perkiraan',
    status: 'dibatalkan',
    note:
      'Dibatalkan. Riwayat biaya disimpan. Bila muncul pembayaran setelah tanggal pembatalan yang ' +
      'dikonfirmasi, sistem memberi peringatan dan meminta pemeriksaan.',
  },
  {
    slug: 'canva-pro',
    name: 'Canva Pro',
    vendor: 'Canva',
    plan: 'Pro',
    bearer: 'pribadi',
    paid_by: 'saya',
    billing_cycle: 'bulanan',
    amount_minor: null,
    amount_certainty: 'perkiraan',
    next_due_date: null,
    due_date_certainty: 'perkiraan',
    status: 'tidak_dilanjutkan',
    note: 'Tidak dilanjutkan. Riwayat biaya disimpan untuk pembanding.',
  },
  {
    slug: 'elevenlabs-starter',
    name: 'ElevenLabs Starter',
    vendor: 'ElevenLabs',
    plan: 'Starter',
    bearer: 'pribadi',
    paid_by: 'saya',
    billing_cycle: 'bulanan',
    amount_minor: null,
    amount_certainty: 'perkiraan',
    next_due_date: null,
    due_date_certainty: 'perkiraan',
    status: 'tidak_dilanjutkan',
    note: 'Tidak dilanjutkan. Riwayat biaya disimpan untuk pembanding.',
  },
  {
    slug: 'openrouter-credits',
    name: 'OpenRouter Credits',
    vendor: 'OpenRouter',
    bearer: 'pribadi',
    paid_by: 'saya',
    billing_cycle: 'sesuai_pemakaian',
    amount_minor: null,
    amount_certainty: 'perkiraan',
    next_due_date: null,
    due_date_certainty: 'perkiraan',
    status: 'aktif',
    note:
      'Pembelian kredit sesuai pemakaian, BUKAN tagihan bulanan tetap. Tidak membuat kewajiban ' +
      'berulang; hanya dicatat saat pembelian benar-benar terjadi.',
  },
];

/** Invoice konkret yang disebut pengguna. Belum ada bukti email yang ditautkan aplikasi. */
const INVOICES: Array<{
  service_slug: string;
  invoice_no: string | null;
  due_date: string;
  period_start: string | null;
  period_end: string | null;
  amount_minor: number;
  status: string;
  paid_by: string;
  reimbursable: number;
  note: string;
}> = [
  {
    service_slug: 'idcloudhost-vps-company',
    invoice_no: null,
    due_date: '2026-10-23',
    period_start: '2026-10-23',
    period_end: '2026-11-22',
    amount_minor: 410700,
    status: 'perlu_verifikasi',
    paid_by: 'belum_jelas',
    reimbursable: 0,
    note:
      'Dinyatakan lunas untuk Oktober. Ditandai perlu_verifikasi sampai bukti email/mutasi ' +
      'ditautkan dan diketahui siapa yang membayar (company langsung atau saya menalangi).',
  },
  {
    service_slug: 'idcloudhost-vps-company',
    invoice_no: null,
    due_date: '2026-11-23',
    period_start: '2026-11-23',
    period_end: '2026-12-22',
    amount_minor: 410700,
    status: 'jatuh_tempo',
    paid_by: 'belum_jelas',
    reimbursable: 0,
    note: 'Jatuh tempo 23 November 2026. Penanggung akhir company; pembayar belum ditentukan.',
  },
  {
    service_slug: 'biznet-gio-pribadi',
    invoice_no: null,
    due_date: '2026-10-21',
    period_start: null,
    period_end: null,
    amount_minor: 198690,
    status: 'perlu_verifikasi',
    paid_by: 'saya',
    reimbursable: 0,
    note:
      'Bukti pembayaran Rp198.690 pada 21 Oktober 2026 disebut pengguna. Perlu ditautkan ke bukti ' +
      'email agar menjadi lunas_terkonfirmasi, dan agar tanggal berulangnya bisa dinilai.',
  },
];

const SCENARIOS: Array<{
  slug: string;
  name: string;
  description: string;
  is_baseline: number;
  enabled_tags: string[];
  overrides: Record<string, unknown>;
}> = [
  {
    slug: 'tanpa-claude-pribadi',
    name: 'Tanpa Claude Pro pribadi',
    description: 'Skenario dasar: hanya biaya yang sudah berjalan, tanpa Claude Pro pribadi.',
    is_baseline: 1,
    enabled_tags: [],
    overrides: {},
  },
  {
    slug: 'dengan-claude-pribadi',
    name: 'Dengan Claude Pro pribadi',
    description: 'Menambahkan Claude Pro pribadi sesuai perkiraan Sheet (Rp370.000 mulai 27 Nov 2026).',
    is_baseline: 0,
    enabled_tags: ['claude_pro_pribadi'],
    overrides: {},
  },
  {
    slug: 'topup-terlambat',
    name: 'Top-up terlambat 3 hari',
    description: 'Semua rencana top-up bergeser 3 hari lebih lambat.',
    is_baseline: 0,
    enabled_tags: [],
    overrides: { topup_geser_hari: 3 },
  },
  {
    slug: 'makan-naik',
    name: 'Biaya makan naik',
    description: 'Anggaran makan harian naik menjadi Rp40.000.',
    is_baseline: 0,
    enabled_tags: [],
    overrides: { anggaran_makan_harian: 40000 },
  },
  {
    slug: 'reimburse-terlambat',
    name: 'Reimburse terlambat',
    description: 'Perkiraan masuknya reimburse mundur 30 hari.',
    is_baseline: 0,
    enabled_tags: [],
    overrides: { reimburse_lag_hari: 30 },
  },
];

const NOTIFICATION_TYPES: Array<[string, string]> = [
  ['transaksi_baru', 'langsung'],
  ['ringkasan_harian', 'harian'],
  ['tagihan_mendekat', 'harian'],
  ['pembayaran_gagal', 'langsung'],
  ['topup_belum_diterima', 'harian'],
  ['saldo_di_bawah_cadangan', 'langsung'],
  ['reimburse_terlambat', 'mingguan'],
  ['langganan_tertagih_lagi', 'langsung'],
  ['pembelian_ganggu_tagihan', 'langsung'],
  ['sinkronisasi_gagal', 'harian'],
  ['anggaran_berisiko', 'harian'],
  ['tujuan_berisiko', 'mingguan'],
];

const MERCHANT_RULES: Array<{
  pattern: string;
  service_slug?: string;
  category: string;
  kind: string;
  auto_approve: number;
}> = [
  { pattern: 'openai', service_slug: 'chatgpt-plus-pribadi', category: 'langganan-ai', kind: 'bayar_langganan', auto_approve: 0 },
  { pattern: 'anthropic', category: 'langganan-ai', kind: 'bayar_langganan', auto_approve: 0 },
  { pattern: 'biznet', service_slug: 'biznet-gio-pribadi', category: 'server-hosting', kind: 'bayar_langganan', auto_approve: 0 },
  { pattern: 'idcloudhost', service_slug: 'idcloudhost-vps-company', category: 'server-hosting', kind: 'bayar_langganan', auto_approve: 0 },
  { pattern: 'tencent', service_slug: 'tencent-cloud-hermes', category: 'server-hosting', kind: 'bayar_langganan', auto_approve: 0 },
  { pattern: 'openrouter', service_slug: 'openrouter-credits', category: 'kredit-api', kind: 'beli_kredit_layanan', auto_approve: 0 },
  { pattern: 'cloudflare', service_slug: 'cloudflare-pro', category: 'server-hosting', kind: 'bayar_langganan', auto_approve: 0 },
  { pattern: 'canva', service_slug: 'canva-pro', category: 'langganan-lain', kind: 'bayar_langganan', auto_approve: 0 },
  { pattern: 'elevenlabs', service_slug: 'elevenlabs-starter', category: 'langganan-ai', kind: 'bayar_langganan', auto_approve: 0 },
  { pattern: 'google', service_slug: 'google-ai-pro-5tb', category: 'langganan-ai', kind: 'bayar_langganan', auto_approve: 0 },
];

export type ProfilSeed = 'bersih' | 'warisan' | 'otomatis';

/**
 * Isi data awal.
 *
 *  - 'bersih'  : instalasi baru tanpa spreadsheet. Hanya kategori, rekening kosong,
 *                pengaturan notifikasi, dan satu rencana dasar. Semua angka diisi pengguna.
 *  - 'warisan' : katalog layanan, tagihan, dan asumsi yang berasal dari Google Sheet lama.
 *  - 'otomatis': database yang sudah berisi layanan/asumsi diperlakukan sebagai 'warisan'
 *                (tidak ada yang berubah); database kosong memakai BUNIH_SEED_PROFILE.
 *
 * Semua penyisipan memakai INSERT OR IGNORE: menjalankan ulang tidak menimpa apa pun.
 */
export function seed(database: DB, opts: { profil?: ProfilSeed } = {}): SeedStats {
  const at = nowIso();
  const profil = opts.profil ?? 'otomatis';
  const sudahAda =
    (
      database
        .prepare(`SELECT (SELECT COUNT(*) FROM service WHERE COALESCE(note,'') NOT LIKE '%[CONTOH]%') + (SELECT COUNT(*) FROM assumption) AS n`)
        .get() as { n: number }
    ).n > 0;
  const warisan =
    profil === 'warisan' || (profil === 'otomatis' && (sudahAda || config.BUNIH_SEED_PROFILE === 'warisan'));
  const stats: SeedStats = {};
  const bump = (k: string, n = 1) => {
    stats[k] = (stats[k] ?? 0) + n;
  };

  const run = database.transaction(() => {
    // Orang
    const insPerson = database.prepare(
      `INSERT OR IGNORE INTO person (kind, name, note, created_at) VALUES (?, ?, ?, ?)`,
    );
    if (insPerson.run('saya', 'Saya', null, at).changes) bump('person');
    if (
      insPerson.run(
        'company',
        'Company',
        'Nama company perlu dikonfirmasi; dipakai untuk klaim reimburse.',
        at,
      ).changes
    )
      bump('person');

    // Kategori
    const insCat = database.prepare(
      `INSERT OR IGNORE INTO category (slug, name, group_name, is_routine, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [slug, name, group, routine] of CATEGORIES) {
      if (insCat.run(slug, name, group, routine, at).changes) bump('category');
    }
    const setIkon = database.prepare(`UPDATE category SET icon = ? WHERE slug = ? AND icon IS NULL`);
    for (const [slug, ikon] of Object.entries(IKON_KATEGORI)) setIkon.run(ikon, slug);

    // Rekening — belum terverifikasi sampai pengguna mengonfirmasi 4 digit terakhir.
    const insAcc = database.prepare(
      `INSERT OR IGNORE INTO account
         (name, bank, last4, kind, currency, is_mine, is_savings_target, verified, note, created_at)
       VALUES (?, ?, NULL, ?, 'IDR', 1, ?, 0, ?, ?)`,
    );
    if (
      insAcc.run(
        "Mandiri Livin'",
        'Mandiri',
        'giro',
        0,
        'Rekening pengeluaran harian. 4 digit terakhir perlu dikonfirmasi sebelum pencocokan email aktif.',
        at,
      ).changes
    )
      bump('account');
    if (
      insAcc.run(
        'BCA',
        'BCA',
        'tabungan',
        1,
        'Rekening penyimpanan/tabungan. Saldo belum dapat diverifikasi sampai ada mutasi atau rekonsiliasi manual.',
        at,
      ).changes
    )
      bump('account');

    const svcId = database.prepare(`SELECT id FROM service WHERE slug = ?`);

    if (warisan) {
      // Asumsi berversi — hanya ditulis bila kunci itu belum pernah ada.
      const hasAssumption = database.prepare(`SELECT 1 FROM assumption WHERE key = ? LIMIT 1`);
      const insAssumption = database.prepare(
        `INSERT INTO assumption (key, value_json, effective_from, effective_to, certainty, source, note, created_at)
         VALUES (?, ?, '1970-01-01', NULL, 'asumsi_sheet', 'sheet', ?, ?)`,
      );
      for (const a of ASSUMPTIONS) {
        if (!hasAssumption.get(a.key)) {
          insAssumption.run(a.key, JSON.stringify(a.value), a.note, at);
          bump('assumption');
        }
      }

      // Katalog layanan
      const insSvc = database.prepare(
        `INSERT OR IGNORE INTO service
          (slug, name, vendor, plan, bearer, paid_by, billing_cycle, amount_minor, currency,
           amount_certainty, next_due_date, due_date_certainty, benefit_period_start, benefit_period_end,
           status, scenario_tag, cancelled_at, reserve_for_renewal_minor, note, created_at, updated_at)
         VALUES (@slug, @name, @vendor, @plan, @bearer, @paid_by, @billing_cycle, @amount_minor, @currency,
           @amount_certainty, @next_due_date, @due_date_certainty, @benefit_period_start, @benefit_period_end,
           @status, @scenario_tag, @cancelled_at, @reserve_for_renewal_minor, @note, @at, @at)`,
      );
      for (const s of SERVICES) {
        const changes = insSvc.run({
          slug: s.slug,
          name: s.name,
          vendor: s.vendor,
          plan: s.plan ?? null,
          bearer: s.bearer,
          paid_by: s.paid_by,
          billing_cycle: s.billing_cycle,
          amount_minor: s.amount_minor,
          currency: s.currency ?? 'IDR',
          amount_certainty: s.amount_certainty,
          next_due_date: s.next_due_date,
          due_date_certainty: s.due_date_certainty,
          benefit_period_start: s.benefit_period_start ?? null,
          benefit_period_end: s.benefit_period_end ?? null,
          status: s.status,
          scenario_tag: s.scenario_tag ?? null,
          cancelled_at: s.cancelled_at ?? null,
          reserve_for_renewal_minor: s.reserve_for_renewal_minor ?? null,
          note: s.note,
          at,
        }).changes;
        if (changes) bump('service');
      }

      // Invoice yang disebut pengguna
      const svcId = database.prepare(`SELECT id FROM service WHERE slug = ?`);
      const insInv = database.prepare(
        `INSERT OR IGNORE INTO invoice
          (service_id, invoice_no, issued_at, due_date, period_start, period_end, amount_minor, currency,
           amount_idr_actual, status, paid_by, reimbursable, dedupe_key, note, created_at, updated_at)
         VALUES (@service_id, @invoice_no, NULL, @due_date, @period_start, @period_end, @amount_minor, 'IDR',
           NULL, @status, @paid_by, @reimbursable, @dedupe_key, @note, @at, @at)`,
      );
      const insStatusEvent = database.prepare(
        `INSERT INTO invoice_status_event (invoice_id, status, occurred_at, evidence_id, note, created_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      );
      for (const inv of INVOICES) {
        const svc = svcId.get(inv.service_slug) as { id: number } | undefined;
        if (!svc) continue;
        const dedupe = `seed:${inv.service_slug}:${inv.due_date}:${inv.amount_minor}`;
        const res = insInv.run({
          service_id: svc.id,
          invoice_no: inv.invoice_no,
          due_date: inv.due_date,
          period_start: inv.period_start,
          period_end: inv.period_end,
          amount_minor: inv.amount_minor,
          status: inv.status,
          paid_by: inv.paid_by,
          reimbursable: inv.reimbursable,
          dedupe_key: dedupe,
          note: inv.note,
          at,
        });
        if (res.changes) {
          bump('invoice');
          insStatusEvent.run(
            Number(res.lastInsertRowid),
            inv.status,
            `${inv.due_date}T00:00:00+07:00`,
            'Dibuat dari seed katalog awal (pernyataan pengguna, belum ada bukti tertaut).',
            at,
          );
        }
      }

      // Skenario
      const insScn = database.prepare(
        `INSERT OR IGNORE INTO scenario
          (slug, name, description, is_baseline, enabled_tags, overrides_json, hidden, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of SCENARIOS) {
        // Skenario khusus Claude warisan Sheet tidak ditampilkan di pengalaman bawaan, sama seperti
        // yang dilakukan migrasi 002 pada database yang sudah berisi. Datanya tetap ada.
        const tersembunyi = s.slug === 'dengan-claude-pribadi' ? 1 : 0;
        if (
          insScn.run(
            s.slug,
            s.name,
            s.description,
            s.is_baseline,
            JSON.stringify(s.enabled_tags),
            JSON.stringify(s.overrides),
            tersembunyi,
            at,
            at,
          ).changes
        )
          bump('scenario');
      }

    }

    // Notifikasi
    const insNotif = database.prepare(
      `INSERT OR IGNORE INTO notification_setting (type, enabled, frequency, updated_at)
       VALUES (?, 1, ?, ?)`,
    );
    for (const [type, freq] of NOTIFICATION_TYPES) {
      if (insNotif.run(type, freq, at).changes) bump('notification_setting');
    }

    if (warisan) {
      // Aturan merchant
      const catId = database.prepare(`SELECT id FROM category WHERE slug = ?`);
      const insRule = database.prepare(
        `INSERT OR IGNORE INTO merchant_rule
          (pattern, category_id, kind, bearer_type, service_id, confidence, auto_approve, created_at)
         VALUES (?, ?, ?, NULL, ?, 0.85, ?, ?)`,
      );
      for (const r of MERCHANT_RULES) {
        const cat = catId.get(r.category) as { id: number } | undefined;
        const svc = r.service_slug ? (svcId.get(r.service_slug) as { id: number } | undefined) : undefined;
        if (insRule.run(r.pattern, cat?.id ?? null, r.kind, svc?.id ?? null, r.auto_approve, at).changes)
          bump('merchant_rule');
      }

    }

    if (!warisan) {
      const adaDasar = database.prepare(`SELECT 1 FROM scenario WHERE is_baseline = 1 LIMIT 1`).get();
      if (!adaDasar) {
        database
          .prepare(
            `INSERT OR IGNORE INTO scenario
              (slug, name, description, is_baseline, enabled_tags, overrides_json, created_at, updated_at)
             VALUES ('dasar', 'Rencana dasar', 'Rencana berdasarkan data dan pengaturanmu saat ini.', 1, '[]', '{}', ?, ?)`,
          )
          .run(at, at);
        bump('scenario');
      }
    }

    // Keadaan Gmail (singleton)
    if (
      database
        .prepare(
          `INSERT OR IGNORE INTO gmail_state (id, history_id, initial_done, updated_at)
           VALUES (1, NULL, 0, ?)`,
        )
        .run(at).changes
    )
      bump('gmail_state');
  });

  run();
  return stats;
}
