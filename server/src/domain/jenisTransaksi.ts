/**
 * Makna keuangan sebuah transaksi, dipisahkan dari kategori, merchant, dan penanggung akhir.
 *
 *   jenis      → apa yang terjadi pada uang (pribadi, reimburse, transfer sendiri, ...)
 *   kategori   → untuk apa (Makanan, Pacaran, ...)
 *   merchant   → ke/dari siapa
 *   penanggung → siapa yang akhirnya menanggung (saya, company, teman) — diturunkan dari potongan alokasi
 *
 * Mengubah jenis selalu memperbarui `cash_event.kind` DAN potongan `allocation` dalam satu langkah,
 * sehingga saldo, laporan, dan proyeksi tetap konsisten.
 */
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { writeAudit } from './audit.js';
import { allocationsOf, getCashEvent, recategorize, resplitCashEvent } from './ledger.js';
import {
  jadikanCompanyLangsung, jadikanHadiah, jadikanReimburseCompany, jadikanTalangan, jadikanTransferSendiri,
} from './applyDecision.js';
import { formatIDR } from './money.js';
import { tandaiTopupDiterima } from './topup.js';
import { nowIso } from './time.js';

export type KodeJenis =
  | 'pribadi' | 'company' | 'reimburse' | 'talangan' | 'bersama' | 'transfer'
  | 'tabungan' | 'hadiah' | 'refund' | 'pemasukan' | 'topup' | 'fee' | 'belum_yakin';

export type DefJenis = {
  kode: KodeJenis;
  label: string;
  arah: 'keluar' | 'masuk' | 'semua';
  /** Setelah dipilih, kategori pengeluaran tidak relevan lagi (mis. transfer ke rekening sendiri). */
  menutup: boolean;
};

export const DAFTAR_JENIS: DefJenis[] = [
  { kode: 'pribadi', label: '💸 Pengeluaran pribadi', arah: 'keluar', menutup: false },
  { kode: 'company', label: '🏢 Biaya company', arah: 'keluar', menutup: true },
  { kode: 'reimburse', label: '🧾 Company reimburse', arah: 'keluar', menutup: true },
  { kode: 'talangan', label: '🤝 Talangan teman', arah: 'keluar', menutup: true },
  { kode: 'bersama', label: '👥 Pembayaran bersama', arah: 'keluar', menutup: true },
  { kode: 'transfer', label: '🔁 Transfer antarrekening', arah: 'semua', menutup: true },
  { kode: 'tabungan', label: '🐷 Tabungan', arah: 'semua', menutup: true },
  { kode: 'hadiah', label: '🎁 Hadiah', arah: 'keluar', menutup: false },
  { kode: 'refund', label: '↩️ Refund', arah: 'masuk', menutup: false },
  { kode: 'pemasukan', label: '💰 Pemasukan', arah: 'masuk', menutup: true },
  { kode: 'topup', label: '🎁 Top-up diterima', arah: 'masuk', menutup: true },
  { kode: 'fee', label: '🏦 Biaya layanan / fee', arah: 'keluar', menutup: false },
  { kode: 'belum_yakin', label: '❔ Belum yakin', arah: 'semua', menutup: false },
];

export function jenisUntukArah(arah: 'keluar' | 'masuk'): DefJenis[] {
  return DAFTAR_JENIS.filter((j) => j.arah === 'semua' || j.arah === arah);
}

export class JenisError extends Error {}

export type HasilJenis = {
  pesan: string;
  /** 'bagi' = alur patungan perlu angka dari pengguna sebelum selesai. */
  perluInput?: 'bagi';
  def: DefJenis;
};

