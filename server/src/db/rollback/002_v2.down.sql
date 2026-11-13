-- Membatalkan 002_v2. Menghapus HANYA yang ditambahkan oleh 002_v2.
-- Semua tabel dan baris asli (transaksi, alokasi, bukti, piutang, layanan, ...) tetap utuh.
--
-- Cara paling aman tetap memulihkan dari cadangan (deploy/scripts/pulihkan.sh).
-- Skrip ini untuk kasus ketika cadangan tidak dipakai. Jalankan setelah menghentikan aplikasi:
--   sqlite3 /data/bunih.sqlite < server/src/db/rollback/002_v2.down.sql

DROP INDEX IF EXISTS idx_cash_event_merchant;
ALTER TABLE cash_event DROP COLUMN merchant_id;
ALTER TABLE cash_event DROP COLUMN project;

DROP TABLE IF EXISTS goal_contribution;
DROP TABLE IF EXISTS goal;
DROP TABLE IF EXISTS budget_revision;
DROP TABLE IF EXISTS budget;
DROP TABLE IF EXISTS merchant_alias;
DROP TABLE IF EXISTS merchant;
DROP TABLE IF EXISTS app_setting;

DROP INDEX IF EXISTS idx_category_parent;
ALTER TABLE category DROP COLUMN parent_id;
ALTER TABLE category DROP COLUMN active;
ALTER TABLE category DROP COLUMN sort_order;
ALTER TABLE category DROP COLUMN icon;

ALTER TABLE scenario DROP COLUMN hidden;

DELETE FROM _migration WHERE name = '002_v2.sql';
