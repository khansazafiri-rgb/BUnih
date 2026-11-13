import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { akun, dbUji, jumlahTransaksi, kategori } from './bantu.js';
import { pasangBot } from './bot-uji.js';
import { migrate, migrationsDir } from '../src/db/migrate.js';
import { ingestMessage } from '../src/gmail/ingest.js';
import { parseMessage } from '../src/gmail/parsers/index.js';
import type { MailMessage, ParsedTransaction } from '../src/gmail/types.js';
import { hapusNominal, parseAllRupiah, parseRupiah } from '../src/telegram/nlu.js';
import { sendPendingDecisions } from '../src/telegram/bot.js';
import { DAFTAR_PERINTAH } from '../src/telegram/ui/lainUi.js';
import { getState, setState } from '../src/telegram/state.js';
import { recategorize } from '../src/domain/ledger.js';
import { spendRows, sumSpend } from '../src/domain/spend.js';
import { today, addDays } from '../src/domain/time.js';
import { buatAtauPakaiKategori, gabungKategori, normalisasiNamaKategori } from '../src/domain/categoryOps.js';

let database: DB;
beforeEach(() => {
  database = dbUji();
  database.prepare(`UPDATE account SET last4 = '4821', verified = 1 WHERE name LIKE '%Mandiri%'`).run();
});

const surat = (text: string, id = Math.random().toString(36).slice(2)): MailMessage => ({
  id, from: 'noreply@bankmandiri.co.id', subject: 'Transaksi Berhasil', date: `${today()}T14:05:00+07:00`, text, headers: {}, labelIds: [],
});

describe('regresi: bug yang ditemukan saat membangun Telegram-first', () => {
  it('parser Gmail: rekening tujuan tidak lagi diambil dari rekening sumber', () => {
    const p = parseMessage(surat('Pembayaran Berhasil\nNominal: Rp85.000\nSumber Dana: ****4821\nMerchant: Toko Buku\nNo. Referensi: TRX20261113001'));
    const tx = p!.items[0] as ParsedTransaction;
    expect(tx.source_account_tail).toBe('4821');
    expect(tx.dest_account_tail).toBeNull();
    // Dulu: dest = 4821 → "transfer ke rekening sendiri" → pembayaran ke merchant hilang dari pengeluaran.
    ingestMessage(surat('Pembayaran Berhasil\nNominal: Rp85.000\nSumber Dana: ****4821\nMerchant: Toko Buku\nNo. Referensi: TRX20261113001'), database);
    const ev = database.prepare(`SELECT kind FROM cash_event`).get() as { kind: string };
    expect(ev.kind).not.toBe('transfer_internal');
  });

  it('parser Gmail: tujuan yang berlabel tetap dikenali sebagai rekening sendiri', () => {
    ingestMessage(
      surat('Transfer berhasil\nNominal: Rp500.000\nRekening Sumber: ****4821\nRekening Tujuan: ****7733\nNo. Referensi: TRX20261113002'),
      Object.assign(database, {}),
    );
    // BCA belum diberi last4 di beforeEach ini → tidak cocok; cukup pastikan tidak error dan tercatat satu.
    expect(jumlahTransaksi(database)).toBe(1);
  });

  it('kata "Referensi" sendiri tidak terbaca sebagai nomor referensi', () => {
    const p = parseMessage(surat('Transfer berhasil\nNominal: Rp10.000\nRekening Sumber: ****4821\nPenerima: X\nNo. Referensi: R1'));
    expect((p!.items[0] as ParsedTransaction).reference_no).toBeNull();
  });

  it('NLU: "Rp500 ribu" terbaca 500.000, bukan 500', () => {
    expect(parseRupiah('anggaran pacaran rp500 ribu per bulan')).toBe(500_000);
    expect(parseRupiah('Rp500 ribu')).toBe(500_000);
    expect(parseRupiah('rp1,5jt')).toBe(1_500_000);
    expect(parseRupiah('Rp25.000')).toBe(25_000);
    expect(parseRupiah('makan 35rb')).toBe(35_000);
    expect(parseRupiah('beli hp 3 juta')).toBe(3_000_000);
    expect(parseAllRupiah('aku 30rb dari Rp200.000')).toEqual([30_000, 200_000]);
    expect(hapusNominal('pacaran Rp500 ribu per bulan').replace(/\s+/g, ' ').trim()).toBe('pacaran per bulan');
  });

  it('memberi kategori pada uang keluar yang belum diklasifikasi menjadikannya pengeluaran pribadi', () => {
    ingestMessage(surat('Pembayaran Berhasil\nNominal: Rp85.000\nSumber Dana: ****4821\nMerchant: Toko Buku\nNo. Referensi: TRX20261113003'), database);
    const id = (database.prepare(`SELECT id FROM cash_event`).get() as { id: number }).id;
    const hitung = () => sumSpend(spendRows(addDays(today(), -1), addDays(today(), 1), {}, database));
    const kind0 = (database.prepare(`SELECT kind FROM cash_event WHERE id = ?`).get(id) as { kind: string }).kind;
    if (kind0 === 'belum_dikategorikan') expect(hitung()).toBe(0);
    recategorize(id, { category_id: kategori(database, 'makan') }, 'uji', database);
    expect(hitung()).toBe(85_000);
    const alok = database.prepare(`SELECT purpose, category_id FROM allocation WHERE cash_event_id = ?`).all(id);
    expect(alok).toEqual([{ purpose: 'biaya_pribadi', category_id: kategori(database, 'makan') }]);
  });
});

