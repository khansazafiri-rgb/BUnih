/**
 * Pemahaman bahasa Indonesia sehari-hari untuk pesan Telegram.
 * Sengaja berbasis aturan: hasilnya dapat dijelaskan, dan bila tidak yakin
 * bot bertanya alih-alih menebak.
 */

export type Intent =
  | 'catat_pengeluaran'
  | 'catat_pemasukan'
  | 'bagi_biaya'
  | 'set_reimburse'
  | 'set_hadiah'
  | 'set_talangan'
  | 'set_company_langsung'
  | 'transfer_sendiri'
  | 'setoran_tabungan'
  | 'simulasi'
  | 'topup_tidak_diterima'
  | 'topup_diterima'
  | 'tanya_hari'
  | 'tanya_tagihan'
  | 'tanya_anggaran'
  | 'tanya_reimburse'
  | 'koreksi'
  | 'bantuan'
  | 'tidak_jelas';

export type NluResult = {
  intent: Intent;
  keyakinan: number;
  nominal_minor: number | null;
  /** Jumlah orang yang ikut membayar bersama, bila disebut. */
  jumlah_orang: number | null;
  /** Bagian saya, bila disebut terpisah. */
  bagian_saya_minor: number | null;
  tanggal_relatif: 'hari_ini' | 'kemarin' | null;
  kategori_tebakan: string | null;
  label: string | null;
  teks: string;
};

/**
 * Nominal bersatuan: "500 ribu", "Rp500 ribu", "1,5jt", "30k". Awalan "Rp" boleh menempel pada angka
 * (tanpa batas kata di antaranya), sehingga "Rp500 ribu" terbaca 500.000, bukan 500.
 */
export const POLA_NOMINAL_SATUAN = /(?<![A-Za-z0-9])(?:rp\.?\s?)?(\d+(?:[.,]\d+)?)\s*(jt|juta|rb|ribu|k|m|miliar|milyar)\b/gi;
const POLA_NOMINAL_RP = /(?<![A-Za-z0-9])rp\.?\s?([\d.]{3,})(?![\d.]*\d\s*(?:jt|juta|rb|ribu|k)\b)/gi;

function pengaliSatuan(unit: string): number {
  const u = unit.toLowerCase();
  if (u === 'jt' || u === 'juta') return 1_000_000;
  if (u === 'm' || u === 'miliar' || u === 'milyar') return 1_000_000_000;
  return 1_000;
}

/** Hapus semua bentuk nominal dari teks (dipakai untuk mengambil nama dari sisa kalimat). */
export function hapusNominal(teks: string): string {
  return teks
    .replace(new RegExp(POLA_NOMINAL_SATUAN.source, 'gi'), ' ')
    .replace(new RegExp(POLA_NOMINAL_RP.source, 'gi'), ' ')
    .replace(/(?<![A-Za-z0-9])\d{4,}(?![A-Za-z0-9])/g, ' ');
}

/** "30 ribu" -> 30000, "1,5jt" -> 1500000, "Rp25.000" -> 25000, "Rp500 ribu" -> 500000 */
export function parseRupiah(text: string): number | null {
  const semua = parseAllRupiah(text);
  return semua.length ? semua[0]! : null;
}

/** Semua nominal yang muncul di teks, berurutan menurut posisi. */
export function parseAllRupiah(text: string): number[] {
  const hit: Array<{ pos: number; nilai: number }> = [];
  const ambilSatuan = new RegExp(POLA_NOMINAL_SATUAN.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = ambilSatuan.exec(text)) !== null) {
    const nilai = Math.round(Number(m[1]!.replace(',', '.')) * pengaliSatuan(m[2]!));
    if (Number.isFinite(nilai)) hit.push({ pos: m.index, nilai });
  }
  const tanpaSatuan = text.replace(new RegExp(POLA_NOMINAL_SATUAN.source, 'gi'), (x) => ' '.repeat(x.length));
  const ambilRp = new RegExp(POLA_NOMINAL_RP.source, 'gi');
  while ((m = ambilRp.exec(tanpaSatuan)) !== null) {
    const nilai = Number(m[1]!.replace(/\./g, ''));
    if (Number.isFinite(nilai)) hit.push({ pos: m.index, nilai });
  }
  const tanpaRp = tanpaSatuan.replace(new RegExp(POLA_NOMINAL_RP.source, 'gi'), (x) => ' '.repeat(x.length));
  const polos = /(?<![A-Za-z0-9])(\d{4,})(?![A-Za-z0-9])/g;
  while ((m = polos.exec(tanpaRp)) !== null) hit.push({ pos: m.index, nilai: Number(m[1]) });
  return hit.sort((a, b) => a.pos - b.pos).map((h) => h.nilai);
}

