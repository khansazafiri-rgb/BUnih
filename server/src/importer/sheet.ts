import crypto from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso, today, isValidDate, type IsoDate } from '../domain/time.js';
import { parseAmount } from '../domain/money.js';
import { setAssumption } from '../domain/assumptions.js';
import { createDecision } from '../domain/decisions.js';
import { parseDateLoose } from '../gmail/parsers/helpers.js';
import { detectHeaderRow, normalizeHeader, parseCsv } from './csv.js';

export type SheetTab = 'PENGATURAN' | 'TOPUP' | 'BELANJA' | 'LANGGANAN' | 'ARUS_HARIAN' | 'PERIODE_5_HARI' | 'RINGKASAN';

export type FieldDef = {
  field: string;
  label: string;
  sinonim: string[];
  wajib?: boolean;
  tipe: 'teks' | 'nominal' | 'tanggal' | 'angka' | 'status';
};

/**
 * Definisi kolom per tab Sheet, dengan sinonim bahasa Indonesia.
 * Pemetaan tetap dapat diubah pengguna di web sebelum impor dijalankan.
 */
export const FIELDS: Record<SheetTab, FieldDef[]> = {
  PENGATURAN: [
    { field: 'key', label: 'Nama pengaturan', sinonim: ['pengaturan', 'parameter', 'asumsi', 'keterangan', 'item', 'nama'], wajib: true, tipe: 'teks' },
    { field: 'value', label: 'Nilai', sinonim: ['nilai', 'value', 'jumlah', 'nominal', 'angka'], wajib: true, tipe: 'teks' },
    { field: 'note', label: 'Catatan', sinonim: ['catatan', 'note', 'keterangan tambahan'], tipe: 'teks' },
  ],
  TOPUP: [
    { field: 'plan_date', label: 'Tanggal rencana', sinonim: ['tanggal', 'tanggal rencana', 'rencana tanggal', 'date'], wajib: true, tipe: 'tanggal' },
    { field: 'plan_amount', label: 'Nominal rencana', sinonim: ['rencana', 'nominal rencana', 'rencana top up', 'plan', 'jumlah rencana'], wajib: true, tipe: 'nominal' },
    { field: 'actual_amount', label: 'Nominal aktual', sinonim: ['aktual', 'nominal aktual', 'realisasi', 'aktual masuk', 'masuk'], tipe: 'nominal' },
    { field: 'actual_date', label: 'Tanggal aktual', sinonim: ['tanggal aktual', 'tanggal masuk', 'tanggal realisasi'], tipe: 'tanggal' },
    { field: 'status', label: 'Status', sinonim: ['status', 'keterangan'], tipe: 'status' },
    { field: 'source', label: 'Sumber', sinonim: ['sumber', 'dari', 'pengirim'], tipe: 'teks' },
  ],
  BELANJA: [
    { field: 'name', label: 'Nama barang', sinonim: ['barang', 'nama', 'item', 'belanja', 'keterangan'], wajib: true, tipe: 'teks' },
    { field: 'qty', label: 'Jumlah', sinonim: ['jumlah', 'qty', 'kuantitas', 'banyak'], tipe: 'angka' },
    { field: 'unit_price', label: 'Harga satuan', sinonim: ['harga satuan', 'harga per unit', 'harga', 'unit price'], tipe: 'nominal' },
    { field: 'total', label: 'Total', sinonim: ['total', 'jumlah harga', 'total harga'], tipe: 'nominal' },
    { field: 'date', label: 'Tanggal', sinonim: ['tanggal', 'date', 'rencana tanggal'], tipe: 'tanggal' },
    { field: 'category', label: 'Kategori', sinonim: ['kategori', 'jenis', 'kelompok'], tipe: 'teks' },
    { field: 'owner', label: 'Pemilik barang', sinonim: ['pemilik', 'untuk siapa', 'milik'], tipe: 'teks' },
    { field: 'bearer', label: 'Penanggung biaya', sinonim: ['penanggung', 'ditanggung', 'yang bayar', 'beban'], tipe: 'teks' },
    { field: 'payment_status', label: 'Status pembayaran', sinonim: ['status', 'status bayar', 'pembayaran', 'dibayar'], tipe: 'status' },
  ],
  LANGGANAN: [
    { field: 'name', label: 'Nama layanan', sinonim: ['layanan', 'nama', 'service', 'langganan', 'produk'], wajib: true, tipe: 'teks' },
    { field: 'amount', label: 'Nominal', sinonim: ['nominal', 'biaya', 'harga', 'tarif', 'jumlah'], tipe: 'nominal' },
    { field: 'cycle', label: 'Siklus', sinonim: ['siklus', 'periode', 'bulanan tahunan', 'frekuensi'], tipe: 'teks' },
    { field: 'due_date', label: 'Tanggal tagihan', sinonim: ['tanggal', 'tanggal tagihan', 'jatuh tempo', 'tanggal perkiraan'], tipe: 'tanggal' },
    { field: 'bearer', label: 'Penanggung', sinonim: ['penanggung', 'ditanggung', 'pribadi company', 'beban'], tipe: 'teks' },
    { field: 'status', label: 'Status', sinonim: ['status', 'keterangan', 'kondisi'], tipe: 'status' },
    { field: 'note', label: 'Catatan', sinonim: ['catatan', 'note', 'keterangan tambahan'], tipe: 'teks' },
  ],
  ARUS_HARIAN: [
    { field: 'date', label: 'Tanggal', sinonim: ['tanggal', 'date', 'hari'], wajib: true, tipe: 'tanggal' },
    { field: 'opening', label: 'Saldo pembuka', sinonim: ['saldo awal', 'saldo pembuka', 'pembuka', 'opening'], tipe: 'nominal' },
    { field: 'income', label: 'Pemasukan', sinonim: ['pemasukan', 'masuk', 'income', 'top up'], tipe: 'nominal' },
    { field: 'routine', label: 'Pengeluaran rutin', sinonim: ['rutin', 'makan', 'pengeluaran rutin', 'harian'], tipe: 'nominal' },
    { field: 'extra', label: 'Belanja tambahan', sinonim: ['belanja', 'tambahan', 'belanja tambahan'], tipe: 'nominal' },
    { field: 'bills', label: 'Tagihan', sinonim: ['tagihan', 'langganan', 'bills'], tipe: 'nominal' },
    { field: 'closing', label: 'Saldo penutup', sinonim: ['saldo akhir', 'saldo penutup', 'penutup', 'closing'], tipe: 'nominal' },
    { field: 'status', label: 'Status', sinonim: ['status', 'risiko', 'keterangan'], tipe: 'status' },
  ],
  PERIODE_5_HARI: [
    { field: 'start', label: 'Tanggal mulai', sinonim: ['mulai', 'tanggal mulai', 'awal', 'start'], wajib: true, tipe: 'tanggal' },
    { field: 'end', label: 'Tanggal akhir', sinonim: ['akhir', 'tanggal akhir', 'selesai', 'end'], tipe: 'tanggal' },
    { field: 'income_plan', label: 'Pemasukan terencana', sinonim: ['pemasukan rencana', 'rencana masuk', 'top up rencana'], tipe: 'nominal' },
    { field: 'income_actual', label: 'Pemasukan aktual', sinonim: ['pemasukan aktual', 'masuk aktual', 'realisasi masuk'], tipe: 'nominal' },
    { field: 'closing', label: 'Saldo akhir', sinonim: ['saldo akhir', 'sisa', 'penutup'], tipe: 'nominal' },
    { field: 'status', label: 'Status', sinonim: ['status', 'risiko'], tipe: 'status' },
  ],
  RINGKASAN: [
    { field: 'label', label: 'Keterangan', sinonim: ['keterangan', 'item', 'pos', 'uraian'], wajib: true, tipe: 'teks' },
    { field: 'value', label: 'Nilai', sinonim: ['nilai', 'jumlah', 'nominal', 'value'], tipe: 'nominal' },
  ],
};

