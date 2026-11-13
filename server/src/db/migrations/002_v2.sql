-- BUnih 002_v2 — kategori fleksibel, merchant, anggaran, tujuan keuangan.
--
-- ADITIF: tidak ada tabel atau kolom lama yang dihapus atau diubah artinya, dan
-- tidak ada baris lama yang dihapus. Data produksi tetap utuh.
--
-- Kolom baru pada tabel lama sengaja TANPA klausa REFERENCES (integritas dijaga di kode)
-- supaya migrasi ini dapat dibatalkan bersih lewat rollback/002_v2.down.sql.

-- ---------------------------------------------------------------------------
-- Kategori: bertingkat, dapat dinonaktifkan, dapat diurutkan
-- ---------------------------------------------------------------------------
ALTER TABLE category ADD COLUMN parent_id INTEGER;
ALTER TABLE category ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE category ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE category ADD COLUMN icon TEXT;
CREATE INDEX idx_category_parent ON category(parent_id);

-- ---------------------------------------------------------------------------
-- Merchant: nama kanonik + alias
-- ---------------------------------------------------------------------------
CREATE TABLE merchant (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  name_norm           TEXT NOT NULL UNIQUE,
  default_category_id INTEGER REFERENCES category(id),
  note                TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE merchant_alias (
  id           INTEGER PRIMARY KEY,
  merchant_id  INTEGER NOT NULL REFERENCES merchant(id) ON DELETE CASCADE,
  alias_norm   TEXT NOT NULL UNIQUE,
  alias_raw    TEXT,
  source       TEXT NOT NULL CHECK (source IN ('manual','otomatis','gabungan')),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_merchant_alias_merchant ON merchant_alias(merchant_id);

ALTER TABLE cash_event ADD COLUMN merchant_id INTEGER;
ALTER TABLE cash_event ADD COLUMN project TEXT;
CREATE INDEX idx_cash_event_merchant ON cash_event(merchant_id);

-- Isi ulang dari data yang sudah ada. Pencocokan HANYA pada nama ternormalisasi yang
-- persis sama; merchant yang namanya sekadar mirip tidak digabung.
INSERT INTO merchant (name, name_norm, created_at, updated_at)
SELECT MIN(merchant_raw), merchant_norm,
       strftime('%Y-%m-%dT%H:%M:%S','now','+7 hours') || '+07:00',
       strftime('%Y-%m-%dT%H:%M:%S','now','+7 hours') || '+07:00'
  FROM cash_event
 WHERE merchant_norm IS NOT NULL AND merchant_norm <> ''
 GROUP BY merchant_norm;

INSERT INTO merchant_alias (merchant_id, alias_norm, alias_raw, source, created_at)
SELECT id, name_norm, name, 'otomatis',
       strftime('%Y-%m-%dT%H:%M:%S','now','+7 hours') || '+07:00'
  FROM merchant;

UPDATE cash_event
   SET merchant_id = (SELECT m.id FROM merchant m WHERE m.name_norm = cash_event.merchant_norm)
 WHERE merchant_norm IS NOT NULL AND merchant_norm <> '';

-- ---------------------------------------------------------------------------
-- Anggaran fleksibel
-- ---------------------------------------------------------------------------
CREATE TABLE budget (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  category_id   INTEGER REFERENCES category(id),       -- NULL = batas pengeluaran keseluruhan
  period        TEXT NOT NULL CHECK (period IN ('harian','mingguan','bulanan','kustom')),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),  -- nominal awal; perubahan lewat budget_revision
  start_date    TEXT NOT NULL,
  end_date      TEXT,                                   -- wajib untuk 'kustom'
  recurring     INTEGER NOT NULL DEFAULT 1,
  rollover      INTEGER NOT NULL DEFAULT 0,             -- sisa periode lalu dibawa ke periode ini
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_budget_category ON budget(category_id);

-- Mengubah nominal anggaran tidak menimpa masa lalu: setiap perubahan punya tanggal berlaku.
CREATE TABLE budget_revision (
  id             INTEGER PRIMARY KEY,
  budget_id      INTEGER NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  effective_from TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_budget_revision ON budget_revision(budget_id, effective_from);

-- ---------------------------------------------------------------------------
-- Tujuan keuangan
-- ---------------------------------------------------------------------------
CREATE TABLE goal (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  target_minor INTEGER NOT NULL CHECK (target_minor > 0),
  start_minor  INTEGER NOT NULL DEFAULT 0 CHECK (start_minor >= 0),
  target_date  TEXT,
  account_id   INTEGER REFERENCES account(id),
  status       TEXT NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif','dijeda','tercapai','dibatalkan')),
  reminder     INTEGER NOT NULL DEFAULT 1,
  icon         TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Menyisihkan uang untuk tujuan BUKAN perpindahan uang. 'disisihkan' hanyalah penandaan;
-- 'transfer_tercatat' menunjuk transfer tabungan sungguhan (cash_event).
CREATE TABLE goal_contribution (
  id            INTEGER PRIMARY KEY,
  goal_id       INTEGER NOT NULL REFERENCES goal(id) ON DELETE CASCADE,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor <> 0),   -- negatif = mengambil kembali
  kind          TEXT NOT NULL CHECK (kind IN ('disisihkan','transfer_tercatat')),
  occurred_on   TEXT NOT NULL,
  cash_event_id INTEGER REFERENCES cash_event(id) ON DELETE SET NULL,
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_goal_contribution ON goal_contribution(goal_id, occurred_on);

-- ---------------------------------------------------------------------------
-- Pengaturan aplikasi umum (onboarding, preferensi)
-- ---------------------------------------------------------------------------
CREATE TABLE app_setting (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Skenario dapat disembunyikan dari pengalaman bawaan tanpa dihapus
-- ---------------------------------------------------------------------------
ALTER TABLE scenario ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
UPDATE scenario SET hidden = 1 WHERE slug = 'dengan-claude-pribadi';
