import type { IsoDate } from '../domain/time.js';
import type { CashDirection, CashKind, InvoiceStatus } from '../domain/types.js';

/** Bentuk pesan email yang netral, agar parser dapat diuji tanpa Gmail. */
export type MailMessage = {
  id: string;
  threadId?: string;
  from: string;
  fromName?: string;
  to?: string;
  subject: string;
  /** Waktu terima, ISO. */
  date: string;
  /** Isi pesan sebagai teks biasa (HTML sudah dibersihkan). */
  text: string;
  headers?: Record<string, string>;
  permalink?: string;
  labelIds?: string[];
};

export type ParsedTransaction = {
  tipe: 'transaksi';
  occurred_at: string;
  direction: CashDirection;
  amount_minor: number;
  currency: string;
  kind: CashKind;
  merchant?: string | null;
  counterparty?: string | null;
  reference_no?: string | null;
  /** 4 digit terakhir dan nama bank bila tersedia di email. Nomor penuh tidak disimpan. */
  source_account_tail?: string | null;
  source_bank?: string | null;
  dest_account_tail?: string | null;
  dest_bank?: string | null;
  dest_name?: string | null;
  /** Diisi oleh lapisan sinkronisasi setelah dicocokkan ke daftar rekening saya. */
  dest_is_mine?: boolean | null;
  note?: string | null;
};

export type ParsedInvoice = {
  tipe: 'invoice';
  vendor: string;
  service_slug?: string | null;
  invoice_no?: string | null;
  issued_at?: string | null;
  due_date?: IsoDate | null;
  period_start?: IsoDate | null;
  period_end?: IsoDate | null;
  amount_minor: number | null;
  currency: string;
  status: InvoiceStatus;
  note?: string | null;
};

export type ParsedStatusChange = {
  tipe: 'status_tagihan';
  vendor: string;
  service_slug?: string | null;
  invoice_no?: string | null;
  status: InvoiceStatus;
  occurred_at: string;
  amount_minor?: number | null;
  currency?: string;
  note?: string | null;
};

/** Saldo yang disebut dalam email — TIDAK langsung dipakai sebagai saldo bank. */
export type ParsedBalanceHint = {
  tipe: 'saldo_disebut';
  account_hint?: string | null;
  balance_minor: number;
  currency: string;
  as_of: string;
  note?: string | null;
};

export type ParsedItem =
  | ParsedTransaction
  | ParsedInvoice
  | ParsedStatusChange
  | ParsedBalanceHint;

export type ParseResult = {
  parser: string;
  /** 0..1. Di bawah ambang, hasilnya masuk antrean verifikasi, bukan langsung jadi transaksi. */
  confidence: number;
  evidence_kind:
    | 'notifikasi_bank'
    | 'invoice'
    | 'kuitansi'
    | 'gagal_bayar'
    | 'pembatalan'
    | 'perpanjangan'
    | 'refund'
    | 'mutasi_rekening'
    | 'catatan_manual';
  items: ParsedItem[];
  /** Alasan sesuatu perlu diperiksa manusia. */
  catatan?: string[];
};

export type MailParser = {
  name: string;
  /** Pengirim yang diterima. Identitas pengirim diperiksa, bukan hanya subjek. */
  senders: RegExp[];
  matches: (msg: MailMessage) => boolean;
  parse: (msg: MailMessage) => ParseResult | null;
};

export const AMBANG_OTOMATIS = 0.8;
