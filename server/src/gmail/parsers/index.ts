import type { MailMessage, MailParser, ParseResult } from '../types.js';
import { mandiriParser } from './mandiri.js';
import { bcaParser } from './bca.js';
import { vendorParser } from './vendors.js';
import { genericInvoiceParser } from './genericInvoice.js';

/** Urutan penting: parser khusus lebih dulu, parser umum paling akhir. */
export const PARSERS: MailParser[] = [
  mandiriParser,
  bcaParser,
  vendorParser,
  genericInvoiceParser,
];

export function parseMessage(msg: MailMessage): ParseResult | null {
  for (const parser of PARSERS) {
    try {
      if (!parser.matches(msg)) continue;
      const result = parser.parse(msg);
      if (result) return result;
    } catch (err) {
      return {
        parser: parser.name,
        confidence: 0,
        evidence_kind: 'invoice',
        items: [],
        catatan: [`Parser gagal membaca email ini: ${(err as Error).message}`],
      };
    }
  }
  return null;
}

export { mandiriParser, bcaParser, vendorParser, genericInvoiceParser };
