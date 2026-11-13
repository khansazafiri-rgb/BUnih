import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { formatIDR } from '../domain/money.js';
import { addDays, formatTanggal, formatTanggalSingkat, nowIso, startOfWeek, today } from '../domain/time.js';
import { listBudgets } from '../domain/budgets.js';
import { listGoals } from '../domain/goals.js';
import { project } from '../domain/projection.js';
import { tagihanMendekat, cancelledButCharged } from '../domain/services.js';
import { listReceivables } from '../domain/receivables.js';
import { listTopups } from '../domain/topup.js';
import { syncState } from '../gmail/sync.js';
import { esc } from '../telegram/format.js';
import { balanceSummary } from '../domain/balances.js';
import { rencanaUang, teksRencanaUang } from '../domain/rencanaUang.js';
import type { Tombol } from '../telegram/ui/layar.js';
import { ambilSnapshotDefisit, catatSnapshotDefisit, putuskanKirimDefisit, sedangDitahan, type KondisiDefisit } from './kontrol.js';

export type Frekuensi = 'langsung' | 'harian' | 'mingguan' | 'mati';

export type Pengingat = {
  type: string;
  dedupe_key: string;
  text: string;
  prioritas: number;
  /** Tombol aksi (Telegram inline keyboard) yang menyertai pengingat. */
  tombol?: Tombol[][];
  /** Data yang dicatat saat pengingat benar-benar terkirim (mis. snapshot kebijakan defisit). */
  kondisiDefisit?: KondisiDefisit;
};

type Setting = { type: string; enabled: number; frequency: Frekuensi };

function settings(database: DB): Map<string, Setting> {
  const rows = database.prepare(`SELECT type, enabled, frequency FROM notification_setting`).all() as Setting[];
  return new Map(rows.map((r) => [r.type, r]));
}

function aktif(map: Map<string, Setting>, type: string, mode: Frekuensi): boolean {
  const s = map.get(type);
  if (!s) return false;
  if (!s.enabled || s.frequency === 'mati') return false;
  return s.frequency === mode;
}

/** Benar bila pengingat ini belum pernah dikirim. Mencegah notifikasi ganda. */
export function belumPernahDikirim(p: Pengingat, database: DB = db()): boolean {
  const row = database
    .prepare(`SELECT 1 FROM notification_log WHERE type = ? AND dedupe_key = ?`)
    .get(p.type, p.dedupe_key);
  return !row;
}

