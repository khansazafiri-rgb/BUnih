import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { formatIDR, formatMoney } from '../domain/money.js';
import {
  addDays, formatTanggal, formatTanggalSingkat, namaBulan, startOfMonth, startOfWeek,
  endOfMonth, today, type IsoDate,
} from '../domain/time.js';
import { project } from '../domain/projection.js';
import { periodReport } from '../domain/periods.js';
import { balanceSummary } from '../domain/balances.js';
import { tagihanMendekat } from '../domain/services.js';
import { listReceivables } from '../domain/receivables.js';
import { savingsReport } from '../domain/savings.js';
import { monthlyReport } from '../domain/reports.js';
import { countOpenDecisions } from '../domain/decisions.js';
import { bandingkanSkenario } from '../domain/simulate.js';
import { slugPerbandinganBawaan } from '../domain/scenarios.js';
import type { SimulasiHasil } from '../domain/simulate.js';
import { DAY_RISK_LABEL } from '../domain/types.js';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const IKON_RISIKO: Record<string, string> = { aman: '🟢', rendah: '🟡', defisit: '🔴' };

function labelKepastian(c: string): string {
  if (c === 'terverifikasi') return 'Aktual';
  if (c === 'asumsi_sheet') return 'Asumsi awal';
  return 'Perkiraan';
}

function saldoTerverifikasi(database: DB): string {
  const b = balanceSummary(undefined, database);
  const baris = b.rekening.map((r) =>
    r.balance_minor === null
      ? `• ${esc(r.name)}: belum dapat diverifikasi`
      : `• ${esc(r.name)}${r.last4 ? ` ••${r.last4}` : ''}: <b>${formatIDR(r.balance_minor)}</b>`,
  );
  let out = `<b>Dana terverifikasi</b>\n${baris.join('\n')}`;
  if (b.akun_terverifikasi > 0) {
    out += `\nTotal terverifikasi: <b>${formatIDR(b.total_terverifikasi_minor)}</b>`;
  } else {
    out += '\nBelum ada rekening yang direkonsiliasi, jadi total belum bisa disebut saldo bank.';
  }
  if (b.dalam_perjalanan_jumlah > 0) {
    out += `\nDalam perjalanan antar rekening saya: ${formatIDR(b.dalam_perjalanan_minor)}`;
  }
  return out;
}

export function ringkasanHari(database: DB = db()): string {
  const hariIni = today();
  const p = project({ dari: hariIni, sampai: addDays(hariIni, 14) }, database);
  const h = p.hari[0];
  if (!h) return 'Belum ada data untuk hari ini.';

  const tagihan = tagihanMendekat({ hari: 7 }, database);
  const keputusan = countOpenDecisions(database);

  const lines: string[] = [];
  lines.push(`<b>Posisi ${formatTanggal(hariIni)}</b>`);
  lines.push(saldoTerverifikasi(database));
  lines.push('');
  lines.push(
    `Proyeksi akhir hari: <b>${formatIDR(h.saldo_akhir_minor)}</b> ` +
      `${IKON_RISIKO[h.status]} ${DAY_RISK_LABEL[h.status]}`,
  );
  if (h.saldo_akhir_realisasi_minor !== null) {
    lines.push(`Realisasi sampai sekarang: ${formatIDR(h.saldo_akhir_realisasi_minor)}`);
  }
  lines.push(
    `Makan: aktual ${formatIDR(h.makan_aktual_minor)} dari anggaran ${formatIDR(h.anggaran_makan_minor)}`,
  );
  if (h.tagihan_minor > 0) lines.push(`Tagihan hari ini: ${formatIDR(h.tagihan_minor)}`);
  if (h.belanja_minor > 0) lines.push(`Belanja hari ini: ${formatIDR(h.belanja_minor)}`);
  lines.push('');
  lines.push(
    `Saldo terendah 14 hari: <b>${formatIDR(p.ringkasan.saldo_terendah_minor)}</b> ` +
      `pada ${formatTanggal(p.ringkasan.saldo_terendah_tanggal)}`,
  );
  if (p.ringkasan.tanggal_defisit) {
    lines.push(`⚠️ Defisit diperkirakan ${formatTanggal(p.ringkasan.tanggal_defisit)}`);
  }
  if (tagihan.daftar.length) {
    const t = tagihan.daftar[0]!;
    lines.push(
      `Tagihan terdekat: ${esc(t.label)} ${formatIDR(t.nominal_minor)} ` +
        `${formatTanggalSingkat(t.tanggal)} (${t.penanggung})`,
    );
  }
  if (keputusan > 0) lines.push(`\n❓ ${keputusan} hal perlu kamu jawab. Kirim /koreksi atau cek web.`);
  if (p.dasar_saldo.certainty !== 'terverifikasi') {
    lines.push(`\nℹ️ Saldo dasar masih ${labelKepastian(p.dasar_saldo.certainty)}: ${esc(p.dasar_saldo.sumber)}`);
  }
  return lines.join('\n');
}

