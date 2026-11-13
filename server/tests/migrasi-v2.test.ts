import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, migrationsDir } from '../src/db/migrate.js';

/** Database yang hanya memiliki migrasi 001, berisi data sintetis seperti produksi lama. */
function dbLama() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunih-mig-'));
  fs.copyFileSync(path.join(migrationsDir(), '001_init.sql'), path.join(dir, '001_init.sql'));
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  migrate(database, dir);

  const at = '2026-10-01T00:00:00+07:00';
  database
    .prepare(`INSERT INTO account (name, bank, kind, created_at) VALUES ('Rekening Uji', 'BankUji', 'giro', ?)`)
    .run(at);
  database
    .prepare(`INSERT INTO category (slug, name, group_name, is_routine, created_at) VALUES ('makan','Makan','makan',1,?)`)
    .run(at);
  const ins = database.prepare(
    `INSERT INTO cash_event (occurred_at, direction, amount_minor, kind, merchant_raw, merchant_norm, account_id,
        category_id, source, dedupe_key, created_at, updated_at)
     VALUES (?, 'keluar', ?, 'pengeluaran_pribadi', ?, ?, 1, 1, 'manual', ?, ?, ?)`,
  );
  ins.run('2026-10-02T12:00:00+07:00', 25_000, 'Kantin Kampus', 'kantin kampus', 'k1', at, at);
  ins.run('2026-10-03T12:00:00+07:00', 27_000, 'KANTIN KAMPUS', 'kantin kampus', 'k2', at, at);
  ins.run('2026-10-04T12:00:00+07:00', 40_000, 'Warung Bu Sri', 'warung bu sri', 'k3', at, at);
  ins.run('2026-10-05T12:00:00+07:00', 41_000, 'Warung Sri', 'warung sri', 'k4', at, at);
  database
    .prepare(`INSERT INTO scenario (slug, name, is_baseline, enabled_tags, overrides_json, created_at, updated_at)
              VALUES ('tanpa-claude-pribadi','Dasar',1,'[]','{}',?,?), ('dengan-claude-pribadi','Claude',0,'["claude_pro_pribadi"]','{}',?,?)`)
    .run(at, at, at, at);
  return { database, dir };
}

describe('migrasi 002_v2', () => {
  it('menambah struktur baru tanpa mengubah atau menghapus data lama', () => {
    const { database } = dbLama();
    const sebelum = database.prepare(`SELECT id, amount_minor, merchant_raw, category_id FROM cash_event ORDER BY id`).all();

    const diterapkan = migrate(database);
    expect(diterapkan).toContain('002_v2.sql');

    const sesudah = database.prepare(`SELECT id, amount_minor, merchant_raw, category_id FROM cash_event ORDER BY id`).all();
    expect(sesudah).toEqual(sebelum);
    expect((database.prepare(`SELECT COUNT(*) AS n FROM account`).get() as { n: number }).n).toBe(1);
  });

  it('mengisi merchant dari nama yang persis sama, dan TIDAK menggabungkan nama yang hanya mirip', () => {
    const { database } = dbLama();
    migrate(database);

    const merchant = database.prepare(`SELECT name_norm FROM merchant ORDER BY name_norm`).all() as Array<{ name_norm: string }>;
    // "Kantin Kampus" dan "KANTIN KAMPUS" jadi satu; "Warung Bu Sri" dan "Warung Sri" tetap dua.
    expect(merchant.map((m) => m.name_norm)).toEqual(['kantin kampus', 'warung bu sri', 'warung sri']);

    const kantin = database
      .prepare(`SELECT COUNT(*) AS n FROM cash_event WHERE merchant_id = (SELECT id FROM merchant WHERE name_norm = 'kantin kampus')`)
      .get() as { n: number };
    expect(kantin.n).toBe(2);
    const tanpa = database.prepare(`SELECT COUNT(*) AS n FROM cash_event WHERE merchant_id IS NULL`).get() as { n: number };
    expect(tanpa.n).toBe(0);
  });

  it('menyembunyikan skenario Claude dari pengalaman bawaan tanpa menghapusnya', () => {
    const { database } = dbLama();
    migrate(database);
    const rows = database.prepare(`SELECT slug, hidden FROM scenario ORDER BY slug`).all() as Array<{ slug: string; hidden: number }>;
    expect(rows).toEqual([
      { slug: 'dengan-claude-pribadi', hidden: 1 },
      { slug: 'tanpa-claude-pribadi', hidden: 0 },
    ]);
  });

  it('idempoten: menjalankan ulang tidak menerapkan lagi dan tidak menggandakan merchant', () => {
    const { database } = dbLama();
    migrate(database);
    const jumlah = (database.prepare(`SELECT COUNT(*) AS n FROM merchant`).get() as { n: number }).n;
    expect(migrate(database)).toEqual([]);
    expect((database.prepare(`SELECT COUNT(*) AS n FROM merchant`).get() as { n: number }).n).toBe(jumlah);
  });

  it('rollback menghapus hanya yang ditambahkan, lalu data lama tetap utuh dan bisa ditulisi', () => {
    const { database } = dbLama();
    const sebelum = database.prepare(`SELECT * FROM cash_event ORDER BY id`).all();
    migrate(database);

    const down = fs.readFileSync(path.join(migrationsDir(), '..', 'rollback', '002_v2.down.sql'), 'utf8');
    database.exec(down);

    const tabel = (database.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ['merchant', 'merchant_alias', 'budget', 'budget_revision', 'goal', 'goal_contribution', 'app_setting']) {
      expect(tabel).not.toContain(t);
    }
    const kolom = (database.prepare(`PRAGMA table_info(cash_event)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(kolom).not.toContain('merchant_id');

    expect(database.prepare(`SELECT * FROM cash_event ORDER BY id`).all()).toEqual(sebelum);
    // Aplikasi versi lama masih bisa menulis setelah rollback.
    expect(() =>
      database
        .prepare(
          `INSERT INTO cash_event (occurred_at, direction, amount_minor, kind, source, dedupe_key, created_at, updated_at)
           VALUES ('2026-10-06T00:00:00+07:00','keluar',1000,'pengeluaran_pribadi','manual','kk','x','x')`,
        )
        .run(),
    ).not.toThrow();
    // Dan migrasi dapat diterapkan lagi.
    expect(migrate(database)).toContain('002_v2.sql');
  });
});
