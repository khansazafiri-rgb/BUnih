import type { MailMessage } from './types.js';

const PROMO_KATA = [
  'promo', 'diskon', 'potongan harga', 'hemat', 'penawaran', 'kupon', 'voucher',
  'jangan lewatkan', 'flash sale', 'limited time', 'newsletter', 'webinar',
  'daftar sekarang', 'coba gratis', 'free trial', 'upgrade now', 'tingkatkan paket',
  'rekomendasi untukmu', 'berlangganan sekarang', 'cashback', 'undian', 'giveaway',
];

const TRANSAKSI_KATA = [
  'no. referensi', 'nomor referensi', 'reference number', 'transaction id', 'id transaksi',
  'berhasil', 'sukses', 'telah dibayar', 'paid', 'receipt', 'kuitansi', 'invoice',
  'jatuh tempo', 'due date', 'nominal', 'debit', 'kredit', 'saldo', 'amount due',
  'payment failed', 'gagal bayar', 'refund', 'pembayaran diterima',
];

function haystack(msg: MailMessage): string {
  return `${msg.subject}\n${msg.text}`.toLowerCase();
}

export function transactionSignals(msg: MailMessage): number {
  const hay = haystack(msg);
  return TRANSAKSI_KATA.filter((k) => hay.includes(k)).length;
}

export function promoSignals(msg: MailMessage): number {
  const hay = haystack(msg);
  return PROMO_KATA.filter((k) => hay.includes(k)).length;
}

/**
 * Email promosi tidak boleh menjadi transaksi.
 *
 * Penilaian memakai identitas pengirim, header langganan, label Gmail, dan isi
 * pesan — bukan subjek saja. Kuitansi asli sering juga membawa List-Unsubscribe,
 * jadi tanda transaksi yang kuat mengalahkan tanda promosi.
 */
export function isPromotional(msg: MailMessage): { promo: boolean; alasan: string[] } {
  const alasan: string[] = [];
  const headers = Object.fromEntries(
    Object.entries(msg.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );

  const tx = transactionSignals(msg);
  const promo = promoSignals(msg);

  const labelPromo = (msg.labelIds ?? []).some((l) =>
    ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'].includes(l),
  );
  if (labelPromo) alasan.push('Gmail menandai email ini sebagai promosi/sosial.');

  const bulk = headers['precedence'] === 'bulk' || headers['x-campaign-id'] !== undefined;
  if (bulk) alasan.push('Header menunjukkan email massal.');

  if (promo > 0) alasan.push(`Ada ${promo} kata khas promosi.`);

  // Tanda transaksi yang kuat: minimal 2 penanda dan ada nominal.
  const adaNominal = /(?:rp|idr|usd|\$)\s?[\d.,]{3,}/i.test(`${msg.subject} ${msg.text}`);
  const kuat = tx >= 2 && adaNominal;
  if (kuat) alasan.push(`Ada ${tx} penanda transaksi dan nominal yang jelas.`);

  const isPromo = !kuat && (labelPromo || bulk || promo >= 2);
  return { promo: isPromo, alasan };
}

/** Benar bila pengirim termasuk daftar yang dipercaya untuk jenis bukti tertentu. */
export function senderTrusted(from: string, patterns: RegExp[]): boolean {
  const lower = from.toLowerCase();
  return patterns.some((p) => p.test(lower));
}
