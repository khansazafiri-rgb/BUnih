/**
 * Menu utama, laporan, rekening, tagihan, pengaturan notifikasi, dan bantuan.
 * Callback: m: (menu) l: (laporan) r: (rekening) b: (tagihan) s: (pengaturan)
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../../db/index.js';
import { analitik, resolveRange } from '../../domain/analytics.js';
import { accountBalance, listAccounts, recordReconciliation, reconciliationStatus } from '../../domain/balances.js';
import { listGoals } from '../../domain/goals.js';
import { formatIDR } from '../../domain/money.js';
import { applyInvoiceStatus } from '../../domain/services.js';
import { dateOf, formatTanggal, nowIso, today } from '../../domain/time.js';
import { tagihanMendekat } from '../../domain/services.js';
import { foodAnalysis } from '../../domain/analytics.js';
import { esc, daftarTagihan } from '../format.js';
import { jawabPertanyaanPengeluaran, ringkasanTujuan, waktuDariKunci } from '../analitikBot.js';
import { parseRupiah } from '../nlu.js';
import { clearState, getState, setState, type TgState } from '../state.js';
import { MENU_UTAMA, grid, navigasi, tombolData, type Hasil, type Konteks, type Layar, type Tombol } from './layar.js';
import { dapatkanPengaturanMute, setMute } from '../../notify/kontrol.js';
import { rencanaUang, teksRencanaUang } from '../../domain/rencanaUang.js';
import { formatTanggalSingkat } from '../../domain/time.js';

const rp = (n: number) => esc(formatIDR(n));

/* ------------------------------------------------------------------ menu & bantuan */

export function layarMenuUtama(database: DB = db()): Layar {
  const belum = (database.prepare(`SELECT COUNT(*) AS n FROM cash_event WHERE status <> 'dibatalkan' AND category_id IS NULL AND direction = 'keluar' AND kind NOT IN ('transfer_internal','setoran_tabungan','talangan')`).get() as { n: number }).n;
  return {
    teks: `🏠 <b>BUnih — Menu Utama</b>\nKelola uangmu langsung dari sini.${belum > 0 ? `\n\n📂 ${belum} transaksi belum dikategorikan.` : ''}`,
    tombol: [
      [tombolData('➕ Catat', 'c:menu'), tombolData('🧾 Transaksi', 't:o:0')],
      [tombolData('📂 Kategori', 'k:l:0'), tombolData('🎯 Anggaran', 'a:l')],
      [tombolData('🐷 Target', 'g:l'), tombolData('📊 Laporan', 'l:menu')],
      [tombolData('🏦 Rekening', 'r:l'), tombolData('🔔 Tagihan', 'b:l')],
      [tombolData('📅 Rencana 7 Hari', 'm:rencana'), tombolData('⚙️ Pengaturan', 's:l')],
      [tombolData('❓ Bantuan', 'm:help')],
      ...(belum > 0 ? [[tombolData(`📂 Kategorikan ${belum} yang belum`, 'm:belum')]] : []),
    ],
  };
}

export function layarRencana(database: DB = db()): Layar {
  return {
    teks: `📅 <b>Rencana uang 7 hari</b>\n\n${teksRencanaUang(rencanaUang(database), esc, formatTanggalSingkat)}`,
    tombol: [[tombolData('💳 Konfirmasi Saldo', 'r:l'), tombolData('🔔 Tagihan', 'b:l')], [MENU_UTAMA]],
  };
}

export const DAFTAR_PERINTAH: Array<{ command: string; description: string }> = [
  { command: 'menu', description: 'Buka menu utama' },
  { command: 'catat', description: 'Catat transaksi baru' },
  { command: 'transaksi', description: 'Lihat dan ubah transaksi' },
  { command: 'kategori', description: 'Pilih atau kelola kategori' },
  { command: 'anggaran', description: 'Lihat dan atur anggaran' },
  { command: 'target', description: 'Kelola target keuangan' },
  { command: 'laporan', description: 'Laporan pengeluaran' },
  { command: 'rekening', description: 'Rekening dan status saldo' },
  { command: 'rencana', description: 'Rencana uang 7 hari ke depan' },
  { command: 'tagihan', description: 'Kelola tagihan' },
  { command: 'pengaturan', description: 'Notifikasi dan preferensi' },
  { command: 'bantuan', description: 'Panduan penggunaan' },
];