const ANGKA_KATA: Record<string, number> = {
  sendiri: 1, berdua: 2, bertiga: 3, berempat: 4, berlima: 5, berenam: 6,
  bertujuh: 7, berdelapan: 8, bersembilan: 9, bersepuluh: 10,
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7,
  delapan: 8, sembilan: 9, sepuluh: 10,
};

export function parseJumlahOrang(text: string): number | null {
  const t = text.toLowerCase();
  for (const [kata, n] of Object.entries(ANGKA_KATA)) {
    if (new RegExp(`\\b${kata}\\b`).test(t)) return n;
  }
  const m = t.match(/\b(\d{1,2})\s*(?:orang|teman|org)\b/);
  if (m?.[1]) {
    const n = Number(m[1]);
    // "3 teman" berarti saya + 3 orang.
    return /teman/.test(m[0]) ? n + 1 : n;
  }
  return null;
}

const KATEGORI_KATA: Array<[string, RegExp]> = [
  ['makan', /\b(makan|sarapan|makan siang|makan malam|nasi|ayam|bakso|mie|kopi|jajan|gofood|grabfood|warteg|kantin)\b/i],
  ['transport', /\b(transport|ojek|gojek|grab|bensin|parkir|tol|angkot|kereta|bus|taksi)\b/i],
  ['kebutuhan-harian', /\b(sabun|odol|pasta gigi|shampoo|tisu|deterjen|belanja bulanan|indomaret|alfamart)\b/i],
  ['kesehatan', /\b(obat|apotek|dokter|klinik|rumah sakit|vitamin)\b/i],
  ['server-hosting', /\b(server|vps|hosting|domain|cloud)\b/i],
  ['langganan-ai', /\b(chatgpt|claude|openai|anthropic|gemini|ai pro|elevenlabs)\b/i],
  ['kredit-api', /\b(openrouter|kredit api|credits)\b/i],
  ['belanja-barang', /\b(beli|keyboard|mouse|hp|laptop|kabel|charger|baju|sepatu|tas)\b/i],
  ['hadiah', /\b(hadiah|kado|gift)\b/i],
];

export function tebakKategori(text: string): string | null {
  for (const [slug, re] of KATEGORI_KATA) if (re.test(text)) return slug;
  return null;
}

