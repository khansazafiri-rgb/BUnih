import {
  findAmount, findDueDate, findInvoiceNo, findPeriod, findReference, labelValue,
  largestRupiah, parseDateLoose, senderMatches, toInstant,
} from './helpers.js';
import { parseAmount } from '../../domain/money.js';
import { isPromotional } from '../classify.js';
import type {
  MailMessage, MailParser, ParseResult, ParsedInvoice, ParsedStatusChange,
} from '../types.js';
import type { InvoiceStatus } from '../../domain/types.js';

export type VendorProfile = {
  slug: string;
  vendor: string;
  service_slug: string | null;
  senders: RegExp[];
  /** Kata yang harus ada di isi pesan bila pengirimnya perantara (mis. Stripe). */
  bodyHints?: RegExp[];
  defaultCurrency: 'IDR' | 'USD';
};

/**
 * Profil vendor untuk katalog awal. Daftar ini TIDAK dianggap lengkap:
 * email dari pengirim lain tetap diproses oleh parser invoice umum dan
 * muncul di halaman "Layanan belum teridentifikasi".
 */
export const VENDOR_PROFILES: VendorProfile[] = [
  {
    slug: 'openai',
    vendor: 'OpenAI',
    service_slug: 'chatgpt-plus-pribadi',
    senders: [/@openai\.com$/i, /@tm\.openai\.com$/i, /@mail\.openai\.com$/i],
    defaultCurrency: 'USD',
  },
  {
    slug: 'anthropic',
    vendor: 'Anthropic',
    service_slug: null, // pribadi vs company dibedakan oleh pengguna, jangan dicampur
    senders: [/@anthropic\.com$/i, /@mail\.anthropic\.com$/i],
    defaultCurrency: 'USD',
  },
  {
    slug: 'biznetgio',
    vendor: 'Biznet Gio',
    service_slug: 'biznet-gio-pribadi',
    senders: [/@biznetgio\.com$/i, /@biznetnetworks\.com$/i, /biznet/i],
    defaultCurrency: 'IDR',
  },
  {
    slug: 'idcloudhost',
    vendor: 'IDCloudHost',
    service_slug: 'idcloudhost-vps-company',
    senders: [/@idcloudhost\.com$/i, /idcloudhost/i],
    defaultCurrency: 'IDR',
  },
  {
    slug: 'tencentcloud',
    vendor: 'Tencent Cloud',
    service_slug: 'tencent-cloud-hermes',
    senders: [/@tencentcloud\.com$/i, /@intl\.cloud\.tencent\.com$/i, /tencent/i],
    defaultCurrency: 'USD',
  },
  {
    slug: 'cloudflare',
    vendor: 'Cloudflare',
    service_slug: 'cloudflare-pro',
    senders: [/@cloudflare\.com$/i, /@notify\.cloudflare\.com$/i],
    defaultCurrency: 'USD',
  },
  {
    slug: 'canva',
    vendor: 'Canva',
    service_slug: 'canva-pro',
    senders: [/@canva\.com$/i, /@mail\.canva\.com$/i],
    defaultCurrency: 'IDR',
  },
  {
    slug: 'elevenlabs',
    vendor: 'ElevenLabs',
    service_slug: 'elevenlabs-starter',
    senders: [/@elevenlabs\.io$/i, /@try\.elevenlabs\.io$/i],
    defaultCurrency: 'USD',
  },
  {
    slug: 'openrouter',
    vendor: 'OpenRouter',
    service_slug: 'openrouter-credits',
    senders: [/@openrouter\.ai$/i],
    defaultCurrency: 'USD',
  },
  {
    slug: 'google',
    vendor: 'Google',
    service_slug: 'google-ai-pro-5tb',
    senders: [/payments-noreply@google\.com$/i, /@payments\.google\.com$/i],
    defaultCurrency: 'IDR',
  },
  {
    slug: 'stripe',
    vendor: 'Stripe (perantara)',
    service_slug: null,
    senders: [/@stripe\.com$/i, /receipts\+.*@stripe\.com$/i],
    defaultCurrency: 'USD',
  },
];