export function ringkasanMinggu(database: DB = db()): string {
  const hariIni = today();
  const mulai = startOfWeek(hariIni);
  const akhir = addDays(mulai, 6);
  const p = project({ dari: mulai, sampai: akhir }, database);
  const lines: string[] = [];
  lines.push(`<b>Minggu ${formatTanggalSingkat(mulai)} – ${formatTanggalSingkat(akhir)}</b>`);
  lines.push(`Pemasukan aktual: ${formatIDR(p.ringkasan.total_masuk_aktual_minor)}`);
  lines.push(`Pemasukan rencana: ${formatIDR(p.ringkasan.total_masuk_rencana_minor)}`);
  lines.push(`Makan aktual: ${formatIDR(p.ringkasan.total_makan_aktual_minor)}`);
  lines.push(`Makan rencana: ${formatIDR(p.ringkasan.total_makan_rencana_minor)}`);
  lines.push(`Tagihan: ${formatIDR(p.ringkasan.total_tagihan_minor)}`);
  lines.push(`Belanja: ${formatIDR(p.ringkasan.total_belanja_minor)}`);
  if (p.ringkasan.total_biaya_company_minor > 0) {
    lines.push(`Biaya company (tidak memotong saldo saya): ${formatIDR(p.ringkasan.total_biaya_company_minor)}`);
  }
  lines.push('');
  lines.push(`Saldo akhir minggu (proyeksi): <b>${formatIDR(p.ringkasan.saldo_akhir_minor)}</b>`);
  const rendah = p.hari.filter((d) => d.status !== 'aman');
  if (rendah.length) {
    lines.push(
      `Hari perlu perhatian: ${rendah.map((d) => `${formatTanggalSingkat(d.tanggal)} ${DAY_RISK_LABEL[d.status]}`).join(', ')}`,
    );
  }
  return lines.join('\n');
}

export function ringkasanBulan(ym: string = today().slice(0, 7), database: DB = db()): string {
  const r = monthlyReport(ym, database);
  const p = project({ dari: startOfMonth(`${ym}-01`), sampai: endOfMonth(`${ym}-01`) }, database);
  const lines: string[] = [];
  lines.push(`<b>${esc(namaBulan(ym))}</b>`);
  lines.push(`Uang masuk: ${formatIDR(r.arus_kas.masuk_minor)}`);
  lines.push(`Uang keluar: ${formatIDR(r.arus_kas.keluar_minor)}`);
  lines.push(`Biaya pribadi neto: <b>${formatIDR(r.biaya_pribadi_neto_minor)}</b>`);
  lines.push(`Transfer antar rekening saya: ${formatIDR(r.arus_kas.transfer_internal_minor)} (bukan biaya)`);
  lines.push(`Tabungan neto: ${formatIDR(r.tabungan.neto_minor)}`);
  lines.push(`Piutang sisa: teman ${formatIDR(r.piutang.sisa_teman_minor)}, company ${formatIDR(r.piutang.sisa_company_minor)}`);
  lines.push(`Company bayar langsung: ${formatIDR(r.pengeluaran_company.dibayar_company_langsung_minor)}`);
  lines.push(`Saya talangi untuk company: ${formatIDR(r.pengeluaran_company.saya_talangi_minor)}`);
  if (r.tagihan_belum_dibayar.length) {
    lines.push('');
    lines.push('<b>Tagihan belum dibayar</b>');
    for (const t of r.tagihan_belum_dibayar.slice(0, 8)) {
      lines.push(`• ${esc(t.label)} ${formatIDR(t.nominal_minor)} ${t.tanggal ? formatTanggalSingkat(t.tanggal) : '-'} (${t.status})`);
    }
  }
  lines.push('');
  lines.push(`Saldo akhir bulan (proyeksi): <b>${formatIDR(p.ringkasan.saldo_akhir_minor)}</b>`);
  for (const c of r.catatan) lines.push(`ℹ️ ${esc(c)}`);
  return lines.join('\n');
}

