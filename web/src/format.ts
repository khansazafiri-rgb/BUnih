const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];
const BULAN_SINGKAT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

/** 349000 -> "Rp349.000". null -> "belum diketahui". */
export function rupiah(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return 'belum diketahui';
  const neg = minor < 0;
  const grouped = Math.abs(Math.trunc(minor)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '−' : ''}Rp${grouped}`;
}

/** Bentuk ringkas untuk sumbu grafik: Rp1,2jt / Rp350rb. */
export function rupiahRingkas(minor: number): string {
  const abs = Math.abs(minor);
  const tanda = minor < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${tanda}Rp${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace('.', ',')}jt`;
  if (abs >= 1_000) return `${tanda}Rp${Math.round(abs / 1_000)}rb`;
  return `${tanda}Rp${abs}`;
}

export function tanggal(iso: string | null | undefined): string {
  if (!iso) return '-';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${BULAN[m - 1]} ${y}`;
}

export function tanggalSingkat(iso: string | null | undefined): string {
  if (!iso) return '-';
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!m || !d) return String(iso);
  return `${d} ${BULAN_SINGKAT[m - 1]}`;
}

export function tanggalHari(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${HARI[dow]}, ${tanggal(iso)}`;
}

export function jam(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

export function namaBulan(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return `${BULAN[m - 1]} ${y}`;
}

export function hariLagi(iso: string, hariIni: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${hariIni}T00:00:00Z`)) / 86_400_000);
}

export function tambahHari(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const LABEL_KEPASTIAN: Record<string, string> = {
  terverifikasi: 'Aktual',
  perkiraan: 'Perkiraan',
  asumsi_sheet: 'Asumsi Sheet',
};

export const LABEL_JENIS: Record<string, string> = {
  pemasukan_luar: 'Pemasukan dari luar',
  pengeluaran_pribadi: 'Pengeluaran pribadi',
  pengeluaran_company_langsung: 'Biaya company (dibayar company)',
  pengeluaran_reimburse_company: 'Kubayar dulu, direimburse company',
  pengeluaran_bersama: 'Pembayaran bersama',
  hadiah: 'Hadiah',
  talangan: 'Talangan',
  transfer_internal: 'Transfer antar rekening saya',
  setoran_tabungan: 'Setoran tabungan',
  penarikan_tabungan: 'Penarikan tabungan',
  beli_kredit_layanan: 'Beli kredit layanan',
  bayar_langganan: 'Pembayaran langganan',
  refund: 'Pengembalian dana',
  koreksi: 'Koreksi',
  belum_dikategorikan: 'Belum dikategorikan',
};

export const LABEL_STATUS_TRANSAKSI: Record<string, string> = {
  terkonfirmasi: 'Terkonfirmasi',
  menunggu_pasangan: 'Menunggu pasangan',
  perlu_verifikasi: 'Perlu verifikasi',
  dibatalkan: 'Dibatalkan',
};

export const LABEL_STATUS_TAGIHAN: Record<string, string> = {
  tagihan_baru: 'Tagihan baru',
  jatuh_tempo: 'Jatuh tempo',
  pembayaran_terdeteksi: 'Pembayaran terdeteksi',
  lunas_terkonfirmasi: 'Lunas terkonfirmasi',
  gagal_bayar: 'Gagal bayar',
  refund: 'Refund',
  dibatalkan: 'Dibatalkan',
  perlu_verifikasi: 'Perlu verifikasi',
};

export const LABEL_STATUS_LAYANAN: Record<string, string> = {
  aktif: 'Aktif',
  opsional_skenario: 'Opsional (skenario)',
  lunas_periode_ini: 'Sudah dibayar periode ini',
  akan_perpanjang: 'Akan diperpanjang',
  dibatalkan: 'Dibatalkan',
  tidak_dilanjutkan: 'Tidak dilanjutkan',
  perlu_verifikasi: 'Perlu verifikasi',
  kandidat: 'Kandidat',
};

export const LABEL_SIKLUS: Record<string, string> = {
  bulanan: 'Bulanan',
  tahunan: 'Tahunan',
  sesuai_pemakaian: 'Sesuai pemakaian',
  sekali: 'Sekali bayar',
  belum_jelas: 'Belum jelas',
};

/** Ubah "30rb", "1,5jt", "Rp25.000" menjadi angka rupiah. */
export function bacaRupiah(teks: string): number | null {
  const t = teks.trim().toLowerCase();
  if (!t) return null;
  const jt = t.match(/([\d.,]+)\s*(jt|juta)/);
  if (jt?.[1]) return Math.round(Number(jt[1].replace(/\./g, '').replace(',', '.')) * 1_000_000);
  const rb = t.match(/([\d.,]+)\s*(rb|ribu|k)\b/);
  if (rb?.[1]) return Math.round(Number(rb[1].replace(/\./g, '').replace(',', '.')) * 1_000);
  const digits = t.replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}