export function layarBantuan(): Layar {
  return {
    teks: [
      '❓ <b>Panduan singkat</b>',
      '',
      '<b>Perintah</b>',
      ...DAFTAR_PERINTAH.map((p) => `/${p.command} — ${p.description}`),
      '',
      '<b>Atau tulis biasa</b>',
      '• <i>makan 35rb di kantin pakai Mandiri</i> → usulan catatan, kamu konfirmasi',
      '• <i>Buat anggaran Pacaran Rp500 ribu per bulan</i>',
      '• <i>Target laptop Rp8 juta sebelum Juni 2027</i>',
      '• <i>berapa pengeluaran makan bulan ini?</i> · <i>paling banyak habis buat apa?</i>',
      '• <i>/transaksi kantin kemarin</i> → cari transaksi (kategori, merchant, tanggal, rekening, nominal)',
      '',
      'Setiap transaksi baru dari Gmail dikirim sebagai notifikasi dengan tombol kategori. Semua perubahan tercatat di riwayat dan langsung terlihat di dashboard web.',
    ].join('\n'),
    tombol: [[MENU_UTAMA]],
  };
}

/* ------------------------------------------------------------------ laporan */

const FRASA: Record<string, string> = { hi: 'hari ini', kmrn: 'kemarin', mg: 'minggu ini', mgl: 'minggu lalu', bi: 'bulan ini', bl: 'bulan lalu', '7h': '7 hari', '30h': '30 hari', th: 'tahun ini' };

function barisWaktu(kode: string, aktif: string): Tombol[] {
  const pilih: Array<[string, string]> = [['mg', 'Minggu ini'], ['bi', 'Bulan ini'], ['bl', 'Bulan lalu'], ['30h', '30 hari']];
  return pilih.map(([k, l]) => tombolData(k === aktif ? `• ${l}` : l, `l:${kode}:${k}`));
}

export function layarLaporanMenu(): Layar {
  return {
    teks: '📊 <b>Laporan</b>\nPilih laporannya. Semua angka dihitung dari transaksi yang tercatat, bukan perkiraan.',
    tombol: [
      [tombolData('📊 Pengeluaran Bulan Ini', 'l:bln:bi')],
      [tombolData('🍜 Analisis Makanan', 'l:mkn:bi'), tombolData('🏪 Merchant Terbanyak', 'l:mer:bi')],
      [tombolData('📈 Perbandingan Bulanan', 'l:cmp:bi'), tombolData('🎯 Progress Target', 'l:tg')],
      [MENU_UTAMA],
    ],
  };
}

function formatMakanan(w: string, database: DB): string {
  const r = resolveRange(waktuDariKunci(w).spec, today());
  const m = foodAnalysis(r, today(), database);
  if (!m.tersedia) return `🍜 <b>Analisis makanan</b>\n${esc(m.alasan ?? 'Belum cukup data untuk dianalisis.')}`;
  const baris = [
    `🍜 <b>Analisis makanan — ${esc(r.label)}</b>`,
    `Total: <b>${rp(m.total_minor)}</b> dari ${m.jumlah_transaksi} transaksi`,
    `Rata-rata ${rp(m.rata_per_hari_minor)} per hari (${m.hari_dengan_catatan} dari ${m.hari_berjalan} hari ada catatan)`,
  ];
  if (m.perubahan_persen !== null) baris.push(`${m.perubahan_persen >= 0 ? 'Naik' : 'Turun'} ${Math.abs(m.perubahan_persen)}% dibanding ${esc(r.sebelumnya.label)} (${rp(m.sebelumnya_total_minor)})`);
  if (m.paling_sering.length) baris.push('', '<b>Paling sering</b>', ...m.paling_sering.slice(0, 3).map((x, i) => `${i + 1}. ${esc(x.nama)} — ${x.jumlah_transaksi}× (${rp(x.total_minor)})`));
  if (m.anggaran) baris.push('', `Anggaran makan: ${rp(m.anggaran.terpakai_minor)} dari ${rp(m.anggaran.nominal_periode_minor)} (${esc(m.anggaran.status_teks)})`);
  if (m.hari_tanpa_catatan > 0) baris.push('', `<i>${m.hari_tanpa_catatan} hari tanpa catatan makan — angka mungkin lebih kecil dari kenyataan.</i>`);
  return baris.join('\n');
}