export type Mapping = Record<string, number | null>;

export type InspectResult = {
  tab: SheetTab;
  header_row: number;
  headers: string[];
  contoh: string[][];
  jumlah_baris: number;
  pemetaan_usulan: Mapping;
  kolom_tak_terpakai: string[];
  catatan: string[];
};

/** Tampilkan isi CSV dan usulan pemetaan kolom sebelum impor dijalankan. */
export function inspectSheetCsv(tab: SheetTab, csv: string): InspectResult {
  const rows = parseCsv(csv);
  const headerRow = detectHeaderRow(rows);
  const headers = (rows[headerRow] ?? []).map((h) => h.trim());
  const normalized = headers.map(normalizeHeader);
  const defs = FIELDS[tab];
  const pemetaan: Mapping = {};
  const terpakai = new Set<number>();

  for (const def of defs) {
    let idx: number | null = null;
    // Cocok tepat lebih dulu, lalu cocok sebagian.
    for (const s of def.sinonim) {
      const sn = normalizeHeader(s);
      const exact = normalized.findIndex((h, i) => h === sn && !terpakai.has(i));
      if (exact >= 0) {
        idx = exact;
        break;
      }
    }
    if (idx === null) {
      for (const s of def.sinonim) {
        const sn = normalizeHeader(s);
        const partial = normalized.findIndex(
          (h, i) => !terpakai.has(i) && h.length > 2 && (h.includes(sn) || sn.includes(h)),
        );
        if (partial >= 0) {
          idx = partial;
          break;
        }
      }
    }
    if (idx !== null) terpakai.add(idx);
    pemetaan[def.field] = idx;
  }

  const catatan: string[] = [];
  for (const def of defs) {
    if (def.wajib && pemetaan[def.field] === null) {
      catatan.push(`Kolom wajib "${def.label}" belum ditemukan. Pilih manual sebelum impor.`);
    }
  }

  return {
    tab,
    header_row: headerRow,
    headers,
    contoh: rows.slice(headerRow + 1, headerRow + 6),
    jumlah_baris: Math.max(0, rows.length - headerRow - 1),
    pemetaan_usulan: pemetaan,
    kolom_tak_terpakai: headers.filter((_, i) => !terpakai.has(i)),
    catatan,
  };
}

