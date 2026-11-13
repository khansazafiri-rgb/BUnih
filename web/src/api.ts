export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function minta<T>(jalur: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${jalur}`, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let pesan = `Permintaan gagal (${res.status})`;
    try {
      const data = (await res.json()) as { pesan?: string; error?: string };
      pesan = data.pesan ?? data.error ?? pesan;
    } catch {
      /* biarkan pesan bawaan */
    }
    throw new ApiError(pesan, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(jalur: string) => minta<T>(jalur),
  post: <T>(jalur: string, body?: unknown) =>
    minta<T>(jalur, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(jalur: string, body?: unknown) =>
    minta<T>(jalur, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(jalur: string) => minta<T>(jalur, { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ tipe */

export type Kepastian = 'terverifikasi' | 'perkiraan' | 'asumsi_sheet';
export type Risiko = 'aman' | 'rendah' | 'defisit';

export type SaldoRekening = {
  account_id: number;
  name: string;
  bank: string;
  last4: string | null;
  is_savings_target: boolean;
  balance_minor: number | null;
  anchor_at: string | null;
  anchor_source: string | null;
  verified: boolean;
  catatan: string[];
};

export type RingkasanSaldo = {
  as_of: string;
  total_terverifikasi_minor: number;
  akun_terverifikasi: number;
  akun_belum_terverifikasi: string[];
  dalam_perjalanan_minor: number;
  dalam_perjalanan_jumlah: number;
  rekening: SaldoRekening[];
  lengkap: boolean;
  catatan: string[];
};

export type DriverHari = {
  label: string;
  amount_minor: number | null;
  direction: 'masuk' | 'keluar' | 'netral';
  bucket: string;
  certainty: Kepastian;
  jenis: 'aktual' | 'rencana';
  terlambat?: boolean;
  ref?: { tipe: string; id: number };
};

export type BarisHari = {
  tanggal: string;
  is_masa_lalu: boolean;
  is_hari_ini: boolean;
  saldo_awal_minor: number;
  masuk_aktual_minor: number;
  masuk_rencana_minor: number;
  reimburse_rencana_minor: number;
  makan_aktual_minor: number;
  makan_rencana_minor: number;
  rutin_lain_minor: number;
  belanja_minor: number;
  tagihan_minor: number;
  talangan_keluar_minor: number;
  transfer_keluar_minor: number;
  transfer_masuk_minor: number;
  biaya_company_minor: number;
  keluar_total_minor: number;
  saldo_akhir_minor: number;
  saldo_akhir_realisasi_minor: number | null;
  saldo_akhir_tanpa_reimburse_minor: number;
  status: Risiko;
  anggaran_makan_minor: number;
  selisih_makan_minor: number;
  drivers: DriverHari[];
  catatan: string[];
  risiko_belum_terhitung: string[];
};

export type RisikoItem = {
  tipe: string;
  pesan: string;
  tanggal?: string;
  nominal_minor?: number | null;
  ref?: { tipe: string; id: number };
};

export type Proyeksi = {
  dari: string;
  sampai: string;
  hari_ini: string;
  skenario: { slug: string; nama: string; deskripsi: string | null };
  dasar_saldo: { minor: number; certainty: Kepastian; sumber: string; catatan: string[] };
  hari: BarisHari[];
  ringkasan: {
    saldo_akhir_minor: number;
    saldo_akhir_realisasi_minor: number | null;
    saldo_terendah_minor: number;
    saldo_terendah_tanggal: string;
    saldo_terendah_tanpa_reimburse_minor: number;
    saldo_terendah_tanpa_reimburse_tanggal: string;
    tanggal_defisit: string | null;
    cadangan_minimal_minor: number;
    kekurangan_agar_tidak_defisit_minor: number;
    kekurangan_agar_cadangan_aman_minor: number;
    total_masuk_aktual_minor: number;
    total_masuk_rencana_minor: number;
    total_keluar_aktual_minor: number;
    total_keluar_rencana_minor: number;
    total_makan_aktual_minor: number;
    total_makan_rencana_minor: number;
    total_tagihan_minor: number;
    total_belanja_minor: number;
    total_biaya_company_minor: number;
    hari_rendah: string[];
    hari_defisit: string[];
  };
  risiko: RisikoItem[];
  asumsi_dipakai: Array<{ key: string; value: unknown; certainty: Kepastian; dari_skenario: boolean }>;
  peringatan: string[];
};

export type BlokPeriode = {
  index: number;
  mulai: string;
  akhir: string;
  is_berjalan: boolean;
  is_lampau: boolean;
  saldo_awal_minor: number;
  pemasukan_rencana_minor: number;
  pemasukan_aktual_minor: number;
  makan_rencana_minor: number;
  makan_aktual_minor: number;
  belanja_minor: number;
  tagihan_minor: number;
  biaya_company_minor: number;
  keluar_total_minor: number;
  saldo_akhir_minor: number;
  saldo_akhir_realisasi_minor: number | null;
  selisih_makan_minor: number;
  sisa_dana_minor: number;
  status: Risiko;
  hari_rendah: string[];
  hari_defisit: string[];
  catatan: string[];
};

export type LaporanPeriode = {
  tersedia: boolean;
  alasan?: string;
  panjang_hari: number;
  mulai_dari: string | null;
  skenario: { slug: string; nama: string };
  blok: BlokPeriode[];
  berjalan: BlokPeriode | null;
};

export type Beranda = {
  hari_ini: string;
  saldo: RingkasanSaldo;
  rekonsiliasi: Array<{ account_id: number; name: string; last_reconciled_at: string | null; umur_hari: number | null }>;
  hari_ini_detail: BarisHari | null;
  tagihan_terdekat: {
    obligation_id: number;
    label: string;
    tanggal: string;
    nominal_minor: number | null;
    kepastian: string;
    penanggung: string;
    pembayar: string;
    memotong_saldo_saya: boolean;
    terlambat: boolean;
    aktif_di_skenario: boolean;
  } | null;
  cukup_untuk_tagihan: {
    cukup: boolean;
    saldo_pada_tanggal_minor: number;
    kekurangan_minor: number;
    tanggal_efektif: string;
    terlambat: boolean;
  } | null;
  dana_tagihan_30_hari_minor: number;
  tagihan_tanpa_nominal: number;
  topup_berikutnya: { id: number; plan_date: string; plan_amount_minor: number; status: string } | null;
  periode_berjalan: BlokPeriode | null;
  periode_tersedia: boolean;
  periode_alasan: string | null;
  piutang: { total_sisa_minor: number; teman_minor: number; company_minor: number; jumlah_terlambat: number };
  skenario: {
    tanpa_claude: SkenarioRingkas;
    dengan_claude: SkenarioRingkas;
  };
  cadangan_minimal_minor: number;
  perlu_tindakan: {
    keputusan_terbuka: number;
    transaksi_belum_dikategorikan: number;
    transfer_menunggu_pasangan: number;
    asumsi_belum_terverifikasi: number;
    layanan_perlu_verifikasi: number;
    langganan_tertagih_setelah_dibatalkan: number;
  };
  risiko: RisikoItem[];
  peringatan: string[];
};

export type SkenarioRingkas = {
  nama: string;
  saldo_terendah_minor: number;
  saldo_terendah_tanggal: string;
  tanggal_defisit: string | null;
  saldo_akhir_minor: number;
};

export type Transaksi = {
  id: number;
  occurred_at: string;
  direction: 'masuk' | 'keluar';
  amount_minor: number;
  currency: string;
  account_id: number | null;
  kind: string;
  merchant_raw: string | null;
  counterparty: string | null;
  reference_no: string | null;
  status: string;
  certainty: Kepastian;
  transfer_group_id: string | null;
  source: string;
  note: string | null;
  rekening: string | null;
  kategori: string | null;
  merchant_nama?: string | null;
  layanan: string | null;
  jumlah_bukti: number;
};

export type Layanan = {
  id: number;
  slug: string;
  name: string;
  vendor: string;
  bearer: string;
  paid_by: string;
  billing_cycle: string;
  amount_minor: number | null;
  currency: string;
  amount_certainty: Kepastian;
  next_due_date: string | null;
  due_date_certainty: Kepastian;
  status: string;
  scenario_tag: string | null;
  benefit_period_end: string | null;
  reserve_for_renewal_minor: number | null;
  note: string | null;
  jumlah_invoice: number;
  jumlah_pembayaran: number;
  total_dibayar_minor: number;
  pembayaran_terakhir: string | null;
};

export type Keputusan = {
  id: number;
  kind: string;
  cash_event_id: number | null;
  invoice_id: number | null;
  question: string;
  options_json: string;
  state: string;
  priority: number;
  created_at: string;
};

export type HasilSimulasi = {
  pertanyaan: string;
  jawaban: string;
  verdict: 'aman' | 'hati_hati' | 'tidak_aman' | 'belum_pasti';
  tanggal: string;
  harga_minor: number | null;
  beban_pribadi_minor: number | null;
  sebelum: { saldo_akhir_minor: number; saldo_terendah_minor: number; saldo_terendah_tanggal: string; tanggal_defisit: string | null; cadangan_minimal_minor: number };
  sesudah: { saldo_akhir_minor: number; saldo_terendah_minor: number; saldo_terendah_tanggal: string; tanggal_defisit: string | null; cadangan_minimal_minor: number };
  dampak: {
    saldo_terendah_turun_minor: number;
    melewati_cadangan: boolean;
    kekurangan_dari_cadangan_minor: number;
    membuat_defisit: boolean;
    tanggal_defisit: string | null;
    tagihan_terdekat: { label: string; tanggal: string; nominal_minor: number | null; penanggung: string } | null;
    tagihan_masih_aman: boolean | null;
    piutang_bertambah_minor: number;
    saldo_terendah_sebelum_topup_minor: number | null;
    tanggal_topup_berikutnya: string | null;
  };
  alasan: string[];
  ketidakpastian: RisikoItem[];
  saran: string[];
};

/* ====================================================================== v2 */

export type StatusAnggaran = 'aman' | 'berisiko' | 'lewat' | 'belum_mulai' | 'selesai';

export type Anggaran = {
  id: number;
  nama: string;
  kategori_id: number | null;
  kategori_nama: string | null;
  kategori_ikon: string | null;
  periode: 'harian' | 'mingguan' | 'bulanan' | 'kustom';
  berulang: boolean;
  rollover: boolean;
  jendela: { dari: string; sampai: string; total_hari: number };
  nominal_periode_minor: number;
  carry_minor: number;
  dialokasikan_minor: number;
  terpakai_minor: number;
  sisa_minor: number;
  persen_terpakai: number;
  hari_berjalan: number;
  hari_tersisa: number;
  sisa_per_hari_minor: number;
  jadwal_minor: number;
  lebih_cepat_dari_jadwal: boolean;
  perkiraan_akhir_minor: number | null;
  perkiraan_terbatas: boolean;
  status: StatusAnggaran;
  status_teks: string;
};

export type RisikoTujuan =
  | 'tercapai' | 'tepat' | 'berisiko' | 'terlambat' | 'belum_ada_setoran' | 'tanpa_tanggal' | 'dijeda' | 'dibatalkan';

export type Tujuan = {
  id: number;
  nama: string;
  ikon: string | null;
  status: 'aktif' | 'dijeda' | 'tercapai' | 'dibatalkan';
  target_minor: number;
  mulai_minor: number;
  terkumpul_minor: number;
  dari_transfer_tercatat_minor: number;
  disisihkan_minor: number;
  sisa_minor: number;
  persen: number;
  target_date: string | null;
  hari_tersisa: number | null;
  perlu_per_bulan_minor: number | null;
  perlu_per_minggu_minor: number | null;
  laju_bulanan_minor: number;
  perkiraan_tercapai: string | null;
  risiko: RisikoTujuan;
  penjelasan: string;
  rekening_nama: string | null;
  pengingat: boolean;
  catatan: string | null;
};

export type KategoriBaris = {
  category_id: number | null;
  nama: string;
  ikon: string;
  jumlah_minor: number;
  persen: number;
  jumlah_transaksi: number;
  sebelumnya_minor: number;
  perubahan_persen: number | null;
  belum_dikategorikan: boolean;
  anak: Array<{ category_id: number | null; nama: string; ikon: string; jumlah_minor: number; jumlah_transaksi: number }>;
};

export type MerchantBaris = {
  merchant_id: number | null;
  nama: string;
  jumlah_transaksi: number;
  total_minor: number;
  rata_rata_minor: number;
  pertama: string;
  terakhir: string;
  sebelumnya_transaksi: number;
  sebelumnya_total_minor: number;
  perubahan_transaksi: number;
};

export type TitikTren = { awal: string; akhir: string; label: string; pengeluaran_minor: number; pemasukan_minor: number };

export type Insight = {
  kunci: string;
  tingkat: 'info' | 'perhatian' | 'baik';
  teks: string;
  angka: Record<string, number | string | null>;
  rincian?: { kategori_id?: number | null; merchant_id?: number | null; tanpa_kategori?: boolean };
};

export type Rentang = {
  preset: string;
  label: string;
  dari: string;
  sampai: string;
  hari: number;
  sebelumnya: { dari: string; sampai: string; hari: number; label: string };
};

export type DataAnalitik = {
  rentang: Rentang;
  ringkasan: {
    pemasukan_minor: number;
    pemasukan_sebelumnya_minor: number;
    arus_kas_masuk_minor: number;
    arus_kas_keluar_minor: number;
    arus_kas_neto_minor: number;
    pengeluaran_pribadi_neto_minor: number;
    pengeluaran_pribadi_sebelumnya_minor: number;
    perubahan_persen: number | null;
    saldo_terverifikasi_minor: number | null;
    saldo_lengkap: boolean;
    tabungan_neto_minor: number;
    tujuan: { jumlah_aktif: number; terkumpul_minor: number; target_minor: number };
    anggaran: { jumlah: number; aman: number; berisiko: number; lewat: number; keseluruhan: Anggaran | null };
  };
  kualitas_data: {
    belum_dikategorikan_jumlah: number;
    belum_dikategorikan_minor: number;
    perlu_verifikasi_jumlah: number;
    tanpa_merchant_jumlah: number;
    jumlah_transaksi: number;
  };
  kategori: KategoriBaris[];
  merchant: { paling_sering: MerchantBaris[]; paling_besar_total: MerchantBaris[]; kebiasaan_berubah: MerchantBaris[] };
  makanan: {
    tersedia: boolean;
    alasan?: string;
    total_minor: number;
    jumlah_transaksi: number;
    rata_per_hari_minor: number;
    hari_berjalan: number;
    hari_dengan_catatan: number;
    hari_tanpa_catatan: number;
    sebelumnya_total_minor: number;
    perubahan_persen: number | null;
    paling_sering: MerchantBaris[];
    paling_besar_total: MerchantBaris[];
    transaksi_termahal: Array<{ cash_event_id: number; tanggal: string; merchant: string; jumlah_minor: number }>;
    tren_bulanan: Array<{ bulan: string; label: string; total_minor: number }>;
    anggaran: Anggaran | null;
    tanpa_merchant_jumlah: number;
  };
  tren: { granularitas: 'harian' | 'mingguan' | 'bulanan'; titik: TitikTren[] };
  berulang_vs_sesuka: { berulang_minor: number; sesuka_minor: number; persen_berulang: number };
  tidak_biasa: Array<{ cash_event_id: number; tanggal: string; merchant: string; kategori: string; jumlah_minor: number; biasanya_minor: number; sampel: number; alasan: string }>;
  langganan: {
    total_bulanan_pribadi_minor: number;
    total_bulanan_company_minor: number;
    jumlah_aktif: number;
    tanpa_nominal: number;
    per_jenis: Array<{ jenis: string; bulanan_minor: number; jumlah: number }>;
    akan_ditagih: Array<{ service_id: number; nama: string; tanggal: string | null; nominal_minor: number | null; penanggung: string }>;
    kenaikan_biaya: Array<{ service_id: number; nama: string; dari_minor: number; ke_minor: number; persen: number }>;
    mungkin_tidak_dibutuhkan: Array<{ service_id: number; nama: string; terakhir_dibayar: string; alasan: string }>;
  };
  insight: Insight[];
};

export type BarisRincian = {
  alokasi_id: number;
  cash_event_id: number;
  tanggal: string;
  waktu: string;
  merchant: string;
  kategori: string;
  jumlah_minor: number;
  kind: string;
  project: string | null;
  status: string;
  rekening: string | null;
  refund: boolean;
};

export type DataRincian = { total_minor: number; jumlah_potongan: number; jumlah_transaksi: number; terpotong: boolean; baris: BarisRincian[] };

export type Wajah = 'senang' | 'biasa' | 'khawatir' | 'kosong';

export type DataDashboard = {
  hari_ini: string;
  bulan: string;
  adaData: boolean;
  jawaban: { wajah: Wajah; judul: string; kalimat: string; alasan: string[] };
  uang: {
    saldo_terverifikasi_minor: number | null;
    lengkap: boolean;
    rekening: Array<{ nama: string; last4: string | null; saldo_minor: number | null; tabungan: boolean }>;
    dalam_perjalanan_minor: number;
    catatan: string[];
  };
  pemakaian: {
    dari: string;
    sampai: string;
    hari_berjalan: number;
    hari_dalam_bulan: number;
    total_minor: number;
    sebelumnya_minor: number;
    sebelumnya_label: string;
    perubahan_persen: number | null;
    rata_per_hari_minor: number;
    kategori: Array<{ category_id: number | null; nama: string; ikon: string; jumlah_minor: number; persen: number; belum_dikategorikan: boolean }>;
    lainnya_minor: number;
    lainnya_jumlah: number;
  };
  tujuh_hari: Array<{ tanggal: string; label: string; jumlah_minor: number; hari_ini: boolean }>;
  anggaran: Anggaran[];
  anggaran_total: number;
  tujuan: Tujuan[];
  tujuan_total: number;
  tagihan: {
    daftar: Array<{ obligation_id: number; label: string; tanggal: string; nominal_minor: number | null; kepastian: string; penanggung: string; pembayar: string; terlambat: boolean }>;
    dana_14_hari_minor: number;
    tanpa_nominal: number;
  };
  proyeksi: { saldo_terendah_minor: number; saldo_terendah_tanggal: string; tanggal_defisit: string | null } | null;
  perlu_perhatian: Array<{ tipe: string; teks: string; tautan: string }>;
  insight: Insight[];
  mulai: { langkah: Array<{ kunci: string; label: string; selesai: boolean; tautan: string }>; selesai: boolean; ditutup: boolean };
};

export type KategoriFlat = {
  id: number;
  slug: string;
  name: string;
  group_name: string;
  parent_id: number | null;
  active: number;
  icon: string | null;
  sort_order: number;
};

export type KategoriNode = KategoriFlat & { jumlah_transaksi: number; anak: KategoriNode[] };

export type MerchantRingkas = {
  id: number;
  name: string;
  name_norm: string;
  default_category_id: number | null;
  kategori_bawaan: string | null;
  alias: Array<{ id: number; alias_raw: string | null; source: string }>;
  jumlah_transaksi: number;
  total_pengeluaran_minor: number;
  terakhir: string | null;
};