export function tanganiLaporan(parts: string[], _ctx: Konteks, database: DB = db()): Hasil {
  const k = parts[1] ?? '';
  const w = parts[2] ?? 'bi';
  const kembali: Tombol[] = [tombolData('⬅️ Laporan', 'l:menu'), MENU_UTAMA];
  if (k === 'menu') return { layar: layarLaporanMenu() };
  try {
    switch (k) {
      case 'bln':
        return { layar: { teks: jawabPertanyaanPengeluaran(`total pengeluaran ${FRASA[w] ?? 'bulan ini'}`, database).teks, tombol: [barisWaktu('bln', w), kembali] } };
      case 'mer':
        return { layar: { teks: jawabPertanyaanPengeluaran(`merchant paling sering ${FRASA[w] ?? 'bulan ini'}`, database).teks, tombol: [barisWaktu('mer', w), kembali] } };
      case 'cmp':
        return { layar: { teks: jawabPertanyaanPengeluaran(`bandingkan ${FRASA[w] ?? 'bulan ini'}`, database).teks, tombol: [barisWaktu('cmp', w), kembali] } };
      case 'mkn':
        return { layar: { teks: formatMakanan(w, database), tombol: [barisWaktu('mkn', w), kembali] } };
      case 'tg':
        return { layar: { teks: ringkasanTujuan(database), tombol: [[tombolData('🎯 Kelola Target', 'g:l')], kembali] } };
      default:
        return { toast: 'Laporan itu tidak dikenal.' };
    }
  } catch (err) {
    return { toast: (err as Error).message.slice(0, 180) };
  }
}
void analitik;
void listGoals;

/* ------------------------------------------------------------------ rekening */

export function layarRekening(database: DB = db()): Layar {
  const status = new Map(reconciliationStatus(database).map((s) => [s.account_id, s]));
  const baris: string[] = [];
  const tombol: Tombol[] = [];
  let adaBelum = false;
  for (const a of listAccounts(database, true)) {
    const s = status.get(a.id);
    const bal = accountBalance(a.id, undefined, database);
    const saldo = bal.balance_minor === null ? '<i>saldo belum dikonfirmasi</i>' : `<b>${rp(bal.balance_minor)}</b>`;
    const kondisi = s?.umur_hari === null || s?.umur_hari === undefined ? '⚠️ belum pernah direkonsiliasi' : s.umur_hari === 0 ? '✅ dikonfirmasi hari ini' : `✅ dikonfirmasi ${s.umur_hari} hari lalu`;
    if (bal.balance_minor === null) adaBelum = true;
    baris.push(`🏦 <b>${esc(a.name)}</b>${a.is_savings_target ? ' (tabungan)' : ''}\n   ${saldo} · ${kondisi}`);
    tombol.push(tombolData(`✅ Konfirmasi saldo ${a.name}`.slice(0, 40), `r:s:${a.id}`));
  }
  return {
    teks: `🏦 <b>Rekening & saldo</b>\n${baris.join('\n') || 'Belum ada rekening.'}${adaBelum ? '\n\n<i>Saldo hanya ditampilkan bila kamu sudah mengonfirmasinya. Tanpa itu, proyeksi dan peringatan defisit berstatus perkiraan.</i>' : ''}`,
    tombol: [...tombol.map((t) => [t]), navigasi()],
  };
}