export type ImportReport = {
  tab: SheetTab;
  dry_run: boolean;
  dibuat: number;
  diperbarui: number;
  dilewati: number;
  tidak_jelas: Array<{ baris: number; alasan: string; isi: string[] }>;
  catatan: string[];
  import_run_id: number | null;
};

function nilai(row: string[], mapping: Mapping, field: string): string | null {
  const idx = mapping[field];
  if (idx === null || idx === undefined) return null;
  const v = row[idx];
  return v && v.trim() !== '' ? v.trim() : null;
}

function nominalDari(raw: string | null): number | null {
  if (!raw) return null;
  if (/^(belum|tidak|n\/?a|-|\?)/i.test(raw)) return null;
  const parsed = parseAmount(raw, 'IDR');
  return parsed?.minor ?? null;
}

function tanggalDari(raw: string | null): IsoDate | null {
  if (!raw) return null;
  if (isValidDate(raw)) return raw;
  return parseDateLoose(raw);
}

const STATUS_LANGGANAN: Array<[RegExp, string]> = [
  [/dibatalkan|cancel/i, 'dibatalkan'],
  [/tidak dilanjut|stop|berhenti/i, 'tidak_dilanjutkan'],
  [/sudah dibayar|lunas|paid/i, 'lunas_periode_ini'],
  [/opsional|skenario|optional/i, 'opsional_skenario'],
  [/perpanjang|renew/i, 'akan_perpanjang'],
  [/aktif|active|jalan/i, 'aktif'],
];

function statusLangganan(raw: string | null): string {
  if (!raw) return 'perlu_verifikasi';
  for (const [re, status] of STATUS_LANGGANAN) if (re.test(raw)) return status;
  return 'perlu_verifikasi';
}

function siklusDari(raw: string | null): string {
  if (!raw) return 'belum_jelas';
  if (/tahun|annual|year/i.test(raw)) return 'tahunan';
  if (/bulan|month/i.test(raw)) return 'bulanan';
  if (/pakai|usage|credit|kredit/i.test(raw)) return 'sesuai_pemakaian';
  if (/sekali|one ?time/i.test(raw)) return 'sekali';
  return 'belum_jelas';
}

