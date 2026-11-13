/** Tingkat kepastian sebuah angka. Selalu ditampilkan bersama angkanya. */
export type Certainty = 'terverifikasi' | 'perkiraan' | 'asumsi_sheet';

export const CERTAINTY_LABEL: Record<Certainty, string> = {
  terverifikasi: 'Aktual',
  perkiraan: 'Perkiraan',
  asumsi_sheet: 'Asumsi awal',
};

export type SourceKind = 'gmail' | 'telegram' | 'manual' | 'csv' | 'pdf' | 'sheet';

export type CashDirection = 'masuk' | 'keluar';

export type CashKind =
  | 'pemasukan_luar'
  | 'pengeluaran_pribadi'
  | 'pengeluaran_company_langsung'
  | 'pengeluaran_reimburse_company'
  | 'pengeluaran_bersama'
  | 'hadiah'
  | 'talangan'
  | 'transfer_internal'
  | 'setoran_tabungan'
  | 'penarikan_tabungan'
  | 'beli_kredit_layanan'
  | 'bayar_langganan'
  | 'refund'
  | 'koreksi'
  | 'belum_dikategorikan';

export const CASH_KIND_LABEL: Record<CashKind, string> = {
  pemasukan_luar: 'Pemasukan dari luar',
  pengeluaran_pribadi: 'Pengeluaran pribadi',
  pengeluaran_company_langsung: 'Biaya company (dibayar company)',
  pengeluaran_reimburse_company: 'Kubayar dulu, direimburse company',
  pengeluaran_bersama: 'Pembayaran bersama (diganti teman)',
  hadiah: 'Hadiah / beli untuk orang lain',
  talangan: 'Talangan (harus dibayar kembali)',
  transfer_internal: 'Transfer antar rekening saya',
  setoran_tabungan: 'Setoran tabungan',
  penarikan_tabungan: 'Penarikan tabungan',
  beli_kredit_layanan: 'Beli kredit layanan',
  bayar_langganan: 'Pembayaran langganan',
  refund: 'Pengembalian dana',
  koreksi: 'Koreksi',
  belum_dikategorikan: 'Belum dikategorikan',
};

export type AllocationPurpose =
  | 'biaya_pribadi'
  | 'piutang_teman'
  | 'piutang_company'
  | 'biaya_company_langsung'
  | 'transfer_internal'
  | 'tabungan'
  | 'kredit_layanan'
  | 'pelunasan_piutang'
  | 'pemasukan'
  | 'refund'
  | 'penyesuaian';

export type BearerType = 'saya' | 'teman' | 'company' | 'lainnya';
export type Bearer = 'pribadi' | 'company' | 'belum_jelas';
export type PaidBy = 'saya' | 'company' | 'belum_jelas';

export type CashStatus = 'terkonfirmasi' | 'menunggu_pasangan' | 'perlu_verifikasi' | 'dibatalkan';

export type InvoiceStatus =
  | 'tagihan_baru'
  | 'jatuh_tempo'
  | 'pembayaran_terdeteksi'
  | 'lunas_terkonfirmasi'
  | 'gagal_bayar'
  | 'refund'
  | 'dibatalkan'
  | 'perlu_verifikasi';

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  tagihan_baru: 'Tagihan baru',
  jatuh_tempo: 'Jatuh tempo',
  pembayaran_terdeteksi: 'Pembayaran terdeteksi',
  lunas_terkonfirmasi: 'Lunas terkonfirmasi',
  gagal_bayar: 'Gagal bayar',
  refund: 'Refund',
  dibatalkan: 'Dibatalkan',
  perlu_verifikasi: 'Perlu verifikasi',
};

export type ServiceStatus =
  | 'aktif'
  | 'opsional_skenario'
  | 'lunas_periode_ini'
  | 'akan_perpanjang'
  | 'dibatalkan'
  | 'tidak_dilanjutkan'
  | 'perlu_verifikasi'
  | 'kandidat';

export const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  aktif: 'Aktif',
  opsional_skenario: 'Opsional (skenario)',
  lunas_periode_ini: 'Sudah dibayar periode ini',
  akan_perpanjang: 'Akan diperpanjang',
  dibatalkan: 'Dibatalkan',
  tidak_dilanjutkan: 'Tidak dilanjutkan',
  perlu_verifikasi: 'Perlu verifikasi',
  kandidat: 'Kandidat (belum dikonfirmasi)',
};

export type BillingCycle = 'bulanan' | 'tahunan' | 'sesuai_pemakaian' | 'sekali' | 'belum_jelas';

export type DayRisk = 'aman' | 'rendah' | 'defisit';

export const DAY_RISK_LABEL: Record<DayRisk, string> = {
  aman: 'AMAN',
  rendah: 'RENDAH',
  defisit: 'DEFISIT',
};

export type TopupStatus = 'rencana' | 'diterima' | 'sebagian' | 'tidak_diterima' | 'dibatalkan';

export type ObligationKind =
  | 'langganan'
  | 'tagihan'
  | 'belanja_rencana'
  | 'makan_rencana'
  | 'cadangan_perpanjangan'
  | 'lainnya';

export type ReceivableStatus = 'belum_diklaim' | 'diklaim' | 'sebagian' | 'lunas' | 'dihapuskan';

/** Kunci asumsi yang dikenali mesin proyeksi. */
export const ASSUMPTION_KEYS = {
  anggaranMakanHarian: 'anggaran_makan_harian',
  cadanganMinimal: 'cadangan_minimal',
  topupNominal: 'topup_nominal',
  topupIntervalHari: 'topup_interval_hari',
  topupMulai: 'topup_mulai',
  periodeMulai: 'periode_mulai',
  periodePanjangHari: 'periode_panjang_hari',
  simulasiMulai: 'simulasi_mulai',
  simulasiAkhir: 'simulasi_akhir',
  targetTabunganBulanan: 'target_tabungan_bulanan',
  reimburseLagHari: 'reimburse_lag_hari',
} as const;

export type AssumptionKey = (typeof ASSUMPTION_KEYS)[keyof typeof ASSUMPTION_KEYS];

/** Tag skenario yang dipakai katalog layanan. */
export const SCENARIO_TAGS = {
  claudeProPribadi: 'claude_pro_pribadi',
} as const;
