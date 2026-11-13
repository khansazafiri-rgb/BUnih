/**
 * Rencana uang jangka pendek, dibuat supaya mudah ditindaklanjuti.
 *
 * Alih-alih berkata "kekurangan Rp2 juta" (angka besar yang membingungkan dan bergantung pada
 * proyeksi 30 hari), modul ini menjawab empat pertanyaan praktis:
 *   1. Tenggat terdekat apa saja dan berapa?
 *   2. Berapa yang harus siap dalam 7 hari ke depan?
 *   3. Berapa uang yang sebaiknya SUDAH ADA sekarang?
 *   4. Kalau kurang: berapa batas belanja harian berikutnya, dan berapa yang perlu masuk sebelum kapan?
 *
 * Semua angka dihitung dari tagihan terjadwal, anggaran makan, cadangan minimal, dan saldo yang sama
 * dengan proyeksi. Bila saldo belum terverifikasi, hasilnya diberi label perkiraan.
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { balanceSummary } from './balances.js';
import { project } from './projection.js';
import { tagihanMendekat } from './services.js';
import { addDays, today, type IsoDate } from './time.js';

export type Tenggat = { label: string; tanggal: IsoDate; nominal_minor: number; hari_lagi: number };

export type RencanaUang = {
  horizon_hari: number;
  tenggat_terdekat: Tenggat[];
  tagihan_tanpa_nominal: number;
  tagihan_7_hari_minor: number;
  makan_7_hari_minor: number;
  /** Tagihan + makan 7 hari: yang HARUS siap. */
  kebutuhan_7_hari_minor: number;
  cadangan_minimal_minor: number;
  /** Uang yang sebaiknya sudah ada sekarang = kebutuhan 7 hari + cadangan minimal. */
  disarankan_sekarang_minor: number;
  saldo_sekarang_minor: number | null;
  terverifikasi: boolean;
  status: 'aman' | 'ketat' | 'kurang' | 'saldo_belum_diketahui';
  /** Selisih terhadap yang disarankan; null bila saldo belum diketahui. Positif = lebih. */
  selisih_minor: number | null;
  /** Batas belanja harian di luar tagihan (makan, transport, dll) agar tetap aman 7 hari. */
  batas_harian_minor: number | null;
  anggaran_makan_harian_minor: number;
  /** Bila kurang: jumlah yang perlu masuk, dan tanggal paling lambat (tenggat pertama yang belum tertutup). */
  perlu_masuk_minor: number;
  perlu_masuk_sebelum: IsoDate | null;
  /** Kalimat rencana yang siap tampil. */
  rencana: string;
  /**
   * Bila proyeksi menunjukkan uang menipis setelah 7 hari: berapa batas belanja harian di luar tagihan
   * supaya tetap aman sampai tanggal itu. null bila tidak ada tanggal menipis atau saldo belum diketahui.
   */
  sampai_menipis: {
    tanggal: IsoDate;
    hari_lagi: number;
    tagihan_minor: number;
    batas_harian_minor: number;
    perlu_masuk_minor: number;
  } | null;
};

const HARI = 7;