export function tanganiRekening(parts: string[], ctx: Konteks, database: DB = db()): Hasil {
  const aksi = parts[1] ?? '';
  const id = Number(parts[2]);
  switch (aksi) {
    case 'l':
      clearState(ctx.chatId, 'utama', database);
      return { layar: layarRekening(database) };
    case 's': {
      const a = listAccounts(database, true).find((x) => x.id === id);
      if (!a) return { toast: 'Rekening tidak ditemukan.' };
      setState(ctx.chatId, { t: 'saldo', id }, 'utama', 45, database);
      return { layar: { teks: `Saldo <b>${esc(a.name)}</b> hari ini berapa? Lihat di aplikasi banknya, lalu tulis. Contoh: 2,45jt`, tombol: [[tombolData('❌ Batal', 'r:l')]] } };
    }
    default:
      return { toast: 'Tombol ini tidak dikenali.' };
  }
}

export function tanganiTeksSaldo(state: TgState, teks: string, ctx: Konteks, database: DB = db()): Hasil {
  const n = parseRupiah(teks.toLowerCase()) ?? (/^\d{3,}$/.test(teks.trim()) ? Number(teks.trim()) : null);
  if (n === null || n < 0) return { baru: true, layar: { teks: 'Nominalnya belum terbaca. Contoh: 2,45jt atau 2450000.', tombol: [[tombolData('❌ Batal', 'r:l')]] } };
  recordReconciliation({ account_id: Number(state['id']), as_of: nowIso(), statement_balance_minor: n, source: 'telegram', note: 'Dikonfirmasi lewat Telegram' }, database);
  clearState(ctx.chatId, 'utama', database);
  return { baru: true, layar: { ...layarRekening(database), teks: `✅ Saldo dikonfirmasi: ${rp(n)}.\n\n${layarRekening(database).teks}` } };
}

/* ------------------------------------------------------------------ tagihan */

export function layarTagihan(database: DB = db()): Layar {
  const t = tagihanMendekat({ hari: 30 }, database);
  const bisaDitandai = t.daftar.filter((d) => d.aktif_di_skenario && d.memotong_saldo_saya).slice(0, 6);
  const rows = database
    .prepare(`SELECT o.id AS oid, o.invoice_id FROM obligation o WHERE o.id IN (${bisaDitandai.map(() => '?').join(',') || 'NULL'}) AND o.invoice_id IS NOT NULL`)
    .all(...bisaDitandai.map((b) => b.obligation_id)) as Array<{ oid: number; invoice_id: number }>;
  const tombol: Tombol[][] = bisaDitandai
    .map((b) => ({ b, inv: rows.find((r) => r.oid === b.obligation_id)?.invoice_id }))
    .filter((x) => x.inv)
    .map((x) => [tombolData(`✅ Sudah dibayar: ${x.b.label}`.slice(0, 44), `b:p:${x.inv}`)]);
  tombol.push(navigasi());
  return { teks: daftarTagihan(30, database), tombol };
}

export function tanganiTagihan(parts: string[], _ctx: Konteks, database: DB = db()): Hasil {
  const aksi = parts[1] ?? '';
  if (aksi === 'l') return { layar: layarTagihan(database) };
  if (aksi === 'p') {
    const id = Number(parts[2]);
    try {
      const r = applyInvoiceStatus({ invoice_id: id, status: 'lunas_terkonfirmasi', occurred_at: nowIso(), note: 'Ditandai lunas lewat Telegram', actor: 'telegram' }, database);
      return { toast: r.berubah ? 'Ditandai lunas' : 'Sudah lunas', layar: layarTagihan(database) };
    } catch (err) {
      return { toast: (err as Error).message.slice(0, 180) };
    }
  }
  return { toast: 'Tombol ini tidak dikenali.' };
}