export function catatTerkirim(p: Pengingat, database: DB = db()): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO notification_log (type, dedupe_key, sent_at, payload_json) VALUES (?, ?, ?, ?)`,
    )
    .run(p.type, p.dedupe_key, nowIso(), JSON.stringify({ text: p.text }));
  if (p.kondisiDefisit) catatSnapshotDefisit(p.kondisiDefisit, database);
}

/**
 * Kumpulkan pengingat yang layak dikirim pada mode frekuensi tertentu.
 * Setiap pengingat punya kunci deduplikasi sehingga tidak dikirim dua kali.
 */
export function kumpulkanPengingat(
  mode: Frekuensi = 'harian',
  database: DB = db(),
): Pengingat[] {
  const map = settings(database);
  const hariIni = today();
  const out: Pengingat[] = [];

  // 1. Tagihan mendekat
  if (aktif(map, 'tagihan_mendekat', mode)) {
    const t = tagihanMendekat({ hari: 7 }, database);
    for (const d of t.daftar) {
      if (!d.memotong_saldo_saya || !d.aktif_di_skenario) continue;
      const sisaHari = Math.round(
        (Date.parse(`${d.tanggal}T00:00:00Z`) - Date.parse(`${hariIni}T00:00:00Z`)) / 86_400_000,
      );
      if (sisaHari > 7) continue;
      out.push({
        type: 'tagihan_mendekat',
        dedupe_key: `${d.obligation_id}:${d.tanggal}:${sisaHari <= 0 ? 'jatuh' : sisaHari <= 3 ? 'h3' : 'h7'}`,
        text:
          `🔔 <b>${esc(d.label)}</b> ${formatIDR(d.nominal_minor)} ` +
          `${sisaHari <= 0 ? 'jatuh tempo hari ini' : `jatuh tempo ${sisaHari} hari lagi (${formatTanggalSingkat(d.tanggal)})`}.` +
          (d.pembayar === 'belum_jelas'
            ? '\nBelum ditentukan company bayar langsung atau kamu menalangi.'
            : ''),
        prioritas: sisaHari <= 0 ? 1 : 2,
      });
    }
  }

  // 2. Saldo proyeksi di bawah cadangan minimal / defisit.
  //    Kebijakan: maksimal satu per hari kecuali ada perubahan material; saldo yang belum terverifikasi
  //    ditampilkan sebagai PERKIRAAN, bukan kondisi aktual. Lihat notify/kontrol.ts.
  if (aktif(map, 'saldo_di_bawah_cadangan', mode)) {
    const p = project({ dari: hariIni, sampai: addDays(hariIni, 30) }, database);
    const terverifikasi = !p.risiko.some((r) => r.tipe === 'saldo_belum_terverifikasi') && balanceSummary(undefined, database).akun_terverifikasi > 0;
    const defisit = p.ringkasan.tanggal_defisit;
    const rendah = !defisit && p.ringkasan.saldo_terendah_minor < p.ringkasan.cadangan_minimal_minor;
    if (defisit || rendah) {
      const kondisi: KondisiDefisit = {
        hari: hariIni,
        jenis: defisit ? 'defisit' : 'rendah',
        tanggalDefisit: defisit,
        kekurangan_minor: defisit ? p.ringkasan.kekurangan_agar_tidak_defisit_minor : p.ringkasan.kekurangan_agar_cadangan_aman_minor,
        terverifikasi,
      };
      const terakhir = ambilSnapshotDefisit(database);
      const putusan = putuskanKirimDefisit(kondisi, terakhir);
      if (putusan.kirim) {
        const kepastian = terverifikasi ? 'Terverifikasi (saldo sudah dikonfirmasi)' : 'Perkiraan — saldo belum diverifikasi';
        const urgensi = !terverifikasi ? 'Rendah' : defisit ? 'Tinggi' : 'Sedang';
        // Bukan "kekurangan Rp2 juta" (angka besar yang membingungkan), melainkan rencana 7 hari yang bisa langsung dijalankan.
        const rencana = teksRencanaUang(rencanaUang(database, hariIni), esc, formatTanggalSingkat);
        out.push({
          type: 'saldo_di_bawah_cadangan',
          // Kunci memuat hari + urutan kiriman hari itu, BUKAN angka saldo: satu angka yang berubah tidak membuat peringatan baru.
          dedupe_key: `defisit:${hariIni}:${(terakhir && terakhir.hari === hariIni ? terakhir.jumlahHariIni : 0) + 1}`,
          text: terverifikasi
            ? `${defisit ? '🔴 <b>Uangmu diperkirakan menipis</b>' : '🟡 <b>Saldo mendekati batas aman</b>'}\n\n${rencana}\n\nUrgensi: ${urgensi} · Kepastian: ${kepastian}`
            : `🟡 <b>Perkiraan — saldo belum diverifikasi</b>\nIni <i>bukan kondisi keuangan aktual</i>: saldo dasar masih asumsi awal atau belum dikonfirmasi. Konfirmasi saldo rekeningmu agar rencana di bawah akurat.\n\n${rencana}\n\nUrgensi: ${urgensi} · Kepastian: ${kepastian}`,
          prioritas: terverifikasi && defisit ? 1 : terverifikasi ? 2 : 3,
          kondisiDefisit: kondisi,
          tombol: [
            ...(terverifikasi ? [] : [[{ t: '💳 Konfirmasi Saldo', d: 'r:l' } as Tombol]]),
            [{ t: '🔍 Lihat Penyebab', d: 'p:sebab' }, { t: '⏰ Ingatkan Nanti', d: 'p:tunda' }],
            [{ t: '🔕 Bisukan 7 Hari', d: 'p:mute' }],
          ],
        });
      }
    }
  }

  // 3. Top-up rencana yang belum dikonfirmasi
  if (aktif(map, 'topup_belum_diterima', mode)) {
    for (const t of listTopups({ dari: addDays(hariIni, -60), sampai: hariIni }, database)) {
      if (t.status !== 'rencana') continue;
      out.push({
        type: 'topup_belum_diterima',
        dedupe_key: `topup:${t.id}`,
        text:
          `⏳ Rencana top-up ${formatIDR(t.plan_amount_minor)} tanggal ${formatTanggal(t.plan_date)} ` +
          'belum dikonfirmasi. Sudah masuk? Balas "top up sudah masuk" atau "top up tidak masuk".',
        prioritas: 2,
      });
    }
  }

  // 4. Pembayaran gagal
  if (aktif(map, 'pembayaran_gagal', mode)) {
    const rows = database
      .prepare(
        `SELECT i.id, i.due_date, i.amount_minor, i.currency, s.name AS layanan
           FROM invoice i LEFT JOIN service s ON s.id = i.service_id
          WHERE i.status = 'gagal_bayar'`,
      )
      .all() as Array<{ id: number; due_date: string | null; amount_minor: number | null; currency: string; layanan: string | null }>;
    for (const r of rows) {
      out.push({
        type: 'pembayaran_gagal',
        dedupe_key: `gagal:${r.id}`,
        text:
          `❌ Pembayaran <b>${esc(r.layanan ?? 'layanan')}</b> ${formatIDR(r.amount_minor)} gagal` +
          `${r.due_date ? ` (jatuh tempo ${formatTanggalSingkat(r.due_date)})` : ''}. ` +
          'Perlu dibayar ulang atau layanan akan berhenti.',
        prioritas: 1,
      });
    }
  }

  // 5. Reimburse terlambat
  if (aktif(map, 'reimburse_terlambat', mode)) {
    const r = listReceivables({ onlyOpen: true }, database);
    for (const d of r.daftar) {
      if (!d.terlambat || d.sisa_minor <= 0) continue;
      out.push({
        type: 'reimburse_terlambat',
        dedupe_key: `piutang:${d.id}:${d.expected_on ?? 'tanpa-tanggal'}`,
        text:
          `💸 ${esc(d.debtor_name ?? d.debtor_type)} belum mengganti ${formatIDR(d.sisa_minor)} ` +
          `(sejak ${formatTanggal(d.occurred_on)}, ${d.umur_hari} hari).`,
        prioritas: 3,
      });
    }
  }

  // 6. Langganan yang sudah dibatalkan tetapi tertagih lagi
  if (aktif(map, 'langganan_tertagih_lagi', mode)) {
    for (const s of cancelledButCharged(database)) {
      for (const t of s.temuan) {
        out.push({
          type: 'langganan_tertagih_lagi',
          dedupe_key: `tertagih:${s.service_id}:${t.tipe}:${t.id}`,
          text:
            `⚠️ <b>${esc(s.service_name)}</b> sudah ditandai dibatalkan pada ` +
            `${formatTanggalSingkat(s.cancelled_at.slice(0, 10))}, tetapi ada ${t.tipe} ` +
            `${formatIDR(t.nominal_minor)} pada ${formatTanggalSingkat(t.tanggal.slice(0, 10))}. ` +
            'Tolong diperiksa.',
          prioritas: 1,
        });
      }
    }
  }

  // 7. Sinkronisasi Gmail gagal
  if (aktif(map, 'sinkronisasi_gagal', mode)) {
    const s = syncState(database);
    if (s.error_terakhir) {
      out.push({
        type: 'sinkronisasi_gagal',
        dedupe_key: `sync:${s.error_terakhir.slice(0, 40)}`,
        text:
          `📭 Sinkronisasi Gmail gagal: ${esc(s.error_terakhir)}. ` +
          'Data transaksi mungkin belum lengkap.',
        prioritas: 2,
      });
    }
  }

  // 7b. Anggaran yang berisiko atau terlewati. Satu pengingat per anggaran, per periode, per tingkat.
  if (aktif(map, 'anggaran_berisiko', mode)) {
    for (const b of listBudgets({ asOf: hariIni }, database)) {
      if (b.status !== 'berisiko' && b.status !== 'lewat') continue;
      out.push({
        type: 'anggaran_berisiko',
        dedupe_key: `anggaran:${b.id}:${b.jendela.dari}:${b.status}`,
        text:
          b.status === 'lewat'
            ? `⛔ Anggaran <b>${esc(b.nama)}</b> sudah terlewati: terpakai ${formatIDR(b.terpakai_minor)} dari ${formatIDR(b.nominal_periode_minor + b.carry_minor)}.`
            : `⚠️ Anggaran <b>${esc(b.nama)}</b> bisa terlewati kalau lajunya begini` +
              (b.perkiraan_akhir_minor !== null ? ` (perkiraan akhir periode ${formatIDR(b.perkiraan_akhir_minor)}, ini estimasi)` : '') +
              `. Sisa ${formatIDR(Math.max(0, b.sisa_minor))}.`,
        prioritas: b.status === 'lewat' ? 2 : 3,
      });
    }
  }

  // 7c. Tujuan yang berisiko tidak tercapai tepat waktu (hanya yang pengingatnya dinyalakan).
  if (aktif(map, 'tujuan_berisiko', mode)) {
    for (const g of listGoals({ asOf: hariIni }, database)) {
      if (!g.pengingat || g.status !== 'aktif') continue;
      if (g.risiko !== 'berisiko' && g.risiko !== 'terlambat') continue;
      out.push({
        type: 'tujuan_berisiko',
        dedupe_key: `tujuan:${g.id}:${g.risiko}:${startOfWeek(hariIni)}`,
        text: `🎯 Tujuan <b>${esc(g.nama)}</b>: ${esc(g.penjelasan)}`,
        prioritas: 4,
      });
    }
  }

  // 8. Ringkasan harian
  if (aktif(map, 'ringkasan_harian', mode)) {
    const p = project({ dari: hariIni, sampai: addDays(hariIni, 14) }, database);
    const h = p.hari[0];
    if (h) {
      out.push({
        type: 'ringkasan_harian',
        dedupe_key: `harian:${hariIni}`,
        text:
          `☀️ <b>${formatTanggal(hariIni)}</b>\n` +
          `Proyeksi akhir hari ${formatIDR(h.saldo_akhir_minor)} (${h.status.toUpperCase()}).\n` +
          `Saldo terendah 14 hari ${formatIDR(p.ringkasan.saldo_terendah_minor)} pada ` +
          `${formatTanggalSingkat(p.ringkasan.saldo_terendah_tanggal)}.\n` +
          `Kirim /hari untuk rincian.`,
        prioritas: 4,
      });
    }
  }

  return out.filter((p) => !sedangDitahan(p.type, database)).sort((a, b) => a.prioritas - b.prioritas);
}

/**
 * Peringatan khusus: pembelian baru yang mengganggu kemampuan membayar
 * tagihan AI/server terdekat.
 */
export function peringatanPembelian(
  cashEventId: number,
  database: DB = db(),
): Pengingat | null {
  const map = settings(database);
  const s = map.get('pembelian_ganggu_tagihan');
  if (!s || !s.enabled || s.frequency === 'mati') return null;

  const hariIni = today();
  const p = project({ dari: hariIni, sampai: addDays(hariIni, 45) }, database);
  const t = tagihanMendekat({ hari: 45 }, database);
  const tagihanPribadi = t.daftar.filter(
    (d) => d.memotong_saldo_saya && d.nominal_minor !== null && d.aktif_di_skenario,
  );
  if (!tagihanPribadi.length) return null;

  const bermasalah = tagihanPribadi.find((d) => {
    const hari = p.hari.find((x) => x.tanggal === d.tanggal);
    return hari ? hari.saldo_akhir_minor < 0 : false;
  });
  if (!bermasalah) return null;

  return {
    type: 'pembelian_ganggu_tagihan',
    dedupe_key: `ganggu:${cashEventId}:${bermasalah.obligation_id}`,
    text:
      `⚠️ Setelah transaksi terakhir, tagihan <b>${esc(bermasalah.label)}</b> ` +
      `${formatIDR(bermasalah.nominal_minor)} pada ${formatTanggalSingkat(bermasalah.tanggal)} ` +
      'berisiko tidak terbayar.',
    prioritas: 1,
  };
}

export function setNotificationSetting(
  type: string,
  patch: { enabled?: boolean; frequency?: Frekuensi },
  database: DB = db(),
): void {
  database
    .prepare(
      `INSERT INTO notification_setting (type, enabled, frequency, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(type) DO UPDATE SET
         enabled = COALESCE(excluded.enabled, notification_setting.enabled),
         frequency = COALESCE(excluded.frequency, notification_setting.frequency),
         updated_at = excluded.updated_at`,
    )
    .run(type, patch.enabled === undefined ? 1 : patch.enabled ? 1 : 0, patch.frequency ?? 'harian', nowIso());
}

export function listNotificationSettings(database: DB = db()) {
  return database.prepare(`SELECT * FROM notification_setting ORDER BY type`).all();
}

/** Penjelasan "kenapa defisit?" untuk tombol Lihat Penyebab. Semua angka dari proyeksi yang sama. */
export function penyebabDefisit(database: DB = db()): string {
  const hariIni = today();
  const p = project({ dari: hariIni, sampai: addDays(hariIni, 30) }, database);
  const saldo = balanceSummary(undefined, database);
  const terverifikasi = saldo.akun_terverifikasi > 0 && !p.risiko.some((r) => r.tipe === 'saldo_belum_terverifikasi');
  const tgl = p.ringkasan.tanggal_defisit ?? p.ringkasan.saldo_terendah_tanggal;
  const hari = p.hari.find((d) => d.tanggal === tgl);
  const baris = [
    '🔍 <b>Penyebab peringatan saldo</b>',
    terverifikasi
      ? `Saldo dasar: terverifikasi (${saldo.akun_terverifikasi} rekening dikonfirmasi).`
      : '⚠️ Saldo dasar <b>belum terverifikasi</b> — hasilnya hanya perkiraan. Konfirmasi saldo di /rekening.',
    `Saldo terendah: ${formatIDR(p.ringkasan.saldo_terendah_minor)} pada ${formatTanggal(p.ringkasan.saldo_terendah_tanggal)} (cadangan minimal ${formatIDR(p.ringkasan.cadangan_minimal_minor)}).`,
    p.ringkasan.tanggal_defisit ? `Mulai minus: ${formatTanggal(p.ringkasan.tanggal_defisit)}.` : 'Belum ada hari yang minus.',
  ];
  if (hari) {
    const besar = [...hari.drivers].filter((d) => d.direction === 'keluar' && d.amount_minor !== null).sort((a, b) => (b.amount_minor ?? 0) - (a.amount_minor ?? 0)).slice(0, 4);
    if (besar.length) {
      baris.push('', `<b>Pengeluaran terbesar pada ${formatTanggalSingkat(tgl)}</b>`, ...besar.map((d) => `• ${esc(d.label)} — ${formatIDR(d.amount_minor ?? 0)}`));
    }
  }
  const risiko = p.risiko.slice(0, 3).map((r) => `• ${esc(r.pesan)}`);
  if (risiko.length) baris.push('', '<b>Yang belum pasti</b>', ...risiko);
  baris.push('', teksRencanaUang(rencanaUang(database, hariIni), esc, formatTanggalSingkat));
  return baris.join('\n');
}
