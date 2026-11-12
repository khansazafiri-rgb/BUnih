/** Pembaca CSV sederhana yang menangani tanda kutip, koma, titik koma, dan tab. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  const kandidat = [',', ';', '\t', '|'];
  let terbaik = ',';
  let skor = -1;
  for (const d of kandidat) {
    const jumlah = sample.split(d).length;
    if (jumlah > skor) {
      skor = jumlah;
      terbaik = d;
    }
  }
  return terbaik;
}

export function parseCsv(text: string, delimiter?: string): string[][] {
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === d) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // diabaikan
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Cari baris header: baris pertama yang punya minimal 2 sel teks non-angka. */
export function detectHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i += 1) {
    const r = rows[i]!;
    const teks = r.filter((c) => c && !/^[\d.,%\-Rp\s]+$/i.test(c));
    if (teks.length >= 2) return i;
  }
  return 0;
}

export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