export function detectIntent(raw: string): NluResult {
  const teks = raw.trim();
  const t = teks.toLowerCase();
  const nominalSemua = parseAllRupiah(t);
  const nominal = nominalSemua.length ? Math.max(...nominalSemua) : null;
  const orang = parseJumlahOrang(t);
  const kategori = tebakKategori(t);
  const tanggal: NluResult['tanggal_relatif'] = /\bkemarin\b/.test(t)
    ? 'kemarin'
    : /\bhari ini|tadi\b/.test(t)
      ? 'hari_ini'
      : null;

  const base: Omit<NluResult, 'intent' | 'keyakinan'> = {
    nominal_minor: nominal,
    jumlah_orang: orang,
    bagian_saya_minor: null,
    tanggal_relatif: tanggal,
    kategori_tebakan: kategori,
    label: null,
    teks,
  };

  // "itu makan berempat, aku cuma bayar 30 ribu"
  const bagianSaya = t.match(
    /\b(?:aku|saya|gue|gw)\s*(?:cuma|hanya|cuman)?\s*(?:bayar|keluar|tanggung|bagian(?:nya)?)\s*([^,.;]+)/,
  );
  if (bagianSaya?.[1]) {
    base.bagian_saya_minor = parseRupiah(bagianSaya[1]);
  }
  const bagianSaya2 = t.match(/\bbagian(?:ku|\s*(?:aku|saya))\s*([^,.;]+)/);
  if (!base.bagian_saya_minor && bagianSaya2?.[1]) {
    base.bagian_saya_minor = parseRupiah(bagianSaya2[1]);
  }

  if (/\b(bantuan|help|bisa apa|perintah)\b/.test(t)) {
    return { ...base, intent: 'bantuan', keyakinan: 0.9 };
  }
  if (/\b(bagi|berbagi|bareng|berempat|bertiga|berdua|berlima|split|patungan|bersama)\b/.test(t) || base.bagian_saya_minor !== null) {
    return { ...base, intent: 'bagi_biaya', keyakinan: base.bagian_saya_minor !== null ? 0.9 : 0.75 };
  }
  if (/\b(reimburse|direimburse|diganti company|ditanggung company|klaim)\b/.test(t)) {
    return { ...base, intent: 'set_reimburse', keyakinan: 0.9 };
  }
  if (/\b(company (?:bayar|yang bayar)|dibayar company|langsung company)\b/.test(t)) {
    return { ...base, intent: 'set_company_langsung', keyakinan: 0.85 };
  }
  if (/\b(hadiah|kado|gift|buat (?:dia|teman|ibu|bapak|adik|kakak))\b/.test(t)) {
    return { ...base, intent: 'set_hadiah', keyakinan: 0.8 };
  }
  if (/\b(talang|talangan|nalangin|nalangi|bayarin dulu|dibayarin dulu|pinjam dulu)\b/.test(t)) {
    return { ...base, intent: 'set_talangan', keyakinan: 0.85 };
  }
  // Transfer ke rekening SENDIRI harus punya penanda kepemilikan yang jelas,
  // supaya "transfer ke BCA Bu Ani" tidak ikut tertangkap.
  const keRekeningSendiri =
    /\b(?:rekening|bca|mandiri|akun)\s*(?:aku|saya|ku)?\s*(?:sendiri|milik\s?(?:ku|saya)|punya\s?(?:ku|saya))\b/.test(t) ||
    /\brekening ?ku\b/.test(t) ||
    /\b(?:bca|mandiri) ?(?:ku|aku|saya)\b/.test(t);
  if (keRekeningSendiri) {
    return { ...base, intent: 'transfer_sendiri', keyakinan: 0.85 };
  }
  if (/\b(nabung|tabung|setor (?:ke )?bca|setoran tabungan)\b/.test(t)) {
    return { ...base, intent: 'setoran_tabungan', keyakinan: 0.85 };
  }
  if (/\b(kalau|kalo|gimana kalau|bagaimana kalau|boleh ?kah|bolehkah|aman ?kah|simulasi)\b/.test(t) && nominal) {
    return { ...base, intent: 'simulasi', keyakinan: 0.85 };
  }
  if (/\b(top ?up)\b/.test(t) && /\b(tidak|belum|gagal|nggak|gak)\b/.test(t)) {
    return { ...base, intent: 'topup_tidak_diterima', keyakinan: 0.85 };
  }
  if (/\b(top ?up)\b/.test(t) && /\b(sudah|udah|masuk|diterima)\b/.test(t)) {
    return { ...base, intent: 'topup_diterima', keyakinan: 0.85 };
  }
  if (/\b(tagihan|jatuh tempo|bayar apa)\b/.test(t)) {
    return { ...base, intent: 'tanya_tagihan', keyakinan: 0.8 };
  }
  if (/\b(anggaran|budget|sisa (?:uang|jatah))\b/.test(t)) {
    return { ...base, intent: 'tanya_anggaran', keyakinan: 0.8 };
  }
  if (/\b(piutang|utang (?:teman|dia)|belum (?:di)?bayar(?:in)?|siapa yang belum)\b/.test(t)) {
    return { ...base, intent: 'tanya_reimburse', keyakinan: 0.75 };
  }
  if (/\b(koreksi|salah|ubah|ganti|perbaiki|bukan)\b/.test(t)) {
    return { ...base, intent: 'koreksi', keyakinan: 0.7 };
  }
  if (/\b(terima|dapat|masuk|gaji|dibayar|dikirim)\b/.test(t) && nominal) {
    return { ...base, intent: 'catat_pemasukan', keyakinan: 0.7 };
  }
  if (nominal) {
    return { ...base, intent: 'catat_pengeluaran', keyakinan: kategori ? 0.8 : 0.6 };
  }
  if (/\b(hari ini|posisi|saldo|gimana)\b/.test(t)) {
    return { ...base, intent: 'tanya_hari', keyakinan: 0.7 };
  }
  return { ...base, intent: 'tidak_jelas', keyakinan: 0.2 };
}