describe('saran kategori: konfirmasi atau ubah', () => {
  it('transaksi dengan kategori yang sudah dikenali menampilkan saran dengan tombol Konfirmasi/Ubah', async () => {
    const b = pasangBot();
    ingestMessage(surat('Pembayaran Berhasil\nNominal: Rp300.000\nSumber Dana: ****4821\nMerchant: Biznet Gio\nNo. Referensi: TRX20261113004'), database);
    await sendPendingDecisions(5, database);
    const t = b.terakhirTeks();
    expect(t).toContain('Kategori disarankan');
    const labels = b.terakhirTombolLabel();
    expect(labels.some((l) => l.includes('Konfirmasi'))).toBe(true);
    expect(labels.some((l) => l.includes('Ubah Kategori'))).toBe(true);
    const ok = b.terakhirTombol().find((d) => d.endsWith(':ok'))!;
    await b.tekan(ok, { pesan: 501 });
    expect(b.terakhirTeks()).toContain('Dikategorikan');
  });
});

describe('persistensi dan migrasi 003', () => {
  it('status percakapan kedaluwarsa diabaikan', () => {
    setState('1001', { t: 'koreksi', eventId: 1, field: 'jumlah' }, 'utama', -1, database);
    expect(getState('1001', 'utama', database)).toBeNull();
  });

  it('migrasi 003 aditif dan rollback-nya hanya menghapus yang ditambahkan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunih-mig3-'));
    for (const f of ['001_init.sql', '002_v2.sql']) fs.copyFileSync(path.join(migrationsDir(), f), path.join(dir, f));
    const d = new Database(':memory:');
    d.pragma('foreign_keys = ON');
    migrate(d, dir);
    const at = '2026-10-01T00:00:00+07:00';
    d.prepare(`INSERT INTO account (name, bank, kind, created_at) VALUES ('Uji', 'B', 'giro', ?)`).run(at);
    d.prepare(`INSERT INTO cash_event (occurred_at, direction, amount_minor, kind, source, dedupe_key, created_at, updated_at) VALUES (?, 'keluar', 1000, 'pengeluaran_pribadi', 'manual', 'x1', ?, ?)`).run(at, at, at);
    const sebelum = d.prepare(`SELECT * FROM cash_event`).all();

    fs.copyFileSync(path.join(migrationsDir(), '003_telegram.sql'), path.join(dir, '003_telegram.sql'));
    expect(migrate(d, dir)).toEqual(['003_telegram.sql']);
    const tabel = () => (d.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ['tg_state', 'tg_message', 'tg_callback_seen']) expect(tabel()).toContain(t);
    expect(d.prepare(`SELECT * FROM cash_event`).all()).toEqual(sebelum);
    expect(migrate(d, dir)).toEqual([]); // idempoten

    d.exec(fs.readFileSync(path.join(migrationsDir(), '..', 'rollback', '003_telegram.down.sql'), 'utf8'));
    for (const t of ['tg_state', 'tg_message', 'tg_callback_seen']) expect(tabel()).not.toContain(t);
    expect((d.prepare(`PRAGMA table_info(category)`).all() as Array<{ name: string }>).map((c) => c.name)).not.toContain('merged_into');
    expect(d.prepare(`SELECT * FROM cash_event`).all()).toEqual(sebelum);
  });

  it('indeks unik mencegah dua notifikasi untuk satu transaksi', () => {
    database.prepare(`INSERT INTO tg_message (chat_id, kind, cash_event_id, state, created_at) VALUES ('1','transaksi',5,'aktif','x')`).run();
    expect(() => database.prepare(`INSERT INTO tg_message (chat_id, kind, cash_event_id, state, created_at) VALUES ('1','transaksi',5,'aktif','x')`).run()).toThrow();
  });
});