export function rencanaUang(database: DB = db(), hariIni: IsoDate = today(), tanggalMenipis: IsoDate | null = null): RencanaUang {
  const t = tagihanMendekat({ hari: 14, asOf: hariIni }, database);
  const dihitung = t.daftar.filter((d) => d.aktif_di_skenario && d.memotong_saldo_saya && d.nominal_minor !== null);
  const dalamTujuh = dihitung.filter((d) => d.tanggal <= addDays(hariIni, HARI));
  const tagihan7 = dalamTujuh.reduce((s, d) => s + (d.nominal_minor ?? 0), 0);

  const p = project({ dari: hariIni, sampai: addDays(hariIni, HARI) }, database);
  const makanHarian = p.hari[0]?.anggaran_makan_minor ?? 0;
  const makan7 = p.hari.slice(0, HARI).reduce((s, d) => s + d.anggaran_makan_minor, 0);
  const cadangan = p.ringkasan.cadangan_minimal_minor;

  const ringkasanSaldo = balanceSummary(undefined, database);
  const terverifikasi = ringkasanSaldo.akun_terverifikasi > 0 && !p.risiko.some((r) => r.tipe === 'saldo_belum_terverifikasi');
  const saldoDiketahui = ringkasanSaldo.akun_terverifikasi > 0 || p.hari[0] !== undefined;
  const hariIniRow = p.hari[0];
  const saldo = saldoDiketahui ? (hariIniRow?.saldo_akhir_realisasi_minor ?? hariIniRow?.saldo_awal_minor ?? null) : null;

  const kebutuhan = tagihan7 + makan7;
  const disarankan = kebutuhan + cadangan;
  const selisih = saldo === null ? null : saldo - disarankan;

  let status: RencanaUang['status'];
  if (saldo === null) status = 'saldo_belum_diketahui';
  else if (saldo >= disarankan) status = saldo - disarankan < makan7 * 0.25 ? 'ketat' : 'aman';
  else status = 'kurang';

  // Batas belanja harian di luar tagihan: dana bebas (di atas tagihan dan cadangan) dibagi 7 hari.
  const danaBebas = saldo === null ? null : saldo - tagihan7 - cadangan;
  const batasHarian = danaBebas === null ? null : Math.max(0, Math.floor(danaBebas / HARI / 1000) * 1000);

  const perluMasuk = saldo === null ? 0 : Math.max(0, disarankan - saldo);
  // Tanggal paling lambat: tenggat pertama yang tidak lagi tertutup oleh saldo.
  let sisa = saldo ?? 0;
  let sebelum: IsoDate | null = null;
  if (saldo !== null && saldo < tagihan7 + cadangan) {
    let kumulatif = 0;
    for (const d of dalamTujuh) {
      kumulatif += d.nominal_minor ?? 0;
      if (sisa - kumulatif < cadangan) {
        sebelum = d.tanggal;
        break;
      }
    }
    if (!sebelum) sebelum = addDays(hariIni, HARI);
  }

  // Rencana sampai tanggal uang diperkirakan menipis (bila lewat 7 hari): berapa batas harian agar aman.
  let sampaiMenipis: RencanaUang['sampai_menipis'] = null;
  if (saldo !== null && tanggalMenipis && tanggalMenipis > hariIni) {
    const hariLagi = Math.max(1, Math.round((Date.parse(`${tanggalMenipis}T00:00:00Z`) - Date.parse(`${hariIni}T00:00:00Z`)) / 86_400_000));
    const panjang = tagihanMendekat({ hari: Math.min(60, hariLagi), asOf: hariIni }, database);
    const tagihanSampai = panjang.daftar
      .filter((d) => d.aktif_di_skenario && d.memotong_saldo_saya && d.nominal_minor !== null && d.tanggal <= tanggalMenipis)
      .reduce((s2, d) => s2 + (d.nominal_minor ?? 0), 0);
    const bebas = saldo - tagihanSampai - cadangan;
    sampaiMenipis = {
      tanggal: tanggalMenipis,
      hari_lagi: hariLagi,
      tagihan_minor: tagihanSampai,
      batas_harian_minor: Math.max(0, Math.floor(bebas / hariLagi / 1000) * 1000),
      perlu_masuk_minor: Math.max(0, -bebas),
    };
  }

  const rp = (n: number) => `Rp${Math.round(n).toLocaleString('id-ID')}`;
  let rencana: string;
  if (saldo === null) {
    rencana = 'Saldo belum dikonfirmasi, jadi aku belum bisa menyebut kamu aman atau kurang. Konfirmasi saldo di /rekening dulu.';
  } else if (status === 'kurang') {
    const bagianBatas =
      batasHarian !== null && batasHarian > 0
        ? `Batasi belanja di luar tagihan maksimal ${rp(batasHarian)} per hari (anggaran makan ${rp(makanHarian)}/hari), tunda pembelian besar, `
        : 'Tahan semua pembelian yang bisa ditunda, ';
    rencana = `${bagianBatas}dan siapkan pemasukan/top-up ${rp(perluMasuk)}${sebelum ? ` sebelum ${sebelum}` : ''}.`;
  } else if (status === 'ketat') {
    rencana = `Cukup, tapi tipis. Jaga belanja di luar tagihan sekitar ${rp(batasHarian ?? 0)} per hari.`;
  } else {
    rencana = `Aman untuk 7 hari ke depan. Boleh belanja di luar tagihan sampai sekitar ${rp(batasHarian ?? 0)} per hari.`;
  }

  return {
    horizon_hari: HARI,
    tenggat_terdekat: dihitung.slice(0, 4).map((d) => ({
      label: d.label,
      tanggal: d.tanggal,
      nominal_minor: d.nominal_minor ?? 0,
      hari_lagi: Math.round((Date.parse(`${d.tanggal}T00:00:00Z`) - Date.parse(`${hariIni}T00:00:00Z`)) / 86_400_000),
    })),
    tagihan_tanpa_nominal: t.jumlah_tanpa_nominal,
    tagihan_7_hari_minor: tagihan7,
    makan_7_hari_minor: makan7,
    kebutuhan_7_hari_minor: kebutuhan,
    cadangan_minimal_minor: cadangan,
    disarankan_sekarang_minor: disarankan,
    saldo_sekarang_minor: saldo,
    terverifikasi,
    status,
    selisih_minor: selisih,
    batas_harian_minor: batasHarian,
    anggaran_makan_harian_minor: makanHarian,
    perlu_masuk_minor: perluMasuk,
    perlu_masuk_sebelum: sebelum,
    rencana,
    sampai_menipis: sampaiMenipis,
  };
}

