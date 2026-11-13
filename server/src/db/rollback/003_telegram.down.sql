-- Membatalkan 003_telegram. Hanya menghapus yang ditambahkan oleh 003; data keuangan tidak tersentuh.
-- Jalankan setelah aplikasi dihentikan:
--   sqlite3 /data/bunih.sqlite < server/src/db/rollback/003_telegram.down.sql
DROP INDEX IF EXISTS idx_tg_message_transaksi;
DROP TABLE IF EXISTS tg_callback_seen;
DROP TABLE IF EXISTS tg_message;
DROP TABLE IF EXISTS tg_state;
ALTER TABLE category DROP COLUMN merged_into;
DELETE FROM _migration WHERE name = '003_telegram.sql';