function penanggungDari(raw: string | null): 'pribadi' | 'company' | 'belum_jelas' {
  if (!raw) return 'belum_jelas';
  if (/company|perusahaan|kantor/i.test(raw)) return 'company';
  if (/pribadi|sendiri|saya|personal/i.test(raw)) return 'pribadi';
  return 'belum_jelas';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function rowKey(tab: SheetTab, natural: string, row: string[]): string {
  const hash = crypto.createHash('sha1').update(row.join('|')).digest('hex').slice(0, 10);
  return `${tab}:${natural}:${hash}`;
}

/**
 * Impor satu tab Sheet.
 *
 * Aman dijalankan berulang: setiap baris punya kunci alami, sehingga impor ulang
 * memperbarui data yang sama alih-alih menciptakan duplikat. Sheet asli tidak
 * pernah diubah oleh aplikasi ini.
 */
export function importSheetTab(
  input: { tab: SheetTab; csv: string; mapping?: Mapping; dryRun?: boolean; label?: string },
  database: DB = db(),
): ImportReport {
  const { tab, csv } = input;
  const inspect = inspectSheetCsv(tab, csv);
  const mapping = input.mapping ?? inspect.pemetaan_usulan;
  const dryRun = input.dryRun ?? false;
  const rows = parseCsv(csv).slice(inspect.header_row + 1);

  const report: ImportReport = {
    tab,
    dry_run: dryRun,
    dibuat: 0,
    diperbarui: 0,
    dilewati: 0,
    tidak_jelas: [],
    catatan: [...inspect.catatan],
    import_run_id: null,
  };

  const runId = dryRun
    ? null
    : Number(
        database
          .prepare(
            `INSERT INTO import_run (source, label, started_at, status) VALUES ('sheet', ?, ?, 'jalan')`,
          )
          .run(input.label ?? `Impor tab ${tab}`, nowIso()).lastInsertRowid,
      );
  report.import_run_id = runId;

  const catatItem = (
    natural: string,
    row: string[],
    entity: string | null,
    entityId: number | null,
    action: 'buat' | 'perbarui' | 'lewati' | 'tidak_jelas',
    reason: string | null,
  ) => {
    if (dryRun || runId === null) return;
    database
      .prepare(
        `INSERT INTO import_item (import_run_id, source, row_key, entity, entity_id, action, reason, payload_json, created_at)
         VALUES (?, 'sheet', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, row_key) DO UPDATE SET
           import_run_id = excluded.import_run_id,
           entity = excluded.entity,
           entity_id = excluded.entity_id,
           action = excluded.action,
           reason = excluded.reason,
           payload_json = excluded.payload_json`,
      )
      .run(runId, rowKey(tab, natural, row), entity, entityId, action, reason, JSON.stringify(row), nowIso());
  };

  const jalankan = () => {
    rows.forEach((row, i) => {
      const nomorBaris = inspect.header_row + 2 + i;

      try {
        if (tab === 'PENGATURAN') {
          const key = nilai(row, mapping, 'key');
          const valueRaw = nilai(row, mapping, 'value');
          if (!key || !valueRaw) {
            report.dilewati += 1;
            return;
          }
          const nominal = nominalDari(valueRaw);
          const slug = slugify(key).replace(/-/g, '_');
          if (!dryRun) {
            setAssumption(
              slug,
              nominal ?? valueRaw,
              {
                effectiveFrom: '1970-01-01',
                certainty: 'asumsi_sheet',
                source: 'sheet',
                note: `Dari tab PENGATURAN: "${key}". ${nilai(row, mapping, 'note') ?? ''}`.trim(),
                actor: 'importer',
              },
              database,
            );
          }
          report.dibuat += 1;
          catatItem(slug, row, 'assumption', null, 'buat', null);
          if (nominal === null && !/^\d/.test(valueRaw)) {
            report.tidak_jelas.push({
              baris: nomorBaris,
              alasan: `Nilai "${valueRaw}" bukan angka, disimpan sebagai teks.`,
              isi: row,
            });
          }
          return;
        }

        if (tab === 'LANGGANAN') {
          const name = nilai(row, mapping, 'name');
          if (!name) {
            report.dilewati += 1;
            return;
          }
          const slug = slugify(name);
          const amountRaw = nilai(row, mapping, 'amount');
          const amount = nominalDari(amountRaw);
          const dueRaw = nilai(row, mapping, 'due_date');
          let due = tanggalDari(dueRaw);
          // Sheet kadang hanya menulis tanggal dalam bulan, mis. "17".
          if (!due && dueRaw && /^\d{1,2}$/.test(dueRaw)) {
            due = null;
            report.tidak_jelas.push({
              baris: nomorBaris,
              alasan: `Tanggal tagihan "${dueRaw}" hanya hari dalam bulan, bukan tanggal pasti. Perlu konfirmasi.`,
              isi: row,
            });
          }
          const statusRaw = nilai(row, mapping, 'status');
          const status = statusLangganan(statusRaw);
          const bearer = penanggungDari(nilai(row, mapping, 'bearer'));
          const cycle = siklusDari(nilai(row, mapping, 'cycle'));

          if (amount === null && amountRaw) {
            report.tidak_jelas.push({
              baris: nomorBaris,
              alasan: `Nominal "${amountRaw}" tidak terbaca sebagai angka. Dibiarkan kosong, bukan nol.`,
              isi: row,
            });
          }

          if (!dryRun) {
            const existing = database
              .prepare(`SELECT id, amount_minor, status FROM service WHERE slug = ?`)
              .get(slug) as { id: number; amount_minor: number | null; status: string } | undefined;
            if (existing) {
              // Jangan menimpa nominal yang sudah terverifikasi dengan asumsi Sheet.
              database
                .prepare(
                  `UPDATE service SET
                     amount_minor = CASE WHEN amount_certainty = 'terverifikasi' THEN amount_minor ELSE COALESCE(?, amount_minor) END,
                     billing_cycle = CASE WHEN billing_cycle = 'belum_jelas' THEN ? ELSE billing_cycle END,
                     next_due_date = COALESCE(next_due_date, ?),
                     bearer = CASE WHEN bearer = 'belum_jelas' THEN ? ELSE bearer END,
                     note = COALESCE(note, ?),
                     updated_at = ?
                   WHERE id = ?`,
                )
                .run(amount, cycle, due, bearer, nilai(row, mapping, 'note'), nowIso(), existing.id);
              report.diperbarui += 1;
              catatItem(slug, row, 'service', existing.id, 'perbarui', null);
            } else {
              const res = database
                .prepare(
                  `INSERT INTO service
                    (slug, name, vendor, plan, bearer, paid_by, billing_cycle, amount_minor, currency,
                     amount_certainty, next_due_date, due_date_certainty, status, note, created_at, updated_at)
                   VALUES (?, ?, ?, NULL, ?, 'belum_jelas', ?, ?, 'IDR', 'asumsi_sheet', ?, 'asumsi_sheet', ?, ?, ?, ?)`,
                )
                .run(
                  slug,
                  name,
                  name.split(/\s+/)[0] ?? name,
                  bearer,
                  cycle,
                  amount,
                  due,
                  status === 'aktif' ? 'perlu_verifikasi' : status,
                  `Diimpor dari tab LANGGANAN. ${nilai(row, mapping, 'note') ?? ''}`.trim(),
                  nowIso(),
                  nowIso(),
                );
              report.dibuat += 1;
              catatItem(slug, row, 'service', Number(res.lastInsertRowid), 'buat', null);
              createDecision(
                {
                  kind: 'verifikasi_langganan',
                  service_id: Number(res.lastInsertRowid),
                  question: `Layanan "${name}" diimpor dari Sheet. Nominal dan statusnya sudah benar?`,
                  options: [
                    { id: 'benar', label: 'Sudah benar' },
                    { id: 'perlu_ubah', label: 'Perlu diubah' },
                  ],
                  dedupe_key: `impor-layanan:${slug}`,
                  priority: 4,
                },
                database,
              );
            }
          } else {
            report.dibuat += 1;
          }
          return;
        }

        if (tab === 'TOPUP') {
          const planDate = tanggalDari(nilai(row, mapping, 'plan_date'));
          if (!planDate) {
            report.tidak_jelas.push({
              baris: nomorBaris,
              alasan: 'Tanggal rencana top-up tidak terbaca.',
              isi: row,
            });
            return;
          }
          const planAmount = nominalDari(nilai(row, mapping, 'plan_amount')) ?? 0;
          const actualAmount = nominalDari(nilai(row, mapping, 'actual_amount'));
          const actualDate = tanggalDari(nilai(row, mapping, 'actual_date'));
          const statusRaw = (nilai(row, mapping, 'status') ?? '').toLowerCase();

          // Rencana tetap rencana. Angka "aktual" di Sheet tidak otomatis menjadi
          // pemasukan yang terbukti; ia hanya menandai status menunggu konfirmasi.
          let status = 'rencana';
          if (/tidak|gagal|batal/.test(statusRaw)) status = 'tidak_diterima';
          const perluKonfirmasi = actualAmount !== null && status === 'rencana';

          if (!dryRun) {
            const key = `sheet-topup:${planDate}`;
            const res = database
              .prepare(
                `INSERT INTO topup_plan
                  (plan_date, plan_amount_minor, currency, account_id, source_label, status,
                   actual_amount_minor, actual_date, cash_event_id, generation_key, note, created_at, updated_at)
                 VALUES (?, ?, 'IDR', NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
                 ON CONFLICT(generation_key) DO UPDATE SET
                   plan_amount_minor = excluded.plan_amount_minor,
                   source_label = excluded.source_label,
                   note = excluded.note,
                   updated_at = excluded.updated_at`,
              )
              .run(
                planDate,
                planAmount,
                nilai(row, mapping, 'source') ?? 'Dari Sheet TOPUP',
                status,
                actualAmount,
                actualDate,
                key,
                perluKonfirmasi
                  ? 'Sheet menyebut nominal aktual, tetapi belum ada bukti masuk. Perlu konfirmasi.'
                  : 'Diimpor dari tab TOPUP.',
                nowIso(),
                nowIso(),
              );
            const id = Number(res.lastInsertRowid);
            report.dibuat += 1;
            catatItem(`topup:${planDate}`, row, 'topup_plan', id, 'buat', null);
            if (perluKonfirmasi && id) {
              createDecision(
                {
                  kind: 'konfirmasi_topup',
                  topup_plan_id: id,
                  question:
                    `Sheet mencatat top-up ${planDate} aktual ${actualAmount}. Uangnya benar-benar masuk?`,
                  options: [
                    { id: 'diterima_penuh', label: 'Ya, sudah masuk' },
                    { id: 'tidak_diterima', label: 'Tidak diterima' },
                  ],
                  dedupe_key: `impor-topup:${planDate}`,
                  priority: 3,
                },
                database,
              );
            }
          } else {
            report.dibuat += 1;
          }
          if (perluKonfirmasi) {
            report.tidak_jelas.push({
              baris: nomorBaris,
              alasan:
                'Nominal aktual ada di Sheet tetapi belum ada bukti masuk, jadi belum dihitung sebagai pemasukan.',
              isi: row,
            });
          }
          return;
        }

        if (tab === 'BELANJA') {
          const name = nilai(row, mapping, 'name');
          if (!name) {
            report.dilewati += 1;
            return;
          }
          const qtyRaw = nilai(row, mapping, 'qty');
          const qty = qtyRaw ? Number(qtyRaw.replace(',', '.')) || 1 : 1;
          const unit = nominalDari(nilai(row, mapping, 'unit_price'));
          let total = nominalDari(nilai(row, mapping, 'total'));
          if (total === null && unit !== null) total = unit * qty;
          const hargaTidakTahu = total === null;
          const tanggal = tanggalDari(nilai(row, mapping, 'date'));
          const bearerRaw = nilai(row, mapping, 'bearer');
          const bearer =
            bearerRaw && /company/i.test(bearerRaw)
              ? 'company'
              : bearerRaw && /teman/i.test(bearerRaw)
                ? 'teman'
                : bearerRaw && /bersama/i.test(bearerRaw)
                  ? 'bersama'
                  : bearerRaw
                    ? 'saya'
                    : 'belum_jelas';
          const statusRaw = (nilai(row, mapping, 'payment_status') ?? '').toLowerCase();
          const payment = /sudah|lunas|dibayar|paid/.test(statusRaw)
            ? 'dibayar'
            : /batal/.test(statusRaw)
              ? 'dibatalkan'
              : 'belum_dibayar';

          if (hargaTidakTahu) {
            report.tidak_jelas.push({
              baris: nomorBaris,
              alasan: `Harga "${name}" belum diketahui. Tidak dianggap gratis; dicatat sebagai risiko anggaran.`,
              isi: row,
            });
          }

          if (!dryRun) {
            const existing = database
              .prepare(`SELECT id FROM purchase WHERE name = ? AND COALESCE(wanted_on,'') = COALESCE(?,'')`)
              .get(name, tanggal) as { id: number } | undefined;
            if (existing) {
              database
                .prepare(
                  `UPDATE purchase SET qty = ?, unit_price_minor = ?, total_minor = ?, price_unknown = ?,
                     final_bearer = ?, payment_status = ?, updated_at = ? WHERE id = ?`,
                )
                .run(qty, unit, total, hargaTidakTahu ? 1 : 0, bearer, payment, nowIso(), existing.id);
              report.diperbarui += 1;
              catatItem(`belanja:${name}:${tanggal ?? '-'}`, row, 'purchase', existing.id, 'perbarui', null);
            } else {
              const res = database
                .prepare(
                  `INSERT INTO purchase
                    (name, qty, unit_price_minor, total_minor, price_unknown, currency, planned,
                     wanted_on, occurred_on, category_id, owner_person_id, final_bearer, payment_status,
                     cash_event_id, note, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'IDR', 1, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
                )
                .run(
                  name,
                  qty,
                  unit,
                  total,
                  hargaTidakTahu ? 1 : 0,
                  tanggal,
                  bearer,
                  payment,
                  'Diimpor dari tab BELANJA (rencana, belum tentu sudah terjadi).',
                  nowIso(),
                  nowIso(),
                );
              report.dibuat += 1;
              catatItem(`belanja:${name}:${tanggal ?? '-'}`, row, 'purchase', Number(res.lastInsertRowid), 'buat', null);
            }
          } else {
            report.dibuat += 1;
          }
          return;
        }

        // ARUS_HARIAN, PERIODE_5_HARI, RINGKASAN: dibaca sebagai pembanding saja.
        // Angka di tab ini adalah hasil rumus Sheet, bukan transaksi, jadi TIDAK
        // pernah menjadi cash_event.
        report.dilewati += 1;
      } catch (err) {
        report.tidak_jelas.push({
          baris: nomorBaris,
          alasan: `Gagal diproses: ${(err as Error).message}`,
          isi: row,
        });
      }
    });
  };

  if (dryRun) {
    jalankan();
  } else {
    const run = database.transaction(jalankan);
    run();
    database
      .prepare(`UPDATE import_run SET finished_at = ?, status = 'selesai', stats_json = ? WHERE id = ?`)
      .run(nowIso(), JSON.stringify(report), runId);
  }

  if (tab === 'ARUS_HARIAN' || tab === 'PERIODE_5_HARI' || tab === 'RINGKASAN') {
    report.catatan.push(
      'Tab ini hanya dipakai sebagai pembanding. Angkanya adalah hasil rumus Sheet, bukan ' +
        'transaksi yang terbukti, jadi tidak pernah dijadikan transaksi kas.',
    );
  }
  report.catatan.push(
    'Sheet asli tidak diubah oleh aplikasi ini. Impor ini hanya membaca salinan CSV yang kamu unggah.',
  );
  return report;
}

export function importHistory(database: DB = db()) {
  return database
    .prepare(`SELECT * FROM import_run ORDER BY started_at DESC LIMIT 30`)
    .all();
}

export function importItems(runId: number, database: DB = db()) {
  return database
    .prepare(`SELECT * FROM import_item WHERE import_run_id = ? ORDER BY id LIMIT 500`)
    .all(runId);
}

export const _internal = { slugify, statusLangganan, siklusDari, penanggungDari, nominalDari, tanggalDari, today };
