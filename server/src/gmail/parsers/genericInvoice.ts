import {
  findAmount, findDueDate, findInvoiceNo, findPeriod, largestRupiah, parseDateLoose, toInstant,
} from './helpers.js';
import { isPromotional, transactionSignals } from '../classify.js';
import { findVendor, detectDocKind } from './vendors.js';
import type { MailMessage, MailParser, ParseResult, ParsedInvoice } from '../types.js';

/**
 * Parser cadangan untuk layanan AI/server lain yang belum ada di katalog.
 * Hasilnya SELALU berkepastian rendah dan menjadi kandidat yang harus
 * dikonfirmasi, bukan langsung aturan berulang.
 */
export const genericInvoiceParser: MailParser = {
  name: 'invoice-umum',
  senders: [/.*/],
  matches(msg) {
    if (findVendor(msg)) return false; // sudah ditangani parser vendor
    const docKind = detectDocKind(msg);
    if (docKind === 'tidak_jelas') return false;
    return transactionSignals(msg) >= 2;
  },
  parse(msg: MailMessage): ParseResult | null {
    const promo = isPromotional(msg);
    if (promo.promo) {
      return {
        parser: this.name,
        confidence: 0,
        evidence_kind: 'invoice',
        items: [],
        catatan: ['Dinilai email promosi.', ...promo.alasan],
      };
    }

    const docKind = detectDocKind(msg);
    const text = msg.text;
    const amount =
      findAmount(text, ['Amount due', 'Total', 'Nominal', 'Jumlah', 'Amount']) ??
      largestRupiah(`${msg.subject}\n${text}`);
    if (!amount) return null;

    const domain = msg.from.split('@')[1] ?? msg.from;
    const periode = findPeriod(text);
    const issued = parseDateLoose(msg.date) ?? msg.date.slice(0, 10);

    const invoice: ParsedInvoice = {
      tipe: 'invoice',
      vendor: domain,
      service_slug: null,
      invoice_no: findInvoiceNo(text),
      issued_at: issued,
      due_date: findDueDate(text),
      period_start: periode.start,
      period_end: periode.end,
      amount_minor: amount.minor,
      currency: amount.currency,
      status: 'perlu_verifikasi',
      note:
        `Dokumen ${docKind} dari pengirim yang belum dikenali (${domain}). ` +
        'Dibuat sebagai kandidat; perlu konfirmasi sebelum menjadi aturan berulang.',
    };

    return {
      parser: this.name,
      confidence: 0.35,
      evidence_kind: docKind === 'kuitansi' ? 'kuitansi' : 'invoice',
      items: [invoice],
      catatan: [
        `Pengirim ${domain} belum ada di katalog layanan. ` +
          'Masuk ke halaman "Layanan belum teridentifikasi".',
      ],
    };
  },
};

export { toInstant };
