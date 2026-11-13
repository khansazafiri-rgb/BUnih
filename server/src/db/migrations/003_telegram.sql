-- 003: Telegram-first. Aditif: hanya menambah tabel/kolom, tidak mengubah atau menghapus data yang ada.

-- Status percakapan yang bertahan setelah restart. Satu baris per (chat, slot).
CREATE TABLE tg_state (
  chat_id     TEXT NOT NULL,
  slot        TEXT NOT NULL DEFAULT 'utama',
  state_json  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (chat_id, slot)
);

-- Setiap pesan interaktif yang dikirim bot. Callback data hanya membawa id baris ini,
-- sehingga tombol pada pesan lama bisa dikenali sudah selesai dan tidak mengubah apa pun.
CREATE TABLE tg_message (
  id             INTEGER PRIMARY KEY,
  chat_id        TEXT NOT NULL,
  message_id     TEXT,
  kind           TEXT NOT NULL,
  cash_event_id  INTEGER,
  decision_id    INTEGER,
  state          TEXT NOT NULL DEFAULT 'aktif' CHECK (state IN ('aktif','selesai','kedaluwarsa')),
  outcome        TEXT,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);
-- Satu notifikasi transaksi per transaksi: mencegah notifikasi ganda.
CREATE UNIQUE INDEX idx_tg_message_transaksi ON tg_message(cash_event_id) WHERE kind = 'transaksi';

-- Callback yang sudah diproses (Telegram dapat mengirim ulang atau pengguna menekan dua kali).
CREATE TABLE tg_callback_seen (
  callback_id  TEXT PRIMARY KEY,
  seen_at      TEXT NOT NULL
);

-- Kategori yang digabung ke kategori lain tetap ada (riwayat), hanya nonaktif dan menunjuk tujuan gabungan.
ALTER TABLE category ADD COLUMN merged_into INTEGER;
