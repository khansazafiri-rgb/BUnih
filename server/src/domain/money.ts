/**
 * Uang disimpan sebagai bilangan bulat dalam satuan terkecil (minor unit).
 * IDR: 1 minor = Rp1 (rupiah tidak memakai sen dalam praktik).
 * USD/EUR: 1 minor = 1 sen.
 * Tidak ada operasi uang yang memakai bilangan pecahan (float) di sistem ini.
 */

export type Currency = 'IDR' | 'USD' | 'EUR' | 'SGD';

const MINOR_PER_UNIT: Record<string, number> = {
  IDR: 1,
  USD: 100,
  EUR: 100,
  SGD: 100,
};

export function minorPerUnit(currency: string): number {
  return MINOR_PER_UNIT[currency.toUpperCase()] ?? 100;
}

export function isSupportedCurrency(currency: string): boolean {
  return currency.toUpperCase() in MINOR_PER_UNIT;
}

/** Rp349.000 -> 349000 (minor IDR). USD 12,34 -> 1234 (minor USD). */
export function toMinor(amount: number, currency: Currency = 'IDR'): number {
  return Math.round(amount * minorPerUnit(currency));
}

export function fromMinor(minor: number, currency: Currency = 'IDR'): number {
  return minor / minorPerUnit(currency);
}

/** Format Indonesia: 349000 -> "Rp349.000". */
export function formatIDR(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return 'belum diketahui';
  const neg = minor < 0;
  const digits = Math.abs(Math.trunc(minor)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}Rp${grouped}`;
}

export function formatMoney(minor: number | null | undefined, currency: string = 'IDR'): string {
  if (minor === null || minor === undefined) return 'belum diketahui';
  const cur = currency.toUpperCase();
  if (cur === 'IDR') return formatIDR(minor);
  const per = minorPerUnit(cur);
  const value = (minor / per).toFixed(per === 1 ? 0 : 2);
  const [int = '0', frac] = value.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cur} ${grouped}${frac ? `,${frac}` : ''}`;
}

/**
 * Baca nominal dari teks Indonesia/Inggris apa adanya.
 * Mengembalikan null bila tidak yakin — sistem tidak boleh mengarang nominal.
 *
 *   "Rp349.000"      -> 349000
 *   "Rp 198.690,00"  -> 198690
 *   "IDR 410,700"    -> 410700
 *   "USD 20.00"      -> 2000 (minor USD)
 */
export function parseAmount(
  raw: string,
  fallbackCurrency: Currency = 'IDR',
): { minor: number; currency: Currency } | null {
  if (!raw) return null;
  const text = raw.trim();

  let currency: Currency = fallbackCurrency;
  if (/\b(rp|idr)\b|^rp/i.test(text)) currency = 'IDR';
  else if (/\b(usd|us\$)\b|\$/i.test(text)) currency = 'USD';
  else if (/\b(eur)\b|€/i.test(text)) currency = 'EUR';
  else if (/\b(sgd)\b/i.test(text)) currency = 'SGD';

  const numMatch = text.match(/-?[\d][\d.,\s]*\d|-?\d/);
  if (!numMatch) return null;
  let num = numMatch[0].replace(/\s/g, '');

  const lastDot = num.lastIndexOf('.');
  const lastComma = num.lastIndexOf(',');
  let decimalSep: '.' | ',' | null = null;

  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastComma >= 0) {
    const tail = num.length - lastComma - 1;
    // "349.000" dan "410,700" sama-sama ribuan; hanya 1-2 digit di belakang = desimal
    decimalSep = tail === 1 || tail === 2 ? ',' : null;
  } else if (lastDot >= 0) {
    const tail = num.length - lastDot - 1;
    decimalSep = (tail === 1 || tail === 2) && currency !== 'IDR' ? '.' : null;
  }

  if (decimalSep === '.') num = num.replace(/,/g, '');
  else if (decimalSep === ',') num = num.replace(/\./g, '').replace(',', '.');
  else num = num.replace(/[.,]/g, '');

  const value = Number(num);
  if (!Number.isFinite(value)) return null;
  return { minor: toMinor(value, currency), currency };
}

export function sumMinor(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) if (typeof v === 'number') total += v;
  return total;
}

/** Bagi rata nominal tanpa kehilangan rupiah: sisa dibagikan ke bagian paling awal. */
export function splitEvenly(minor: number, parts: number): number[] {
  if (parts <= 0) throw new Error('parts harus > 0');
  const base = Math.floor(minor / parts);
  let remainder = minor - base * parts;
  const out: number[] = [];
  for (let i = 0; i < parts; i += 1) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    out.push(base + extra);
  }
  return out;
}
