import {
  findAccountTail, findAmount, findReference, labelValue, largestRupiah,
  parseDateLoose, parseTimeLoose, senderMatches, toInstant,
} from './helpers.js';
import { isPromotional } from '../classify.js';
import type { MailMessage, MailParser, ParseResult, ParsedTransaction } from '../types.js';

const SENDERS = [/@bca\.co\.id$/i, /@klikbca\.com$/i, /@bca\.id$/i, /\bbca\b/i];

export const bcaParser: MailParser = {
  name: 'bca-notifikasi',
  senders: SENDERS,
  matches(msg) {
    if (!senderMatches(msg.from, SENDERS)) return false;
    return /(rp|idr)\s?[\d.,]{3,}/i.test(`${msg.subject}\n${msg.text}`);
  },
  parse(msg: MailMessage): ParseResult | null {
    const promo = isPromotional(msg);
    if (promo.promo) {
      return {
        parser: this.name,
        confidence: 0,
        evidence_kind: 'notifikasi_bank',
        items: [],
        catatan: ['Dinilai sebagai email promosi BCA.', ...promo.alasan],
      };
    }

    const text = msg.text;
    const hay = `${msg.subject}\n${text}`.toLowerCase();
    const catatan: string[] = [];

    const amount =
      findAmount(text, ['Nominal', 'Jumlah', 'Amount', 'Total']) ??
      largestRupiah(`${msg.subject}\n${text}`);
    if (!amount) {
      return {
        parser: this.name,
        confidence: 0.2,
        evidence_kind: 'notifikasi_bank',
        items: [],
        catatan: ['Nominal tidak ditemukan.'],
      };
    }

    // Frasa eksplisit dana diterima lebih kuat daripada kata umum seperti 'pembayaran'.
    const masuk = /(dana masuk|uang masuk|transfer masuk|dana diterima|rekening dikredit|saldo bertambah|\bkredit\b|\bcr\b)/.test(hay);
    const keluar = /(debet|debit|uang keluar|pembayaran berhasil|transfer keluar|\bdb\b)/.test(hay);
    const direction: 'masuk' | 'keluar' = masuk && !keluar ? 'masuk' : 'keluar';
    if (masuk === keluar) catatan.push('Arah uang pada notifikasi BCA tidak jelas — perlu dikonfirmasi.');

    const tanggalRaw = labelValue(text, ['Tanggal', 'Date', 'Waktu']) ?? msg.date;
    const tanggal = parseDateLoose(tanggalRaw) ?? msg.date.slice(0, 10);
    const jam = parseTimeLoose(tanggalRaw) ?? parseTimeLoose(text);

    const tx: ParsedTransaction = {
      tipe: 'transaksi',
      occurred_at: toInstant(tanggal, jam),
      direction,
      amount_minor: amount.minor,
      currency: amount.currency,
      kind: direction === 'masuk' && masuk && !keluar ? 'pemasukan_luar' : 'belum_dikategorikan',
      merchant: labelValue(text, ['Keterangan', 'Berita', 'Remark', 'Merchant', 'Penerima']),
      counterparty: labelValue(text, ['Penerima', 'Pengirim', 'Nama']),
      reference_no: findReference(text),
      source_account_tail: direction === 'masuk' ? null : findAccountTail(text, ['Rekening', 'No\\.? Rekening', 'Account']),
      source_bank: direction === 'masuk' ? null : 'BCA',
      dest_account_tail: direction === 'masuk'
        ? findAccountTail(text, ['Rekening Penerima', 'Rekening Dikredit', 'Rekening', 'No\\.? Rekening', 'Account'], { tanpaCadangan: true })
        : findAccountTail(text, ['Rekening Tujuan', 'Tujuan'], { tanpaCadangan: true }),
      dest_bank: direction === 'masuk' ? 'BCA' : null,
      dest_name: null,
      dest_is_mine: null,
      note: catatan.length ? catatan.join(' ') : null,
    };

    return {
      parser: this.name,
      confidence: Math.min(0.9, 0.45 + (masuk !== keluar ? 0.3 : 0) + (tx.reference_no ? 0.15 : 0)),
      evidence_kind: 'notifikasi_bank',
      items: [tx],
      catatan,
    };
  },
};