export function ringkasan5Hari(database: DB = db()): string {
  const rep = periodReport({}, database);
  if (!rep.tersedia) return `⚠️ ${esc(rep.alasan ?? 'Periode belum dapat dibentuk.')}`;
  const b = rep.berjalan;
  if (!b) return 'Belum ada blok periode yang sedang berjalan.';
  const lines: string[] = [];
  lines.push(
    `<b>Periode ${rep.panjang_hari} hari: ${formatTanggal(b.mulai)} – ${formatTanggal(b.akhir)}</b>`,
  );
  lines.push(`Saldo awal: ${formatIDR(b.saldo_awal_minor)}`);
  lines.push(`Pemasukan aktual: ${formatIDR(b.pemasukan_aktual_minor)}`);
  lines.push(`Pemasukan rencana: ${formatIDR(b.pemasukan_rencana_minor)}`);
  lines.push(`Makan aktual: ${formatIDR(b.makan_aktual_minor)} | rencana: ${formatIDR(b.makan_rencana_minor)}`);
  lines.push(`Selisih anggaran makan: ${formatIDR(b.selisih_makan_minor)}`);
  lines.push(`Belanja: ${formatIDR(b.belanja_minor)} | Tagihan: ${formatIDR(b.tagihan_minor)}`);
  lines.push(`Sisa dana akhir periode: <b>${formatIDR(b.sisa_dana_minor)}</b>`);
  lines.push(`Status: ${IKON_RISIKO[b.status]} ${DAY_RISK_LABEL[b.status]}`);
  if (b.hari_defisit.length) lines.push(`Hari defisit: ${b.hari_defisit.map(formatTanggalSingkat).join(', ')}`);
  else if (b.hari_rendah.length) lines.push(`Hari rendah: ${b.hari_rendah.map(formatTanggalSingkat).join(', ')}`);
  return lines.join('\n');
}

export function daftarTagihan(hari = 30, database: DB = db()): string {
  const t = tagihanMendekat({ hari }, database);
  if (!t.daftar.length) return `Tidak ada tagihan terencana sampai ${formatTanggal(t.sampai)}.`;
  const lines: string[] = [`<b>Tagihan sampai ${formatTanggal(t.sampai)}</b>`];
  for (const d of t.daftar) {
    const tanda = [
      d.terlambat ? '⚠️ terlambat' : '',
      d.aktif_di_skenario ? '' : '(hanya di skenario lain)',
    ]
      .filter(Boolean)
      .join(' ');
    const pembayar =
      d.pembayar === 'company'
        ? 'company bayar langsung'
        : d.pembayar === 'saya'
          ? 'saya bayar'
          : 'pembayar belum jelas';
    lines.push(
      `• ${formatTanggalSingkat(d.tanggal)} ${esc(d.label)} — <b>${formatIDR(d.nominal_minor)}</b> ` +
        `(${d.penanggung}, ${pembayar}, ${labelKepastian(d.kepastian)}) ${tanda}`,
    );
  }
  lines.push('');
  lines.push(`Dana yang perlu disiapkan: <b>${formatIDR(t.dana_perlu_disiapkan_minor)}</b>`);
  if (t.jumlah_tanpa_nominal > 0) {
    lines.push(`⚠️ ${t.jumlah_tanpa_nominal} tagihan belum punya nominal, jadi angka di atas belum lengkap.`);
  }
  return lines.join('\n');
}