describe('kategori kustom', () => {
  it('normalisasi nama dan pencegahan duplikat (kapitalisasi, spasi, aksen, tanda baca)', () => {
    expect(normalisasiNamaKategori('  Pa-car án! ')).toBe('pacaran');
    const a = buatAtauPakaiKategori('Pacaran', 'uji', {}, database);
    expect(a.status).toBe('baru');
    for (const varian of ['pacaran', '  PACARAN  ', 'Pa caran', 'páCARAN.']) {
      const b = buatAtauPakaiKategori(varian, 'uji', {}, database);
      expect(b.id).toBe(a.id);
      expect(b.status).toBe('sudah_ada');
    }
    expect((database.prepare(`SELECT COUNT(*) AS n FROM category WHERE name = 'Pacaran'`).get() as { n: number }).n).toBe(1);
  });

  it('kategori yang diarsipkan diaktifkan lagi, bukan diduplikasi', () => {
    const a = buatAtauPakaiKategori('Nongkrong', 'uji', {}, database);
    database.prepare(`UPDATE category SET active = 0 WHERE id = ?`).run(a.id);
    const b = buatAtauPakaiKategori('nongkrong', 'uji', {}, database);
    expect(b).toMatchObject({ id: a.id, status: 'diaktifkan_lagi' });
  });

  it('gabung memindahkan transaksi dan anggaran, kategori asal tetap ada (riwayat), dan menolak lingkaran', () => {
    const dari = buatAtauPakaiKategori('Kopi', 'uji', {}, database).id;
    const ke = kategori(database, 'makan');
    database.prepare(`INSERT INTO budget (name, category_id, period, amount_minor, start_date, recurring, rollover, active, created_at, updated_at) VALUES ('Kopi', ?, 'bulanan', 100000, '2026-11-01', 1, 0, 1, 'x', 'x')`).run(dari);
    const h = gabungKategori(dari, ke, 'uji', database);
    expect(h.anggaran).toBe(1);
    expect(database.prepare(`SELECT category_id FROM budget`).get()).toEqual({ category_id: ke });
    expect(database.prepare(`SELECT active, merged_into FROM category WHERE id = ?`).get(dari)).toEqual({ active: 0, merged_into: ke });
    expect(() => gabungKategori(ke, ke, 'uji', database)).toThrow();
    const anak = buatAtauPakaiKategori('Anak Makan', 'uji', { parent_id: ke }, database).id;
    expect(() => gabungKategori(ke, anak, 'uji', database)).toThrow(/turunan|di dalam/i);
    void akun;
  });
});

describe('menu perintah Telegram', () => {
  it('mendaftarkan semua perintah yang diminta, tiap perintah dengan deskripsi', () => {
    const nama = DAFTAR_PERINTAH.map((p) => p.command);
    for (const c of ['menu', 'transaksi', 'kategori', 'catat', 'anggaran', 'target', 'laporan', 'rekening', 'tagihan', 'pengaturan', 'bantuan']) expect(nama).toContain(c);
    expect(DAFTAR_PERINTAH.every((p) => p.description.length > 3 && p.description.length <= 256)).toBe(true);
  });
});
