import {
  findAccountTail, findReference, findAmount, largestRupiah, labelValue,
  parseDateLoose, parseTimeLoose, senderMatches, toInstant,
} from './helpers.js';
import { isPromotional } from '../classify.js';
import type { MailMessage, MailParser, ParseResult, ParsedTransaction } from '../types.js';
import type { CashKind } from '../../domain/types.js';

const SENDERS = [
  /@bankmandiri\.co\.id$/i,
  /@mandiri\.co\.id$/i,
  /@livin\.bankmandiri\.co\.id$/i,
  /mandiri/i,
];

/** Kata kunci arah uang pada notifikasi Mandiri Livin'. */
const KELUAR = [
  'transfer berhasil', 'pembayaran berhasil', 'pembelian berhasil',
  'debet', 'debit', 'uang keluar', 'anda telah melakukan pembayaran', 'top up berhasil',
  'qris', 'tarik tunai',
];
const MASUK = [
  'dana masuk', 'uang masuk', 'kredit', 'transfer masuk', 'anda menerima',
  'penerimaan dana', 'dana diterima', 'rekening dikredit', 'saldo bertambah', 'transfer diterima',
];

function tebakJenis(text: string): { kind: CashKind; keyakinan: number } {
  const t = text.toLowerCase();
  if (/\btransfer\b/.test(t)) return { kind: 'belum_dikategorikan', keyakinan: 0.6 };
  if (/(qris|merchant|pembelian)/.test(t)) return { kind: 'pengeluaran_pribadi', keyakinan: 0.7 };
  if (/(tagihan|langganan|billing|subscription)/.test(t))
    return { kind: 'bayar_langganan', keyakinan: 0.65 };
  return { kind: 'belum_dikategorikan', keyakinan: 0.55 };
}

export const mandiriParser: MailParser = {
  name: 'mandiri-livin',
  senders: SENDERS,
  matches(msg) {
    if (!senderMatches(msg.from, SENDERS)) return false;
    const hay = `${msg.subject}\n${msg.text}`.toLowerCase();
    return /(rp|idr)\s?[\d.,]{3,}/i.test(hay) || /referensi|transaksi|notifikasi/.test(hay);
  },
  parse(msg: MailMessage): ParseResult | null {
    const promo = isPromotional(msg);
    if (promo.promo) {
      return {
        parser: this.name,
        confidence: 0,
        evidence_kind: 'notifikasi_bank',
        items: [],
        catatan: ['Dinilai sebagai email promosi, jadi tidak dijadikan transaksi.', ...promo.alasan],
      };
    }

    const text = msg.text;
    const hay = `${msg.subject}\n${text}`.toLowerCase();
    const catatan: string[] = [];

    const amount =
      findAmount(text, ['Nominal', 'Jumlah', 'Total', 'Amount', 'Nilai Transaksi']) ??
      largestRupiah(`${msg.subject}\n${text}`);
    if (!amount) {
      return {
        parser: this.name,
        confidence: 0.2,
        evidence_kind: 'notifikasi_bank',
        items: [],
        catatan: ['Nominal tidak ditemukan, jadi tidak ada transaksi yang dibuat.'],
      };
    }

    const adaKeluar = KELUAR.some((k) => hay.includes(k));
    const adaMasuk = MASUK.some((k) => hay.includes(k));
    let direction: 'masuk' | 'keluar';
    let keyakinanArah: number;
    if (adaKeluar && !adaMasuk) {
      direction = 'keluar';
      keyakinanArah = 0.95;
    } else if (adaMasuk && !adaKeluar) {
      direction = 'masuk';
      keyakinanArah = 0.95;
    } else if (adaKeluar && adaMasuk) {
      direction = 'keluar';
      keyakinanArah = 0.5;
      catatan.push('Email memuat tanda uang masuk dan keluar sekaligus — perlu diperiksa.');
    } else {
      direction = 'keluar';
      keyakinanArah = 0.4;
      catatan.push('Arah uang tidak disebut jelas; diasumsikan keluar dan perlu dikonfirmasi.');
    }

    const tanggalRaw =
      labelValue(text, ['Tanggal', 'Waktu Transaksi', 'Tanggal Transaksi', 'Date']) ?? msg.date;
    const tanggal = parseDateLoose(tanggalRaw) ?? parseDateLoose(msg.date) ?? msg.date.slice(0, 10);
    const jam = parseTimeLoose(tanggalRaw) ?? parseTimeLoose(text) ?? null;

    const merchant =
      labelValue(text, [
        'Merchant', 'Penerima', 'Nama Penerima', 'Tujuan', 'Nama Merchant', 'Kepada',
        'Biller', 'Nama Biller',
      ]) ?? null;

    const destBankRaw = labelValue(text, ['Bank Tujuan', 'Bank Penerima', 'Bank']) ?? null;
    const sourceTail = findAccountTail(text, [
      'Rekening Sumber', 'Sumber Dana', 'Dari Rekening', 'No\\.? Rekening Sumber',
    ]);
    const destTail = findAccountTail(text, [
      'Rekening Tujuan', 'No\\.? Rekening Tujuan', 'Nomor Tujuan', 'Rekening Penerima',
      'Rekening Dikredit', 'Nomor Rekening Penerima', 'Rekening Anda',
    ], { tanpaCadangan: true });

    const jenis = tebakJenis(hay);
    const tx: ParsedTransaction = {
      tipe: 'transaksi',
      occurred_at: toInstant(tanggal, jam),
      direction,
      amount_minor: amount.minor,
      currency: amount.currency,
      kind: direction === 'masuk' ? 'pemasukan_luar' : jenis.kind,
      merchant,
      counterparty: merchant,
      reference_no: findReference(text),
      source_account_tail: direction === 'masuk' ? null : sourceTail,
      source_bank: direction === 'masuk' ? null : 'Mandiri',
      dest_account_tail: direction === 'masuk' ? (destTail ?? findAccountTail(text, ['Nomor Rekening', 'No\\.? Rekening'], { tanpaCadangan: true })) : destTail,
      dest_bank: direction === 'masuk' ? 'Mandiri' : destBankRaw,
      dest_name: merchant,
      dest_is_mine: null,
      note: catatan.length ? catatan.join(' ') : null,
    };

    const confidence = Math.min(
      0.95,
      0.4 + keyakinanArah * 0.35 + (tx.reference_no ? 0.2 : 0) + jenis.keyakinan * 0.1,
    );

    return {
      parser: this.name,
      confidence,
      evidence_kind: 'notifikasi_bank',
      items: [tx],
      catatan,
    };
  },
};