export function terapkanJenis(
  cashEventId: number,
  kode: KodeJenis,
  actor = 'telegram',
  database: DB = db(),
): HasilJenis {
  const def = DAFTAR_JENIS.find((j) => j.kode === kode);
  if (!def) throw new JenisError('Jenis itu tidak dikenal.');
  const ev = getCashEvent(cashEventId, database);
  if (!ev) throw new JenisError('Transaksi tidak ditemukan.');
  if (ev.status === 'dibatalkan') throw new JenisError('Transaksi ini sudah dibatalkan.');
  if (def.arah !== 'semua' && def.arah !== ev.direction) {
    throw new JenisError(
      def.arah === 'keluar' ? 'Jenis ini hanya untuk uang keluar.' : 'Jenis ini hanya untuk uang masuk.',
    );
  }

  const satuPotongan = (purpose: 'biaya_pribadi' | 'refund' | 'pemasukan', kategori: number | null, catatan?: string) =>
    resplitCashEvent(
      cashEventId,
      [{ amount_minor: ev.amount_minor, purpose, bearer_type: 'saya', category_id: kategori, note: catatan ?? null }],
      actor,
      database,
    );
  const konfirmasi = () =>
    database
      .prepare(
        `UPDATE cash_event SET status = CASE WHEN status = 'perlu_verifikasi' THEN 'terkonfirmasi' ELSE status END, updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(), cashEventId);

  return database.transaction((): HasilJenis => {
    switch (kode) {
      case 'pribadi':
        recategorize(cashEventId, { kind: 'pengeluaran_pribadi' }, actor, database);
        satuPotongan('biaya_pribadi', ev.category_id);
        konfirmasi();
        return { def, pesan: 'Dicatat sebagai pengeluaran pribadi.' };
      case 'company':
        jadikanCompanyLangsung(cashEventId, actor, database);
        return { def, pesan: 'Dicatat sebagai biaya company yang dibayar langsung company — saldoku tidak berubah.' };
      case 'reimburse':
        jadikanReimburseCompany(cashEventId, { actor }, database);
        return { def, pesan: 'Dicatat sebagai klaim reimburse company. Saldoku turun sampai uangnya kembali.' };
      case 'talangan':
        return { def, pesan: jadikanTalangan(cashEventId, null, actor, database).pesan };
      case 'bersama':
        return {
          def,
          perluInput: 'bagi',
          pesan:
            `Total ${formatIDR(ev.amount_minor)}. Tulis pembagiannya, misalnya "aku 30rb, 3 teman" atau "berempat".`,
        };
      case 'transfer':
        return { def, pesan: jadikanTransferSendiri(cashEventId, { ke_tabungan: false, actor }, database).pesan };
      case 'tabungan':
        return { def, pesan: jadikanTransferSendiri(cashEventId, { ke_tabungan: true, actor }, database).pesan };
      case 'hadiah':
        return { def, pesan: jadikanHadiah(cashEventId, actor, database).pesan };
      case 'refund':
        recategorize(cashEventId, { kind: 'refund' }, actor, database);
        satuPotongan('refund', ev.category_id);
        konfirmasi();
        return { def, pesan: 'Dicatat sebagai refund: mengurangi pengeluaranmu, bukan pemasukan.' };
      case 'pemasukan':
        recategorize(cashEventId, { kind: 'pemasukan_luar' }, actor, database);
        satuPotongan('pemasukan', null);
        konfirmasi();
        return { def, pesan: 'Dicatat sebagai pemasukan.' };
      case 'topup': {
        const hasil = tandaiTopupDiterima(cashEventId, actor, database);
        return { def, pesan: hasil.pesan };
      }
      case 'fee': {
        const kat = database.prepare(`SELECT id FROM category WHERE slug = 'biaya-admin' AND active = 1`).get() as
          | { id: number }
          | undefined;
        const kategori = ev.category_id ?? kat?.id ?? null;
        recategorize(cashEventId, { kind: 'pengeluaran_pribadi', category_id: kategori }, actor, database);
        satuPotongan('biaya_pribadi', kategori, 'Biaya layanan / fee');
        konfirmasi();
        return { def, pesan: 'Dicatat sebagai biaya layanan / fee (pengeluaran pribadi).' };
      }
      case 'belum_yakin':
        database
          .prepare(`UPDATE cash_event SET status = 'perlu_verifikasi', updated_at = ? WHERE id = ?`)
          .run(nowIso(), cashEventId);
        writeAudit({ entity: 'cash_event', entity_id: cashEventId, action: 'ditandai_belum_yakin', actor }, database);
        return { def, pesan: 'Ditandai belum yakin. Transaksi tetap tercatat dan akan ditanyakan lagi nanti.' };
    }
  })();
}

/** Penanggung akhir, diturunkan dari potongan alokasi (bukan atribut terpisah yang bisa tidak sinkron). */
export function ringkasPenanggung(cashEventId: number, database: DB = db()): string {
  const ps = allocationsOf(cashEventId, database) as Array<{ purpose: string; bearer_name: string | null }>;
  const label = new Set<string>();
  for (const a of ps) {
    switch (a.purpose) {
      case 'biaya_pribadi':
      case 'kredit_layanan':
        label.add('Saya');
        break;
      case 'piutang_company':
        label.add('Company (reimburse)');
        break;
      case 'biaya_company_langsung':
        label.add('Company');
        break;
      case 'piutang_teman':
        label.add(`${a.bearer_name ?? 'Teman'} (diganti kembali)`);
        break;
      case 'transfer_internal':
      case 'tabungan':
        label.add('— (perpindahan uangku sendiri)');
        break;
      case 'pemasukan':
      case 'refund':
        label.add('—');
        break;
      default:
        break;
    }
  }
  return label.size ? [...label].join(' + ') : '—';
}
