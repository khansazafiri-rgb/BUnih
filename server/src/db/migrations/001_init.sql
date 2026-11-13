-- BUnih 001_init
-- Semua nominal disimpan sebagai INTEGER dalam satuan terkecil (minor unit).
-- IDR: 1 minor = Rp1. USD: 1 minor = 1 cent. Lihat server/src/domain/money.ts.
-- Semua tanggal "YYYY-MM-DD" dan waktu "YYYY-MM-DDTHH:mm:ss+07:00" memakai zona Asia/Jakarta.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Referensi dasar
-- ---------------------------------------------------------------------------

CREATE TABLE person (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('saya','teman','company','lainnya')),
  name          TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (kind, name)
);

CREATE TABLE account (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  bank                TEXT NOT NULL,
  last4               TEXT,                     -- hanya 4 digit terakhir yang boleh tampil di UI
  number_fingerprint  TEXT,                     -- hash nomor rekening penuh, untuk pencocokan email
  kind                TEXT NOT NULL CHECK (kind IN ('giro','tabungan','ewallet','kartu','company','virtual')),
  currency            TEXT NOT NULL DEFAULT 'IDR',
  is_mine             INTEGER NOT NULL DEFAULT 1,
  owner_person_id     INTEGER REFERENCES person(id),
  is_savings_target   INTEGER NOT NULL DEFAULT 0, -- BCA = tujuan setoran tabungan
  verified            INTEGER NOT NULL DEFAULT 0, -- sudah dikonfirmasi pemilik aplikasi
  active              INTEGER NOT NULL DEFAULT 1,
  note                TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE category (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  group_name    TEXT NOT NULL,                  -- makan | transport | langganan | server | belanja | lainnya
  is_routine    INTEGER NOT NULL DEFAULT 0,     -- dipakai mesin proyeksi untuk anggaran harian
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Asumsi berversi (tab PENGATURAN)
-- ---------------------------------------------------------------------------

CREATE TABLE assumption (
  id              INTEGER PRIMARY KEY,
  key             TEXT NOT NULL,
  value_json      TEXT NOT NULL,
  effective_from  TEXT NOT NULL,                -- YYYY-MM-DD
  effective_to    TEXT,                         -- NULL = masih berlaku
  certainty       TEXT NOT NULL CHECK (certainty IN ('terverifikasi','perkiraan','asumsi_sheet')),
  source          TEXT NOT NULL CHECK (source IN ('sheet','manual','gmail','kalkulasi','bawaan')),
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_assumption_key ON assumption(key, effective_from);

-- ---------------------------------------------------------------------------
-- Bukti (sumber data) — satu peristiwa keuangan boleh punya banyak bukti
-- ---------------------------------------------------------------------------

CREATE TABLE evidence (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL CHECK (source IN ('gmail','telegram','manual','csv','pdf','sheet')),
  external_id     TEXT,                         -- gmail message id, nama file, dsb.
  kind            TEXT NOT NULL CHECK (kind IN (
                    'notifikasi_bank','invoice','kuitansi','gagal_bayar','pembatalan',
                    'perpanjangan','refund','mutasi_rekening','foto_kuitansi','catatan_manual','baris_sheet'
                  )),
  received_at     TEXT NOT NULL,
  from_email      TEXT,
  subject         TEXT,                         -- disimpan apa adanya; TIDAK pernah ditulis ke log
  permalink       TEXT,                         -- tautan buka di Gmail / berkas
  body_hash       TEXT NOT NULL,                -- sha256 isi ternormalisasi, untuk idempotensi
  parsed_json     TEXT,                          -- hasil ekstraksi parser
  parser          TEXT,
  confidence      REAL NOT NULL DEFAULT 0,
  is_promo        INTEGER NOT NULL DEFAULT 0,
  needs_review    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE (source, body_hash)
);
CREATE INDEX idx_evidence_external ON evidence(source, external_id);
CREATE INDEX idx_evidence_received ON evidence(received_at);

-- ---------------------------------------------------------------------------
-- Layanan & tagihan (tab LANGGANAN)
-- ---------------------------------------------------------------------------

CREATE TABLE service (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  vendor              TEXT NOT NULL,
  plan                TEXT,
  bearer              TEXT NOT NULL CHECK (bearer IN ('pribadi','company','belum_jelas')),
  paid_by             TEXT NOT NULL DEFAULT 'belum_jelas'
                        CHECK (paid_by IN ('saya','company','belum_jelas')),
  billing_cycle       TEXT NOT NULL CHECK (billing_cycle IN ('bulanan','tahunan','sesuai_pemakaian','sekali','belum_jelas')),
  amount_minor        INTEGER,                  -- NULL = belum diketahui
  currency            TEXT NOT NULL DEFAULT 'IDR',
  amount_certainty    TEXT NOT NULL DEFAULT 'asumsi_sheet'
                        CHECK (amount_certainty IN ('terverifikasi','perkiraan','asumsi_sheet')),
  next_due_date       TEXT,
  due_date_certainty  TEXT NOT NULL DEFAULT 'asumsi_sheet'
                        CHECK (due_date_certainty IN ('terverifikasi','perkiraan','asumsi_sheet')),
  benefit_period_start TEXT,
  benefit_period_end   TEXT,                    -- untuk layanan yang sudah dibayar di muka
  status              TEXT NOT NULL CHECK (status IN (
                        'aktif','opsional_skenario','lunas_periode_ini','akan_perpanjang',
                        'dibatalkan','tidak_dilanjutkan','perlu_verifikasi','kandidat'
                      )),
  scenario_tag        TEXT,                     -- mis. 'claude_pro_pribadi' -> hanya aktif di skenario tertentu
  cancelled_at        TEXT,
  reserve_for_renewal_minor INTEGER,            -- dana cadangan perpanjangan (tahunan), rencana terpisah
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE invoice (
  id                    INTEGER PRIMARY KEY,
  service_id            INTEGER REFERENCES service(id),
  invoice_no            TEXT,
  issued_at             TEXT,
  due_date              TEXT,
  period_start          TEXT,
  period_end            TEXT,
  amount_minor          INTEGER,                -- nominal pada invoice (mata uang asli)
  currency              TEXT NOT NULL DEFAULT 'IDR',
  amount_idr_actual     INTEGER,                -- rupiah aktual saat didebit, hanya bila ada buktinya
  status                TEXT NOT NULL CHECK (status IN (
                          'tagihan_baru','jatuh_tempo','pembayaran_terdeteksi','lunas_terkonfirmasi',
                          'gagal_bayar','refund','dibatalkan','perlu_verifikasi'
                        )),
  paid_by               TEXT NOT NULL DEFAULT 'belum_jelas'
                          CHECK (paid_by IN ('saya','company','belum_jelas')),
  reimbursable          INTEGER NOT NULL DEFAULT 0,
  dedupe_key            TEXT NOT NULL UNIQUE,
  note                  TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_invoice_due ON invoice(due_date);
CREATE INDEX idx_invoice_service ON invoice(service_id);

CREATE TABLE invoice_evidence (
  invoice_id   INTEGER NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  evidence_id  INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('invoice','kuitansi','gagal_bayar','pembatalan','refund','lainnya')),
  PRIMARY KEY (invoice_id, evidence_id, role)
);

-- Riwayat perubahan status tagihan: status akhir mengikuti urutan peristiwa.
CREATE TABLE invoice_status_event (
  id            INTEGER PRIMARY KEY,
  invoice_id    INTEGER NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  evidence_id   INTEGER REFERENCES evidence(id),
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_invoice_status_event ON invoice_status_event(invoice_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Kas aktual: satu baris = satu perpindahan uang yang benar-benar terjadi
-- ---------------------------------------------------------------------------

CREATE TABLE cash_event (
  id                INTEGER PRIMARY KEY,
  occurred_at       TEXT NOT NULL,              -- waktu Asia/Jakarta
  direction         TEXT NOT NULL CHECK (direction IN ('masuk','keluar')),
  amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
  currency          TEXT NOT NULL DEFAULT 'IDR',
  account_id        INTEGER REFERENCES account(id),  -- NULL = tidak lewat rekening saya (company bayar langsung / tunai)
  is_cash           INTEGER NOT NULL DEFAULT 0,
  kind              TEXT NOT NULL CHECK (kind IN (
                      'pemasukan_luar','pengeluaran_pribadi','pengeluaran_company_langsung',
                      'pengeluaran_reimburse_company','pengeluaran_bersama','hadiah','talangan',
                      'transfer_internal','setoran_tabungan','penarikan_tabungan',
                      'beli_kredit_layanan','bayar_langganan','refund','koreksi','belum_dikategorikan'
                    )),
  merchant_raw      TEXT,
  merchant_norm     TEXT,
  counterparty      TEXT,
  reference_no      TEXT,
  status            TEXT NOT NULL DEFAULT 'terkonfirmasi' CHECK (status IN (
                      'terkonfirmasi','menunggu_pasangan','perlu_verifikasi','dibatalkan'
                    )),
  certainty         TEXT NOT NULL DEFAULT 'terverifikasi'
                      CHECK (certainty IN ('terverifikasi','perkiraan','asumsi_sheet')),
  transfer_group_id TEXT,                       -- dua sisi transfer internal berbagi id ini
  service_id        INTEGER REFERENCES service(id),
  invoice_id        INTEGER REFERENCES invoice(id),
  category_id       INTEGER REFERENCES category(id),
  obligation_id     INTEGER,                    -- rencana yang direalisasikan (FK lunak, lihat obligation)
  source            TEXT NOT NULL CHECK (source IN ('gmail','telegram','manual','csv','pdf','sheet')),
  dedupe_key        TEXT NOT NULL UNIQUE,
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_cash_event_occurred ON cash_event(occurred_at);
CREATE INDEX idx_cash_event_account ON cash_event(account_id, occurred_at);
CREATE INDEX idx_cash_event_group ON cash_event(transfer_group_id);
CREATE INDEX idx_cash_event_kind ON cash_event(kind);

CREATE TABLE cash_event_evidence (
  cash_event_id  INTEGER NOT NULL REFERENCES cash_event(id) ON DELETE CASCADE,
  evidence_id    INTEGER NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('notifikasi_bank','kuitansi','mutasi','foto','manual','lainnya')),
  PRIMARY KEY (cash_event_id, evidence_id, role)
);

-- Pembagian satu transaksi menjadi beberapa kategori / penanggung.
-- Jumlah seluruh alokasi WAJIB sama dengan amount_minor induknya (diuji di tes).
CREATE TABLE allocation (
  id              INTEGER PRIMARY KEY,
  cash_event_id   INTEGER NOT NULL REFERENCES cash_event(id) ON DELETE CASCADE,
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  purpose         TEXT NOT NULL CHECK (purpose IN (
                    'biaya_pribadi','piutang_teman','piutang_company','biaya_company_langsung',
                    'transfer_internal','tabungan','kredit_layanan','pelunasan_piutang',
                    'pemasukan','refund','penyesuaian'
                  )),
  bearer_type     TEXT NOT NULL CHECK (bearer_type IN ('saya','teman','company','lainnya')),
  bearer_person_id INTEGER REFERENCES person(id),
  category_id     INTEGER REFERENCES category(id),
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_allocation_event ON allocation(cash_event_id);
CREATE INDEX idx_allocation_purpose ON allocation(purpose);

-- ---------------------------------------------------------------------------
-- Piutang (reimburse teman & company, talangan)
-- ---------------------------------------------------------------------------

CREATE TABLE receivable (
  id                  INTEGER PRIMARY KEY,
  allocation_id       INTEGER REFERENCES allocation(id) ON DELETE SET NULL,
  debtor_type         TEXT NOT NULL CHECK (debtor_type IN ('teman','company','lainnya')),
  debtor_person_id    INTEGER REFERENCES person(id),
  origin_amount_minor INTEGER NOT NULL CHECK (origin_amount_minor > 0),
  settled_minor       INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'IDR',
  occurred_on         TEXT NOT NULL,
  claimed_at          TEXT,
  expected_on         TEXT,
  status              TEXT NOT NULL CHECK (status IN ('belum_diklaim','diklaim','sebagian','lunas','dihapuskan')),
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_receivable_status ON receivable(status);

CREATE TABLE receivable_settlement (
  id              INTEGER PRIMARY KEY,
  receivable_id   INTEGER NOT NULL REFERENCES receivable(id) ON DELETE CASCADE,
  cash_event_id   INTEGER REFERENCES cash_event(id) ON DELETE SET NULL,
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  settled_on      TEXT NOT NULL,
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_rsettle_receivable ON receivable_settlement(receivable_id);

-- ---------------------------------------------------------------------------
-- Rencana (proyeksi) — uang yang BELUM keluar/masuk
-- ---------------------------------------------------------------------------

CREATE TABLE obligation (
  id                  INTEGER PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'langganan','tagihan','belanja_rencana','makan_rencana','cadangan_perpanjangan','lainnya'
                      )),
  due_date            TEXT NOT NULL,
  amount_minor        INTEGER,                  -- NULL = harga belum diketahui (risiko belum terhitung)
  currency            TEXT NOT NULL DEFAULT 'IDR',
  amount_certainty    TEXT NOT NULL DEFAULT 'perkiraan'
                        CHECK (amount_certainty IN ('terverifikasi','perkiraan','asumsi_sheet')),
  bearer              TEXT NOT NULL DEFAULT 'pribadi' CHECK (bearer IN ('pribadi','company','belum_jelas')),
  paid_by             TEXT NOT NULL DEFAULT 'saya' CHECK (paid_by IN ('saya','company','belum_jelas')),
  affects_my_cash     INTEGER NOT NULL DEFAULT 1, -- 0 bila company bayar langsung
  account_id          INTEGER REFERENCES account(id),
  service_id          INTEGER REFERENCES service(id),
  invoice_id          INTEGER REFERENCES invoice(id),
  purchase_id         INTEGER,
  scenario_tag        TEXT,                     -- hanya dihitung bila skenario mengaktifkan tag ini
  status              TEXT NOT NULL DEFAULT 'rencana'
                        CHECK (status IN ('rencana','terealisasi','dibatalkan','kedaluwarsa')),
  realized_cash_event_id INTEGER REFERENCES cash_event(id) ON DELETE SET NULL,
  label               TEXT NOT NULL,
  generation_key      TEXT NOT NULL UNIQUE,     -- membuat regenerasi idempoten
  generated_from      TEXT NOT NULL CHECK (generated_from IN ('service','invoice','purchase','assumption','manual')),
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_obligation_due ON obligation(due_date, status);
CREATE INDEX idx_obligation_scenario ON obligation(scenario_tag);

-- Tab TOPUP: pasangan rencana & aktual
CREATE TABLE topup_plan (
  id                  INTEGER PRIMARY KEY,
  plan_date           TEXT NOT NULL,
  plan_amount_minor   INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'IDR',
  account_id          INTEGER REFERENCES account(id),
  source_label        TEXT,                     -- dari siapa / dari mana
  status              TEXT NOT NULL DEFAULT 'rencana' CHECK (status IN (
                        'rencana','diterima','sebagian','tidak_diterima','dibatalkan'
                      )),
  actual_amount_minor INTEGER,
  actual_date         TEXT,
  cash_event_id       INTEGER REFERENCES cash_event(id) ON DELETE SET NULL,
  generation_key      TEXT NOT NULL UNIQUE,
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_topup_date ON topup_plan(plan_date);

-- Tab BELANJA
CREATE TABLE purchase (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  qty                 REAL NOT NULL DEFAULT 1,
  unit_price_minor    INTEGER,
  total_minor         INTEGER,                  -- NULL bila harga belum diketahui
  price_unknown       INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'IDR',
  planned             INTEGER NOT NULL DEFAULT 1, -- 0 = mendadak
  wanted_on           TEXT,
  occurred_on         TEXT,
  category_id         INTEGER REFERENCES category(id),
  owner_person_id     INTEGER REFERENCES person(id),  -- siapa pemilik barang
  final_bearer        TEXT NOT NULL DEFAULT 'saya'
                        CHECK (final_bearer IN ('saya','teman','company','bersama','belum_jelas')),
  payment_status      TEXT NOT NULL DEFAULT 'belum_dibayar'
                        CHECK (payment_status IN ('belum_dibayar','dibayar','sebagian','dibatalkan')),
  cash_event_id       INTEGER REFERENCES cash_event(id) ON DELETE SET NULL,
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Skenario simulasi
-- ---------------------------------------------------------------------------

CREATE TABLE scenario (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  is_baseline     INTEGER NOT NULL DEFAULT 0,
  enabled_tags    TEXT NOT NULL DEFAULT '[]',   -- JSON array scenario_tag yang diaktifkan
  overrides_json  TEXT NOT NULL DEFAULT '{}',   -- override asumsi: makan harian, topup, dll.
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Rekonsiliasi saldo (Gmail tidak memuat semua mutasi)
-- ---------------------------------------------------------------------------

CREATE TABLE reconciliation (
  id                      INTEGER PRIMARY KEY,
  account_id              INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  as_of                   TEXT NOT NULL,         -- waktu saldo ini benar
  statement_balance_minor INTEGER NOT NULL,
  source                  TEXT NOT NULL CHECK (source IN ('manual','csv','pdf','gmail','telegram')),
  evidence_id             INTEGER REFERENCES evidence(id),
  note                    TEXT,
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_recon_account ON reconciliation(account_id, as_of);

-- ---------------------------------------------------------------------------
-- Impor
-- ---------------------------------------------------------------------------

CREATE TABLE import_run (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('sheet','mutasi_csv','mutasi_pdf','gmail')),
  label         TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  stats_json    TEXT,
  status        TEXT NOT NULL DEFAULT 'jalan' CHECK (status IN ('jalan','selesai','gagal')),
  error         TEXT
);

CREATE TABLE import_item (
  id              INTEGER PRIMARY KEY,
  import_run_id   INTEGER NOT NULL REFERENCES import_run(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  row_key         TEXT NOT NULL,                -- stabil: tab + baris + hash isi
  entity          TEXT,                         -- tabel tujuan
  entity_id       INTEGER,
  action          TEXT NOT NULL CHECK (action IN ('buat','perbarui','lewati','tidak_jelas')),
  reason          TEXT,
  payload_json    TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (source, row_key)
);

-- ---------------------------------------------------------------------------
-- Integrasi
-- ---------------------------------------------------------------------------

CREATE TABLE oauth_token (
  id              INTEGER PRIMARY KEY,
  provider        TEXT NOT NULL UNIQUE CHECK (provider IN ('google')),
  account_email   TEXT,
  scopes          TEXT NOT NULL,
  payload_enc     TEXT NOT NULL,                -- terenkripsi dengan BUNIH_SECRET_KEY
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE gmail_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  history_id          TEXT,
  last_full_sync_at   TEXT,
  last_sync_at        TEXT,
  last_error          TEXT,
  initial_range_start TEXT,
  initial_done        INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL
);

CREATE TABLE telegram_user (
  id            INTEGER PRIMARY KEY,
  chat_id       TEXT NOT NULL UNIQUE,
  username      TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  verify_code   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE merchant_rule (
  id              INTEGER PRIMARY KEY,
  pattern         TEXT NOT NULL,                -- dicocokkan ke merchant_norm (substring, huruf kecil)
  category_id     INTEGER REFERENCES category(id),
  kind            TEXT,
  bearer_type     TEXT,
  service_id      INTEGER REFERENCES service(id),
  confidence      REAL NOT NULL DEFAULT 0.9,
  auto_approve    INTEGER NOT NULL DEFAULT 0,   -- 1 = boleh dikelompokkan otomatis tanpa tanya
  hit_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE (pattern)
);

-- ---------------------------------------------------------------------------
-- Keputusan & notifikasi
-- ---------------------------------------------------------------------------

CREATE TABLE pending_decision (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'kategori_transaksi','jenis_pembelian','bagi_biaya','reimburse','pasangan_transfer',
                    'konfirmasi_topup','verifikasi_langganan','harga_belanja','konfirmasi_kuitansi','asumsi_awal'
                  )),
  cash_event_id   INTEGER REFERENCES cash_event(id) ON DELETE CASCADE,
  invoice_id      INTEGER REFERENCES invoice(id) ON DELETE CASCADE,
  service_id      INTEGER REFERENCES service(id) ON DELETE CASCADE,
  topup_plan_id   INTEGER REFERENCES topup_plan(id) ON DELETE CASCADE,
  purchase_id     INTEGER REFERENCES purchase(id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  options_json    TEXT NOT NULL DEFAULT '[]',
  state           TEXT NOT NULL DEFAULT 'terbuka' CHECK (state IN ('terbuka','terkirim','dijawab','kedaluwarsa','dibatalkan')),
  priority        INTEGER NOT NULL DEFAULT 5,
  telegram_message_id TEXT,
  answer_json     TEXT,
  dedupe_key      TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  answered_at     TEXT
);
CREATE INDEX idx_pending_state ON pending_decision(state, priority);

CREATE TABLE notification_setting (
  id            INTEGER PRIMARY KEY,
  type          TEXT NOT NULL UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  frequency     TEXT NOT NULL DEFAULT 'harian' CHECK (frequency IN ('langsung','harian','mingguan','mati')),
  quiet_from    TEXT,                          -- HH:mm
  quiet_to      TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE notification_log (
  id            INTEGER PRIMARY KEY,
  type          TEXT NOT NULL,
  dedupe_key    TEXT NOT NULL,
  sent_at       TEXT NOT NULL,
  payload_json  TEXT,
  UNIQUE (type, dedupe_key)
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  entity        TEXT NOT NULL,
  entity_id     INTEGER,
  action        TEXT NOT NULL,
  actor         TEXT NOT NULL,                 -- 'web' | 'telegram' | 'gmail-sync' | 'importer' | 'scheduler'
  before_json   TEXT,
  after_json    TEXT,
  reason        TEXT,
  at            TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id, at);