/* ------------------------------------------------------------------ pengaturan */

const NAMA_NOTIF: Record<string, string> = {
  transaksi_baru: 'Transaksi baru dari Gmail',
  ringkasan_harian: 'Ringkasan harian',
  tagihan_mendekat: 'Tagihan mendekat',
  pembayaran_gagal: 'Pembayaran gagal',
  topup_belum_diterima: 'Top-up belum diterima',
  saldo_di_bawah_cadangan: 'Peringatan saldo/defisit',
  reimburse_terlambat: 'Reimburse terlambat',
  langganan_tertagih_lagi: 'Langganan tertagih lagi',
  pembelian_ganggu_tagihan: 'Pembelian mengganggu tagihan',
  sinkronisasi_gagal: 'Sinkronisasi Gmail gagal',
  anggaran_berisiko: 'Anggaran berisiko',
  tujuan_berisiko: 'Target berisiko',
};
const SIKLUS = ['langsung', 'harian', 'mingguan'] as const;

export function layarPengaturan(database: DB = db()): Layar {
  const rows = database.prepare(`SELECT type, enabled, frequency FROM notification_setting ORDER BY id`).all() as Array<{ type: string; enabled: number; frequency: string }>;
  const tombol: Tombol[][] = [];
  const baris: string[] = [];
  for (const r of rows) {
    const nama = NAMA_NOTIF[r.type] ?? r.type;
    const mute = dapatkanPengaturanMute(r.type, database);
    baris.push(`${r.enabled ? '✅' : '🔕'} ${esc(nama)} — ${r.enabled ? esc(r.frequency) : 'mati'}${mute ? ` (dibisukan sampai ${esc(formatTanggal(dateOf(mute)))})` : ''}`);
    tombol.push([tombolData(`${r.enabled ? '🔕 Matikan' : '🔔 Nyalakan'}: ${nama}`.slice(0, 36), `s:t:${r.type}`), tombolData(`⏱ ${r.frequency}`, `s:f:${r.type}`)]);
  }
  tombol.push(navigasi());
  return {
    teks: `⚙️ <b>Pengaturan notifikasi</b>\n${baris.join('\n')}\n\n<i>"Transaksi baru dari Gmail" berdiri sendiri: tetap aktif walau pengingat proyeksi dimatikan.</i>`,
    tombol,
  };
}

export function tanganiPengaturan(parts: string[], _ctx: Konteks, database: DB = db()): Hasil {
  const aksi = parts[1] ?? '';
  const tipe = parts[2] ?? '';
  if (aksi === 'l') return { layar: layarPengaturan(database) };
  const ada = database.prepare(`SELECT enabled, frequency FROM notification_setting WHERE type = ?`).get(tipe) as { enabled: number; frequency: string } | undefined;
  if (!ada) return { toast: 'Pengaturan tidak ditemukan.' };
  if (aksi === 't') {
    database.prepare(`UPDATE notification_setting SET enabled = ?, updated_at = ? WHERE type = ?`).run(ada.enabled ? 0 : 1, nowIso(), tipe);
    if (!ada.enabled) setMute(tipe, null, database);
    return { toast: ada.enabled ? 'Dimatikan' : 'Dinyalakan', layar: layarPengaturan(database) };
  }
  if (aksi === 'f') {
    const i = SIKLUS.indexOf(ada.frequency as (typeof SIKLUS)[number]);
    const next = SIKLUS[(i + 1) % SIKLUS.length]!;
    database.prepare(`UPDATE notification_setting SET frequency = ?, updated_at = ? WHERE type = ?`).run(next, nowIso(), tipe);
    return { toast: `Frekuensi: ${next}`, layar: layarPengaturan(database) };
  }
  return { toast: 'Tombol ini tidak dikenali.' };
}

void getState;
void grid;