export function ringkasanAnggaran(database: DB = db()): string {
  const hariIni = today();
  const awal = startOfMonth(hariIni);
  const p = project({ dari: awal, sampai: endOfMonth(hariIni) }, database);
  const sampaiHariIni = p.hari.filter((d) => d.tanggal <= hariIni);
  const anggaranTerpakai = sampaiHariIni.reduce((s, d) => s + d.makan_aktual_minor, 0);
  const anggaranSeharusnya = sampaiHariIni.reduce((s, d) => s + d.anggaran_makan_minor, 0);
  const selisih = anggaranSeharusnya - anggaranTerpakai;

  const lines: string[] = [`<b>Anggaran ${esc(namaBulan(hariIni.slice(0, 7)))}</b>`];
  lines.push(`Makan sampai hari ini: ${formatIDR(anggaranTerpakai)} dari ${formatIDR(anggaranSeharusnya)}`);
  lines.push(selisih >= 0 ? `Masih hemat ${formatIDR(selisih)}` : `Lebih ${formatIDR(-selisih)} dari anggaran`);
  lines.push(`Anggaran makan harian: ${formatIDR(p.hari[0]?.anggaran_makan_minor ?? 0)}`);
  lines.push(`Cadangan minimal: ${formatIDR(p.ringkasan.cadangan_minimal_minor)}`);
  lines.push(`Belanja bulan ini: ${formatIDR(p.ringkasan.total_belanja_minor)}`);
  lines.push(`Tagihan bulan ini: ${formatIDR(p.ringkasan.total_tagihan_minor)}`);
  lines.push('');
  lines.push('<b>Asumsi dipakai</b>');
  for (const a of p.asumsi_dipakai) {
    lines.push(`• ${esc(a.key)}: ${String(a.value)} (${labelKepastian(a.certainty)}${a.dari_skenario ? ', dari skenario' : ''})`);
  }
  return lines.join('\n');
}

export function ringkasanTabungan(database: DB = db()): string {
  const s = savingsReport({}, database);
  const lines: string[] = ['<b>Tabungan</b>'];
  for (const r of s.rekening_tabungan) {
    lines.push(
      r.saldo_minor === null
        ? `• ${esc(r.nama)}: saldo belum dapat diverifikasi`
        : `• ${esc(r.nama)}${r.last4 ? ` ••${r.last4}` : ''}: <b>${formatIDR(r.saldo_minor)}</b>`,
    );
  }
  lines.push('');
  lines.push(`Setoran total: ${formatIDR(s.setoran_total_minor)}`);
  lines.push(`Penarikan total: ${formatIDR(s.penarikan_total_minor)}`);
  lines.push(`Neto: <b>${formatIDR(s.neto_minor)}</b>`);
  lines.push(`Bulan ini: setor ${formatIDR(s.bulan_ini.setoran_minor)}, tarik ${formatIDR(s.bulan_ini.penarikan_minor)}`);
  if (s.target_bulanan_minor > 0) {
    lines.push(`Target bulanan: ${formatIDR(s.target_bulanan_minor)} (${s.pencapaian_bulan_ini_persen ?? 0}%)`);
  }
  for (const c of s.catatan) lines.push(`ℹ️ ${esc(c)}`);
  return lines.join('\n');
}

export function ringkasanReimburse(database: DB = db()): string {
  const r = listReceivables({ onlyOpen: true }, database);
  if (!r.daftar.length) return 'Tidak ada piutang yang masih terbuka. 🎉';
  const lines: string[] = ['<b>Reimburse & talangan</b>'];
  lines.push(`Total belum kembali: <b>${formatIDR(r.total_sisa_minor)}</b>`);
  lines.push(`Teman: ${formatIDR(r.total_sisa_teman_minor)} | Company: ${formatIDR(r.total_sisa_company_minor)}`);
  lines.push('');
  for (const o of r.per_orang) {
    lines.push(
      `• ${esc(o.debtor_name)} (${o.debtor_type}): sisa <b>${formatIDR(o.sisa_minor)}</b> ` +
        `dari ${formatIDR(o.nominal_awal_minor)}, ${o.jumlah} item`,
    );
  }
  if (r.jumlah_terlambat > 0) {
    lines.push('');
    lines.push(`⚠️ ${r.jumlah_terlambat} piutang sudah lewat perkiraan tanggal kembali.`);
  }
  return lines.join('\n');
}

