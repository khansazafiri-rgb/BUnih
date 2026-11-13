/**
 * Mengisi database dengan DATA SINTETIS agar BUnih bisa dilihat bekerja sebelum ada data nyata.
 *
 * Semua nama, toko, dan angka di sini fiktif. Tidak ada data pribadi.
 *
 * Jalankan : node server/dist/scripts/contoh.js
 * Hapus    : node server/dist/scripts/contoh.js --hapus
 *
 * Setiap baris yang dibuat diberi tanda "[CONTOH]" supaya mudah dikenali dan dihapus.
 * JANGAN dijalankan pada database berisi data asli: skrip menolak bila sudah ada transaksi
 * yang bukan contoh, kecuali diberi --paksa.
 */
import { db } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { addDays, today } from '../domain/time.js';
import { buatTransaksi, type TransaksiBaru } from '../domain/manualTx.js';
import { recordReconciliation } from '../domain/balances.js';
import { createBudget } from '../domain/budgets.js';
import { addContribution, createGoal } from '../domain/goals.js';
import { addAlias } from '../domain/merchants.js';
import { rebuildObligations } from '../domain/obligations.js';

const TANDA = '[CONTOH]';

function hapus(): void {
  const database = db();
  database.transaction(() => {
    const ids = database.prepare(`SELECT id FROM cash_event WHERE note LIKE ?`).all(`%${TANDA}%`) as Array<{ id: number }>;
    for (const { id } of ids) {
      database.prepare(`DELETE FROM goal_contribution WHERE cash_event_id = ?`).run(id);
      database.prepare(`DELETE FROM allocation WHERE cash_event_id = ?`).run(id);
      database.prepare(`DELETE FROM cash_event WHERE id = ?`).run(id);
    }
    database.prepare(`DELETE FROM budget WHERE note LIKE ?`).run(`%${TANDA}%`);
    database.prepare(`DELETE FROM goal WHERE note LIKE ?`).run(`%${TANDA}%`);
    database.prepare(`DELETE FROM reconciliation WHERE note LIKE ?`).run(`%${TANDA}%`);
    database.prepare(`DELETE FROM service WHERE note LIKE ?`).run(`%${TANDA}%`);
  })();
  console.log('Data contoh dihapus.');
}

function akun(nama: string): number {
  const r = db().prepare(`SELECT id FROM account WHERE name LIKE ?`).get(`%${nama}%`) as { id: number } | undefined;
  if (!r) throw new Error(`Rekening ${nama} tidak ditemukan.`);
  return r.id;
}

function kat(slug: string): number {
  const r = db().prepare(`SELECT id FROM category WHERE slug = ?`).get(slug) as { id: number } | undefined;
  if (!r) throw new Error(`Kategori ${slug} tidak ditemukan.`);
  return r.id;
}

