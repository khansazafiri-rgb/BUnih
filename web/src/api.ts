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
