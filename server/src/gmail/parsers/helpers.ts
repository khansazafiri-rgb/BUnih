import { parseAmount, type Currency } from '../../domain/money.js';
import { isValidDate, type IsoDate } from '../../domain/time.js';

const BULAN_ID: Record<string, number> = {
  jan: 1, januari: 1, feb: 2, februari: 2, mar: 3, maret: 3, apr: 4, april: 4,
  mei: 5, may: 5, jun: 6, juni: 6, jul: 7, juli: 7, agu: 8, agt: 8, agustus: 8, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11, des: 12, dec: 12, desember: 12, december: 12,
  january: 1, february: 2, march: 3, june: 6, july: 7,
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Baca tanggal dari teks Indonesia/Inggris. Mengembalikan null bila tidak yakin. */
export function parseDateLoose(raw: string): IsoDate | null {
  if (!raw) return null;
  const text = raw.trim();

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return isValidDate(candidate) ? candidate : null;
  }

  const named = text.match(
    /\b(\d{1,2})\s+([A-Za-z]{3,12})\.?\s+(\d{4})\b/,
  );
  if (named) {
    const month = BULAN_ID[named[2]!.toLowerCase()];
    if (month) {
      const candidate = `${named[3]}-${pad(month)}-${pad(Number(named[1]))}`;
      return isValidDate(candidate) ? candidate : null;
    }
  }

  const namedUs = text.match(/\b([A-Za-z]{3,12})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (namedUs) {
    const month = BULAN_ID[namedUs[1]!.toLowerCase()];
    if (month) {
      const candidate = `${namedUs[3]}-${pad(month)}-${pad(Number(namedUs[2]))}`;
      return isValidDate(candidate) ? candidate : null;
    }
  }

  // dd/mm/yyyy dan dd-mm-yyyy (format Indonesia: hari dulu)
  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (numeric) {
    const d = Number(numeric[1]);
    const m = Number(numeric[2]);
    const candidate = `${numeric[3]}-${pad(m)}-${pad(d)}`;
    return isValidDate(candidate) ? candidate : null;
  }

  return null;
}

/** Baca jam "14:05" atau "14:05:33" dari teks. */
export function parseTimeLoose(raw: string): string | null {
  const m = raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/);
  if (!m) return null;
  return `${pad(Number(m[1]))}:${m[2]}:${m[3] ?? '00'}`;
}

export function toInstant(date: IsoDate, time: string | null): string {
  return `${date}T${time ?? '00:00:00'}+07:00`;
}

/**
 * Ambil nilai setelah label, mis. labelValue(text, ['Nominal','Jumlah']).
 *
 * Label diperlakukan sebagai POLA regex, bukan teks harfiah, supaya varian seperti
 * "No. Referensi" / "No Referensi" dapat ditulis sebagai satu pola.
 */
export function labelValue(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(`(?:${label})\\s*[:\\-]?\\s*([^\\n\\r]{1,120})`, 'i');
    const m = text.match(re);
    if (m?.[1]) {
      const value = m[1].trim();
      if (value) return value;
    }
  }
  return null;
}

export function findAmount(
  text: string,
  labels: string[],
  fallbackCurrency: Currency = 'IDR',
): { minor: number; currency: Currency } | null {
  const labelled = labelValue(text, labels);
  if (labelled) {
    const parsed = parseAmount(labelled, fallbackCurrency);
    if (parsed) return parsed;
  }
  return null;
}

/** Nominal terbesar yang terlihat seperti rupiah — dipakai sebagai cadangan terakhir. */
export function largestRupiah(text: string): { minor: number; currency: Currency } | null {
  const matches = text.match(/(?:Rp|IDR)\s?[\d.,]{3,}/gi);
  if (!matches?.length) return null;
  let best: { minor: number; currency: Currency } | null = null;
  for (const m of matches) {
    const parsed = parseAmount(m, 'IDR');
    if (parsed && (!best || parsed.minor > best.minor)) best = parsed;
  }
  return best;
}

export function findReference(text: string): string | null {
  const labels = [
    'No\\.? ?Referensi', 'Nomor Referensi', 'No\\.? ?Ref', 'Reference(?: Number| No\\.?)?',
    'Ref(?:erence)? ID', 'Kode Transaksi', 'Transaction ID', 'ID Transaksi', 'Trx ID',
    'Receipt Number', 'Nomor Transaksi',
  ];
  const raw = labelValue(text, labels);
  if (raw) {
    const cleaned = raw.replace(/[^A-Za-z0-9-]/g, '');
    if (cleaned.length >= 4) return cleaned;
  }
  const loose = text.match(/\b(?:ref|trx|inv)[-_ ]?([A-Z0-9]{6,})\b/i);
  // Harus memuat angka: kata "Referensi" sendiri tidak boleh terbaca sebagai nomor referensi ("erensi").
  return loose?.[1] && /\d/.test(loose[1]) ? loose[1] : null;
}

export function findInvoiceNo(text: string): string | null {
  const raw = labelValue(text, [
    'Invoice(?: Number| No\\.?| #)?', 'No\\.? ?Invoice', 'Nomor Invoice', 'Tagihan No\\.?',
    'Bill(?:ing)? Number',
  ]);
  if (!raw) return null;
  const cleaned = raw.replace(/^[#:\s]+/, '').match(/[A-Za-z0-9/_-]{3,40}/);
  return cleaned?.[0] ?? null;
}

export function findDueDate(text: string): IsoDate | null {
  const raw = labelValue(text, [
    'Jatuh Tempo', 'Tanggal Jatuh Tempo', 'Due Date', 'Payment Due', 'Harus dibayar sebelum',
    'Batas Pembayaran',
  ]);
  return raw ? parseDateLoose(raw) : null;
}

export function findPeriod(text: string): { start: IsoDate | null; end: IsoDate | null } {
  const raw = labelValue(text, ['Periode', 'Service Period', 'Billing Period', 'Period']);
  if (!raw) return { start: null, end: null };
  const parts = raw.split(/\s*(?:s\/d|sampai|s\.d\.|to|-|–|—)\s*/i);
  if (parts.length >= 2) {
    return { start: parseDateLoose(parts[0]!), end: parseDateLoose(parts[1]!) };
  }
  return { start: parseDateLoose(raw), end: null };
}

/** Ambil 4 digit terakhir rekening dari pola "****1234" atau "xxxx1234". */
export function findAccountTail(text: string, labels: string[], opsi: { tanpaCadangan?: boolean } = {}): string | null {
  const raw = labelValue(text, labels);
  // Tanpa label, mencari di seluruh teks hanya aman untuk rekening SUMBER (satu-satunya nomor di email).
  // Untuk rekening TUJUAN, jatuh ke seluruh teks akan menangkap nomor rekening sumber dan mengubah
  // pembayaran ke merchant menjadi "transfer ke rekening sendiri".
  if (raw === null && opsi.tanpaCadangan) return null;
  const target = raw ?? text;
  const masked = target.match(/(?:[*xX•]{2,}|\.{3,})\s?(\d{3,4})\b/);
  if (masked?.[1]) return masked[1].slice(-4);
  const digits = target.match(/\b(\d{10,16})\b/);
  if (digits?.[1]) return digits[1].slice(-4);
  return null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<td[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function senderMatches(from: string, patterns: RegExp[]): boolean {
  const lower = from.toLowerCase();
  return patterns.some((p) => p.test(lower));
}