export function hasilSimulasi(h: SimulasiHasil): string {
  const ikon =
    h.verdict === 'aman' ? '🟢' : h.verdict === 'hati_hati' ? '🟡' : h.verdict === 'tidak_aman' ? '🔴' : '⚪';
  const lines: string[] = [];
  lines.push(`${ikon} <b>${esc(h.jawaban)}</b>`);
  lines.push('');
  for (const a of h.alasan) lines.push(`• ${esc(a)}`);
  if (h.dampak.tagihan_terdekat) {
    const aman =
      h.dampak.tagihan_masih_aman === null
        ? 'belum dapat dinilai'
        : h.dampak.tagihan_masih_aman
          ? 'masih bisa dibayar'
          : 'berisiko tidak terbayar';
    lines.push(`• Tagihan terdekat ${aman}.`);
  }
  if (h.dampak.piutang_bertambah_minor > 0) {
    lines.push(`• Piutang bertambah ${formatIDR(h.dampak.piutang_bertambah_minor)}.`);
  }
  if (h.ketidakpastian.length) {
    lines.push('');
    lines.push('<b>Yang belum pasti</b>');
    for (const k of h.ketidakpastian.slice(0, 5)) lines.push(`• ${esc(k.pesan)}`);
  }
  if (h.saran.length) {
    lines.push('');
    for (const s of h.saran) lines.push(`➡️ ${esc(s)}`);
  }
  return lines.join('\n');
}

export function bandingSkenario(database: DB = db()): string {
  const slugs = slugPerbandinganBawaan(database);
  if (slugs.length < 2) {
    return 'Belum ada skenario pembanding. Buat satu di web: Rencana → Skenario, misalnya "makan naik" atau "top-up terlambat".';
  }
  const hasil = bandingkanSkenario(slugs, {}, database);
  const lines: string[] = ['<b>Perbandingan skenario</b>'];
  for (const h of hasil) {
    lines.push('');
    lines.push(`<b>${esc(h.nama)}</b>`);
    lines.push(`Saldo akhir: ${formatIDR(h.saldo_akhir_minor)}`);
    lines.push(
      `Saldo terendah: ${formatIDR(h.saldo_terendah_minor)} pada ${formatTanggal(h.saldo_terendah_tanggal)}`,
    );
    lines.push(
      h.tanggal_defisit
        ? `⚠️ Defisit ${formatTanggal(h.tanggal_defisit)}; butuh tambahan ${formatIDR(h.kekurangan_agar_tidak_defisit_minor)}`
        : h.kekurangan_agar_cadangan_aman_minor > 0
          ? `Butuh ${formatIDR(h.kekurangan_agar_cadangan_aman_minor)} lagi agar cadangan minimal aman`
          : 'Cadangan minimal tetap aman',
    );
  }
  return lines.join('\n');
}

export function bantuan(): string {
  return [
    '<b>BUnih — apa saja yang bisa aku bantu</b>',
    '',
    '<b>Lihat posisi</b>',
    '/hari — posisi hari ini, saldo, tagihan terdekat',
    '/minggu — rekap minggu ini',
    '/bulan — rekap bulan ini',
    '/5hari — posisi blok lima hari yang sedang berjalan',
    '/skenario — bandingkan skenario rencana',
    '',
    '<b>Tagihan & anggaran</b>',
    '/tagihan — jatuh tempo, nominal, penanggung, dana yang perlu disiapkan',
    '/anggaran — pemakaian versus batas',
    '/tabungan — setoran, penarikan, saldo BCA',
    '/reimburse — siapa yang masih harus mengganti uangku',
    '',
    '<b>Catat & ubah</b>',
    '/belanja — tambah pembelian terencana atau mendadak',
    '/simulasi — "kalau aku beli barang RpX hari ini, bagaimana?"',
    '/koreksi — cari transaksi lalu ubah kategori, nominal, atau penanggung',
    '',
    '<b>Atau tulis biasa saja</b>',
    '• "makan 25 ribu" → dicatat sebagai pengeluaran makan',
    '• "itu makan berempat, aku cuma bayar 30 ribu" → dibagi, sisanya jadi piutang',
    '• "server ini direimburse company" → jadi klaim reimburse',
    '• "transfer 500 ribu ke BCA aku" → setoran tabungan, bukan pengeluaran',
    '• "kalau aku beli hp 3 juta hari ini gimana?" → simulasi dampak',
    '• "top up hari ini tidak masuk" → rencana ditandai tidak diterima',
    '',
    'Kirim foto kuitansi juga boleh — aku tampilkan hasil bacaannya dulu untuk kamu konfirmasi.',
  ].join('\n');
}