export function teksRencanaUang(r: RencanaUang, esc: (s: string) => string, tanggalSingkat: (d: IsoDate) => string): string {
  const rp = (n: number) => esc(`Rp${Math.round(n).toLocaleString('id-ID')}`);
  const baris: string[] = [];
  baris.push(`📅 <b>Tenggat terdekat</b>`);
  if (r.tenggat_terdekat.length === 0) baris.push('Tidak ada tagihan terjadwal dalam 14 hari.');
  for (const d of r.tenggat_terdekat) {
    baris.push(`• ${esc(tanggalSingkat(d.tanggal))} (${d.hari_lagi <= 0 ? 'hari ini/terlambat' : `${d.hari_lagi} hari lagi`}) — ${esc(d.label)} ${rp(d.nominal_minor)}`);
  }
  if (r.tagihan_tanpa_nominal > 0) baris.push(`<i>${r.tagihan_tanpa_nominal} tagihan belum ada nominalnya, belum ikut dihitung.</i>`);
  baris.push('');
  baris.push(`💼 <b>Harus siap 7 hari ke depan: ${rp(r.kebutuhan_7_hari_minor)}</b>`);
  baris.push(`   tagihan ${rp(r.tagihan_7_hari_minor)} + makan ${rp(r.makan_7_hari_minor)}`);
  baris.push(`🎯 <b>Uang yang sebaiknya sudah ada sekarang: ${rp(r.disarankan_sekarang_minor)}</b>`);
  baris.push(`   (kebutuhan 7 hari + cadangan minimal ${rp(r.cadangan_minimal_minor)})`);
  baris.push(
    r.saldo_sekarang_minor === null
      ? '💳 Saldo sekarang: <i>belum dikonfirmasi</i>'
      : `💳 Saldo sekarang: ${rp(r.saldo_sekarang_minor)}${r.terverifikasi ? '' : ' <i>(perkiraan — belum diverifikasi)</i>'}`,
  );
  baris.push('');
  baris.push(`🗒️ <b>Rencana:</b> ${esc(r.rencana)}`);
  if (r.sampai_menipis) {
    const m = r.sampai_menipis;
    baris.push('');
    baris.push(`📆 <b>Menjelang ${esc(tanggalSingkat(m.tanggal))} (${m.hari_lagi} hari lagi) uangmu diperkirakan menipis.</b>`);
    // Bila 7 hari ke depan saja sudah kurang, jangan menumpuk dua angka batas harian yang berbeda:
    // rencana di atas sudah menjadi yang berlaku.
    if (r.status !== 'kurang') {
      baris.push(
        m.perlu_masuk_minor > 0
          ? `   Supaya tetap aman sampai tanggal itu, siapkan pemasukan ${rp(m.perlu_masuk_minor)} atau tunda pengeluaran yang bisa ditunda. Tagihan sampai saat itu ${rp(m.tagihan_minor)}.`
          : `   Supaya tetap aman sampai tanggal itu, batasi belanja di luar tagihan sekitar ${rp(m.batas_harian_minor)} per hari (tagihan sampai saat itu ${rp(m.tagihan_minor)}).`,
      );
    }
  }
  return baris.join('\n');
}