export type DocKind =
  | 'gagal_bayar'
  | 'pembatalan'
  | 'refund'
  | 'kuitansi'
  | 'perpanjangan'
  | 'invoice'
  | 'tidak_jelas';

const POLA: Array<[DocKind, RegExp]> = [
  [
    'gagal_bayar',
    /(payment failed|pembayaran gagal|gagal bayar|we (?:could ?n[o']t|were unable to) (?:process|charge)|card (?:was )?declined|kartu ditolak|payment (?:was )?unsuccessful|action required.{0,40}payment)/i,
  ],
  [
    'pembatalan',
    /(has been (?:cancell?ed|canceled)|subscription cancell?ed|langganan dibatalkan|telah dibatalkan|plan (?:was )?cancell?ed|subscription (?:has )?ended|berakhir dan tidak diperpanjang)/i,
  ],
  ['refund', /(refund(?:ed)?|dana dikembalikan|pengembalian dana|credit note)/i],
  [
    'kuitansi',
    /(your receipt|payment receipt|receipt from|kuitansi|payment (?:received|successful|confirmed)|thank(?:s| you) for your payment|pembayaran (?:berhasil|diterima|telah kami terima)|telah dibayar|paid in full|invoice paid)/i,
  ],
  [
    'perpanjangan',
    /(will (?:automatically )?renew|upcoming (?:charge|renewal|invoice)|renewal reminder|akan diperpanjang|perpanjangan otomatis|subscription renews)/i,
  ],
  [
    'invoice',
    /(invoice|tagihan|amount due|total due|jatuh tempo|due date|payment due|billing statement)/i,
  ],
];

export function detectDocKind(msg: MailMessage): DocKind {
  const hay = `${msg.subject}\n${msg.text}`;
  for (const [kind, re] of POLA) if (re.test(hay)) return kind;
  return 'tidak_jelas';
}

export function findVendor(msg: MailMessage): VendorProfile | null {
  for (const v of VENDOR_PROFILES) {
    if (!senderMatches(msg.from, v.senders)) continue;
    if (v.bodyHints?.length) {
      const hay = `${msg.subject}\n${msg.text}`;
      if (!v.bodyHints.some((h) => h.test(hay))) continue;
    }
    return v;
  }
  return null;
}

/** Vendor sebenarnya di balik perantara seperti Stripe. */
function vendorDariIsi(msg: MailMessage): VendorProfile | null {
  const hay = `${msg.subject}\n${msg.text}`.toLowerCase();
  for (const v of VENDOR_PROFILES) {
    if (v.slug === 'stripe') continue;
    if (hay.includes(v.vendor.toLowerCase()) || hay.includes(v.slug)) return v;
  }
  return null;
}

const STATUS_DARI_DOC: Record<Exclude<DocKind, 'tidak_jelas'>, InvoiceStatus> = {
  gagal_bayar: 'gagal_bayar',
  pembatalan: 'dibatalkan',
  refund: 'refund',
  kuitansi: 'lunas_terkonfirmasi',
  perpanjangan: 'tagihan_baru',
  invoice: 'tagihan_baru',
};

const EVIDENCE_DARI_DOC: Record<DocKind, ParseResult['evidence_kind']> = {
  gagal_bayar: 'gagal_bayar',
  pembatalan: 'pembatalan',
  refund: 'refund',
  kuitansi: 'kuitansi',
  perpanjangan: 'perpanjangan',
  invoice: 'invoice',
  tidak_jelas: 'invoice',
};

/**
 * Parser tagihan/kuitansi vendor.
 *
 * Catatan penting:
 * - Invoice TIDAK berarti sudah dibayar; statusnya 'tagihan_baru'.
 * - Kuitansi menjadi bukti pembayaran, tetapi uang keluar tetap dicocokkan ke
 *   notifikasi bank agar satu pembayaran tidak dihitung dua kali.
 * - Nominal mata uang asing disimpan apa adanya; rupiah aktual hanya diisi bila
 *   ada bukti pendebitan rupiahnya.
 */
export const vendorParser: MailParser = {
  name: 'vendor-tagihan',
  senders: VENDOR_PROFILES.flatMap((v) => v.senders),
  matches(msg) {
    return findVendor(msg) !== null;
  },
  parse(msg: MailMessage): ParseResult | null {
    let vendor = findVendor(msg);
    if (!vendor) return null;
    if (vendor.slug === 'stripe') {
      const asli = vendorDariIsi(msg);
      if (asli) vendor = { ...asli, defaultCurrency: asli.defaultCurrency };
    }

    const docKind = detectDocKind(msg);
    const promo = isPromotional(msg);
    const catatan: string[] = [];

    if (promo.promo || docKind === 'tidak_jelas') {
      return {
        parser: this.name,
        confidence: 0,
        evidence_kind: 'invoice',
        items: [],
        catatan: [
          promo.promo
            ? 'Dinilai email promosi/pemasaran, bukan dokumen tagihan.'
            : 'Jenis dokumen tidak dapat ditentukan, jadi tidak ada data keuangan yang dibuat.',
          ...promo.alasan,
        ],
      };
    }

    const text = msg.text;
    const amount =
      findAmount(
        text,
        ['Amount (?:due|paid|charged)', 'Total(?: due| amount| dibayar)?', 'Nominal', 'Jumlah', 'Grand Total', 'Subtotal'],
        vendor.defaultCurrency,
      ) ??
      (vendor.defaultCurrency === 'IDR'
        ? largestRupiah(`${msg.subject}\n${text}`)
        : parseAmount(
            labelValue(text, ['Amount', 'Total']) ?? msg.subject,
            vendor.defaultCurrency,
          ));

    if (!amount) {
      catatan.push('Nominal tidak terbaca dari email ini, jadi nominalnya dibiarkan kosong.');
    }

    const invoiceNo = findInvoiceNo(text) ?? findReference(text);
    const dueDate = findDueDate(text);
    const periode = findPeriod(text);
    const issued =
      parseDateLoose(labelValue(text, ['Invoice Date', 'Tanggal Invoice', 'Issued', 'Tanggal']) ?? '') ??
      parseDateLoose(msg.date);
    const occurredDate = issued ?? msg.date.slice(0, 10);

    const items: Array<ParsedInvoice | ParsedStatusChange> = [];

    const status = STATUS_DARI_DOC[docKind];
    const invoice: ParsedInvoice = {
      tipe: 'invoice',
      vendor: vendor.vendor,
      service_slug: vendor.service_slug,
      invoice_no: invoiceNo,
      issued_at: issued,
      due_date: dueDate,
      period_start: periode.start,
      period_end: periode.end,
      amount_minor: amount?.minor ?? null,
      currency: amount?.currency ?? vendor.defaultCurrency,
      status,
      note:
        docKind === 'perpanjangan'
          ? 'Pemberitahuan perpanjangan — belum tentu sudah ditagih atau dibayar.'
          : docKind === 'invoice'
            ? 'Invoice diterima; belum berarti sudah dibayar.'
            : null,
    };
    items.push(invoice);

    if (docKind !== 'invoice') {
      items.push({
        tipe: 'status_tagihan',
        vendor: vendor.vendor,
        service_slug: vendor.service_slug,
        invoice_no: invoiceNo,
        status,
        occurred_at: toInstant(occurredDate, null),
        amount_minor: amount?.minor ?? null,
        currency: amount?.currency ?? vendor.defaultCurrency,
        note: `Dari email ${docKind}.`,
      });
    }

    if (vendor.service_slug === null) {
      catatan.push(
        `Email dari ${vendor.vendor} belum bisa dipetakan otomatis ke satu layanan ` +
          '(pribadi atau company). Perlu konfirmasi.',
      );
    }
    if (amount && amount.currency !== 'IDR') {
      catatan.push(
        `Nominal dalam ${amount.currency}. Rupiah aktual hanya dicatat bila ada bukti pendebitannya.`,
      );
    }

    const confidence = Math.min(
      0.95,
      0.5 + (amount ? 0.2 : 0) + (invoiceNo ? 0.1 : 0) + (dueDate ? 0.1 : 0) +
        (vendor.service_slug ? 0.1 : 0),
    );

    return {
      parser: this.name,
      confidence,
      evidence_kind: EVIDENCE_DARI_DOC[docKind],
      items,
      catatan,
    };
  },
};