function isi(paksa: boolean): void {
  const database = db();
  const nyata = (database.prepare(`SELECT COUNT(*) n FROM cash_event WHERE COALESCE(note,'') NOT LIKE ?`).get(`%${TANDA}%`) as { n: number }).n;
  if (nyata > 0 && !paksa) {
    console.error(`Database sudah berisi ${nyata} transaksi non-contoh. Dibatalkan agar data asli aman. Gunakan --paksa bila yakin.`);
    process.exit(1);
  }
  const sudah = (database.prepare(`SELECT COUNT(*) n FROM cash_event WHERE note LIKE ?`).get(`%${TANDA}%`) as { n: number }).n;
  if (sudah > 0) {
    console.log('Data contoh sudah ada. Jalankan dengan --hapus dulu bila ingin mengisi ulang.');
    return;
  }

  const hariIni = today();
  const mandiri = akun('Mandiri');
  const bca = akun('BCA');
  let n = 0;
  const tulis = (hariLalu: number, t: Omit<TransaksiBaru, 'waktu'>) => {
    n += 1;
    return buatTransaksi({ ...t, waktu: `${addDays(hariIni, -hariLalu)}T12:${String(n % 60).padStart(2, '0')}`, referensi: t.referensi ?? `CONTOH-${n}`, catatan: `${t.catatan ?? ''} ${TANDA}`.trim(), rekening_id: t.rekening_id ?? mandiri }, 'contoh', database);
  };
  const keluar = (hariLalu: number, jumlah: number, slug: string, merchant: string, extra: Partial<TransaksiBaru> = {}) =>
    tulis(hariLalu, { jenis: 'pengeluaran', jumlah_minor: jumlah, kategori_id: kat(slug), merchant, ...extra });

  // Gaji / pemasukan dua bulan terakhir.
  tulis(52, { jenis: 'pemasukan', jumlah_minor: 4_500_000, merchant: 'Beasiswa & kerja paruh waktu' });
  tulis(23, { jenis: 'pemasukan', jumlah_minor: 4_500_000, merchant: 'Beasiswa & kerja paruh waktu' });
  tulis(9, { jenis: 'pemasukan', jumlah_minor: 600_000, merchant: 'Proyek desain lepas' });

  // Makan: kebiasaan nyata dengan beberapa nama berbeda untuk tempat yang sama.
  const makan: Array<[number, number, string]> = [
    [1, 28_000, 'Kantin Kampus'], [2, 22_000, 'KANTIN KAMPUS'], [3, 45_000, 'Warung Bu Sri'], [4, 32_000, 'Kantin Kampus'],
    [6, 58_000, 'Ayam Geprek Mantap'], [7, 25_000, 'Kantin Kampus'], [8, 41_000, 'Warung Bu Sri'], [10, 76_000, 'Kopi Senja'],
    [11, 24_000, 'Kantin Kampus'], [12, 52_000, 'Ayam Geprek Mantap'], [13, 30_000, 'Warung Bu Sri'],
    [15, 27_000, 'Kantin Kampus'], [17, 64_000, 'GoFood - Bakso Pak Kumis'], [19, 38_000, 'Warung Bu Sri'], [21, 29_000, 'Kantin Kampus'],
    [24, 55_000, 'Ayam Geprek Mantap'], [26, 31_000, 'Kantin Kampus'], [29, 72_000, 'Kopi Senja'], [31, 43_000, 'Warung Bu Sri'],
    [34, 26_000, 'Kantin Kampus'], [37, 68_000, 'GoFood - Bakso Pak Kumis'], [40, 35_000, 'Warung Bu Sri'], [44, 28_000, 'Kantin Kampus'],
    [47, 61_000, 'Ayam Geprek Mantap'], [50, 33_000, 'Warung Bu Sri'], [54, 29_000, 'Kantin Kampus'], [58, 80_000, 'Kopi Senja'],
  ];
  for (const [h, j, m] of makan) keluar(h, j, 'makan', m);
  const bakso = database.prepare(`SELECT id FROM merchant WHERE name LIKE '%Bakso%' LIMIT 1`).get() as { id: number } | undefined;
  if (bakso) addAlias(bakso.id, 'GOFOOD BAKSO PAK KUMIS', 'contoh', database);

  // Transport.
  for (const [h, j] of [[2, 18_000], [5, 24_000], [9, 21_000], [14, 19_000], [20, 35_000], [28, 22_000], [33, 26_000], [41, 20_000], [49, 30_000]] as const) {
    keluar(h, j, 'transport', 'Gojek');
  }
  keluar(16, 120_000, 'transport', 'Isi KRL & Transjakarta');

  // Belanja bahan makanan + satu struk yang dipecah dua kategori.
  keluar(5, 187_000, 'groceries', 'Minimarket Sejahtera');
  keluar(18, 142_000, 'groceries', 'Minimarket Sejahtera');
  keluar(35, 210_000, 'groceries', 'Minimarket Sejahtera');
  tulis(12, {
    jenis: 'pengeluaran', jumlah_minor: 250_000, merchant: 'Toko Serba Ada', kategori_id: kat('groceries'),
    pembagian_kategori: [{ kategori_id: kat('groceries'), jumlah_minor: 160_000 }, { kategori_id: kat('kebutuhan-harian'), jumlah_minor: 90_000 }],
    catatan: 'struk dipecah dua kategori',
  });

  // Hiburan, belanja, kesehatan, hadiah.
  keluar(8, 55_000, 'hiburan', 'Bioskop Citra');
  keluar(27, 150_000, 'hiburan', 'Konser Kampus');
  keluar(13, 289_000, 'belanja-barang', 'Toko Elektronik Maju');
  keluar(30, 95_000, 'kesehatan', 'Apotek Sehat');
  keluar(3, 150_000, 'hadiah', 'Kado ulang tahun Dinda', { penanggung: 'hadiah' });
  keluar(45, 49_000, 'pendidikan', 'Buku Kuliah Gramedia');

  // Pengeluaran tanpa kategori: sengaja dibiarkan agar terlihat sebagai "belum dikelompokkan".
  tulis(4, { jenis: 'pengeluaran', jumlah_minor: 67_000, merchant: 'Toko Tidak Dikenal' });
  tulis(19, { jenis: 'pengeluaran', jumlah_minor: 35_000 });

  // Langganan dibayar rutin (tiga bulan) + kenaikan harga pada satu layanan.
  const layanan = database.prepare(
    `INSERT INTO service (slug, name, vendor, bearer, paid_by, billing_cycle, amount_minor, currency, amount_certainty,
        next_due_date, due_date_certainty, status, note, created_at, updated_at)
     VALUES (?, ?, ?, 'pribadi', 'saya', 'bulanan', ?, 'IDR', 'terverifikasi', ?, 'terverifikasi', 'aktif', ?, datetime('now'), datetime('now'))`,
  );
  const spotify = Number(layanan.run('contoh-musik', 'Musik Streaming', 'Musik Streaming', 54_990, addDays(hariIni, 6), TANDA).lastInsertRowid);
  const video = Number(layanan.run('contoh-video', 'Video Streaming', 'Video Streaming', 186_000, addDays(hariIni, 14), TANDA).lastInsertRowid);
  const awan = Number(layanan.run('contoh-awan', 'Penyimpanan Awan', 'Penyimpanan Awan', 29_000, addDays(hariIni, 3), TANDA).lastInsertRowid);
  const bayar = (id: number, h: number, j: number, nama: string) =>
    keluar(h, j, 'langganan-lain', nama, { catatan: 'langganan rutin' });
  for (const [id, nama, harga] of [[spotify, 'Musik Streaming', [54_990, 54_990, 54_990]], [video, 'Video Streaming', [169_000, 186_000, 186_000]], [awan, 'Penyimpanan Awan', [29_000, 29_000, 29_000]]] as Array<[number, string, number[]]>) {
    [53, 23, 1].forEach((h, i) => {
      const r = bayar(id, h + (id % 3), harga[i]!, nama);
      database.prepare(`UPDATE cash_event SET service_id = ?, kind = 'bayar_langganan' WHERE id = ?`).run(id, r.id);
    });
  }

  // Talangan: bayar makan bersama, teman akan mengganti sebagian.
  tulis(7, {
    jenis: 'pengeluaran', jumlah_minor: 240_000, merchant: 'Makan bareng Ayam Bakar', kategori_id: kat('makan'),
    penanggung: 'talangan', bagian_saya_minor: 80_000, orang: [{ nama: 'Rani', jumlah_minor: 80_000 }, { nama: 'Bima', jumlah_minor: 80_000 }],
  });
  // Rani sudah mengganti.
  const piutang = database.prepare(`SELECT r.id FROM receivable r JOIN person p ON p.id = r.debtor_person_id WHERE p.name = 'Rani' ORDER BY r.id DESC LIMIT 1`).get() as { id: number } | undefined;
  if (piutang) tulis(4, { jenis: 'pemasukan', jumlah_minor: 80_000, merchant: 'Rani (ganti makan bareng)', melunasi_piutang_id: piutang.id });

  // Refund.
  tulis(10, { jenis: 'refund', jumlah_minor: 55_000, merchant: 'Toko Elektronik Maju', kategori_id: kat('belanja-barang'), catatan: 'kabel dikembalikan' });

  // Menabung: transfer ke rekening tabungan (bukan pengeluaran).
  tulis(22, { jenis: 'tabungan', jumlah_minor: 500_000, rekening_id: mandiri, tujuan_rekening_id: bca });
  tulis(2, { jenis: 'tabungan', jumlah_minor: 300_000, rekening_id: mandiri, tujuan_rekening_id: bca });

  // Titik tambat saldo (terverifikasi dari "mutasi").
  recordReconciliation({ account_id: mandiri, as_of: `${addDays(hariIni, -1)}T23:59:59+07:00`, statement_balance_minor: 2_610_000, source: 'manual', note: `${TANDA} saldo dari mutasi` }, database);
  recordReconciliation({ account_id: bca, as_of: `${addDays(hariIni, -1)}T23:59:59+07:00`, statement_balance_minor: 2_300_000, source: 'manual', note: `${TANDA} saldo dari mutasi` }, database);

  // Anggaran.
  const bulan = hariIni.slice(0, 8) + '01';
  createBudget({ name: 'Makan', category_id: kat('makan'), period: 'bulanan', amount_minor: 900_000, start_date: bulan, recurring: true, rollover: false, note: TANDA }, 'contoh', database);
  createBudget({ name: 'Transport', category_id: kat('transport'), period: 'bulanan', amount_minor: 150_000, start_date: bulan, recurring: true, note: TANDA }, 'contoh', database);
  createBudget({ name: 'Hiburan', category_id: kat('hiburan'), period: 'bulanan', amount_minor: 200_000, start_date: bulan, recurring: true, rollover: true, note: TANDA }, 'contoh', database);
  createBudget({ name: 'Semua pengeluaran', period: 'bulanan', amount_minor: 3_200_000, start_date: bulan, recurring: true, note: TANDA }, 'contoh', database);

  // Tujuan.
  const laptop = createGoal({ name: 'Laptop baru', target_minor: 8_000_000, start_minor: 1_000_000, target_date: addDays(hariIni, 150), icon: '💻', reminder: true, note: TANDA }, 'contoh', database);
  addContribution(laptop, { amount_minor: 800_000, kind: 'disisihkan', occurred_on: addDays(hariIni, -20), note: TANDA }, 'contoh', database);
  const darurat = createGoal({ name: 'Dana darurat', target_minor: 6_000_000, start_minor: 0, icon: '🛡️', note: TANDA }, 'contoh', database);
  const setoran = database.prepare(`SELECT id, amount_minor FROM cash_event WHERE kind = 'setoran_tabungan' AND direction = 'masuk' AND note LIKE ? ORDER BY id`).all(`%${TANDA}%`) as Array<{ id: number; amount_minor: number }>;
  if (setoran[0]) addContribution(darurat, { amount_minor: setoran[0].amount_minor, kind: 'transfer_tercatat', cash_event_id: setoran[0].id, note: TANDA }, 'contoh', database);
  createGoal({ name: 'Liburan akhir tahun', target_minor: 3_000_000, start_minor: 400_000, target_date: addDays(hariIni, 40), icon: '✈️', reminder: true, note: TANDA }, 'contoh', database);

  rebuildObligations({}, database);
  console.log(`Selesai. ${n} transaksi sintetis, 4 anggaran, 3 tujuan, 3 langganan. Hapus dengan --hapus.`);
}

const database = db();
migrate(database);
seed(database);

if (process.argv.includes('--hapus')) hapus();
else isi(process.argv.includes('--paksa'));
