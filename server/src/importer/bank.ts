import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso, isValidDate, type IsoDate } from '../domain/time.js';
import { parseAmount } from '../domain/money.js';
import { sha256 } from '../util/crypto.js';
import { recordCashEvent } from '../domain/ledger.js';
import { recordReconciliation } from '../domain/balances.js';
import { createDecision } from '../domain/decisions.js';
import { parseDateLoose } from '../gmail/parsers/helpers.js';
import { detectHeaderRow, normalizeHeader, parseCsv } from './csv.js';

export type BankMapping = {
  tanggal: number | null;
  keterangan: number | null;
  debit: number | null;
  kredit: number | null;
  nominal: number | null;
  arah: number | null;
  saldo: number | null;
  referensi: number | null;
};

const SINONIM: Record<keyof BankMapping, string[]> = {
  tanggal: ['tanggal', 'date', 'tgl', 'tanggal transaksi', 'posting date'],
  keterangan: ['keterangan', 'uraian', 'description', 'berita', 'remark', 'detail', 'merchant'],
  debit: ['debit', 'debet', 'keluar', 'withdrawal', 'db'],
  kredit: ['kredit', 'credit', 'masuk', 'deposit', 'cr'],
  nominal: ['nominal', 'jumlah', 'amount', 'nilai'],
  arah: ['arah', 'tipe', 'type', 'dk', 'd k', 'mutasi'],
  saldo: ['saldo', 'balance', 'saldo akhir', 'running balance'],
  referensi: ['referensi', 'no referensi', 'reference', 'ref', 'no transaksi', 'trace'],
};

export type BankInspect = {
  header_row: number;
  headers: string[];
  contoh: string[][];
  jumlah_baris: number;
  pemetaan_usulan: BankMapping;
  catatan: string[];
};

export function inspectBankCsv(csv: string): BankInspect {
  const rows = parseCsv(csv);
  const headerRow = detectHeaderRow(rows);
  const headers = (rows[headerRow] ?? []).map((h) => h.trim());
  const normalized = headers.map(normalizeHeader);
  const pemetaan = {} as BankMapping;

  for (const key of Object.keys(SINONIM) as Array<keyof BankMapping>) {
    let idx: number | null = null;
    for (const s of SINONIM[key]) {
      const sn = normalizeHeader(s);
      const found = normalized.findIndex((h) => h === sn);
      if (found >= 0) {
        idx = found;
        break;
      }
    }
    if (idx === null) {
      for (const s of SINONIM[key]) {
        const sn = normalizeHeader(s);
        const found = normalized.findIndex((h) => h.length > 2 && h.includes(sn));
        if (found >= 0) {
          idx = found;
          break;
        }
      }
    }
    pemetaan[key] = idx;
  }

  const catatan: string[] = [];
  if (pemetaan.tanggal === null) catatan.push('Kolom tanggal belum ditemukan — pilih manual.');
  if (pemetaan.debit === null && pemetaan.kredit === null && pemetaan.nominal === null) {
    catatan.push('Kolom nominal/debit/kredit belum ditemukan — pilih manual.');
  }

  return {
    header_row: headerRow,
    headers,
    contoh: rows.slice(headerRow + 1, headerRow + 6),
    jumlah_baris: Math.max(0, rows.length - headerRow - 1),
    pemetaan_usulan: pemetaan,
    catatan,
  };
}

export type BankImportReport = {
  account_id: number;
  dry_run: boolean;
  baris_dibaca: number;
  transaksi_dibuat: number;
  transaksi_digabung: number;
  dilewati: number;
  tidak_jelas: Array<{ baris: number; alasan: string; isi: string[] }>;
  rekonsiliasi: { as_of: string; saldo_minor: number } | null;
  catatan: string[];
};

function sel(row: string[], idx: number | null): string | null {
  if (idx === null) return null;
  const v = row[idx];
  return v && v.trim() !== '' ? v.trim() : null;
}

/**
 * Impor mutasi rekening dari CSV.
 *
 * Mutasi adalah sumber paling lengkap untuk saldo, jadi baris saldo terakhir
 * dipakai sebagai titik tambat rekonsiliasi. Transaksi yang sudah dikenal dari
 * notifikasi email akan digabung, bukan diduplikasi.
 */
export function importBankCsv(
  input: {
    account_id: number;
    csv: string;
    mapping?: BankMapping;
    dryRun?: boolean;
    pakaiSaldoTerakhir?: boolean;
    label?: string;
  },
  database: DB = db(),
): BankImportReport {
  const inspect = inspectBankCsv(input.csv);
  const mapping = input.mapping ?? inspect.pemetaan_usulan;
  const dryRun = input.dryRun ?? false;
  const rows = parseCsv(input.csv).slice(inspect.header_row + 1);

  const report: BankImportReport = {
    account_id: input.account_id,
    dry_run: dryRun,
    baris_dibaca: rows.length,
    transaksi_dibuat: 0,
    transaksi_digabung: 0,
    dilewati: 0,
    tidak_jelas: [],
    rekonsiliasi: null,
    catatan: [...inspect.catatan],
  };

  const akun = database.prepare(`SELECT id, name FROM account WHERE id = ?`).get(input.account_id) as
    | { id: number; name: string }
    | undefined;
  if (!akun) throw new Error(`Rekening ${input.account_id} tidak ditemukan.`);

  const runId = dryRun
    ? null
    : Number(
        database
          .prepare(
            `INSERT INTO import_run (source, label, started_at, status) VALUES ('mutasi_csv', ?, ?, 'jalan')`,
          )
          .run(input.label ?? `Mutasi ${akun.name}`, nowIso()).lastInsertRowid,
      );

  let saldoTerakhir: { as_of: string; saldo_minor: number } | null = null;

  const jalankan = () => {
    rows.forEach((row, i) => {
      const nomorBaris = inspect.header_row + 2 + i;
      const tanggalRaw = sel(row, mapping.tanggal);
      const tanggal: IsoDate | null = tanggalRaw
        ? isValidDate(tanggalRaw)
          ? tanggalRaw
          : parseDateLoose(tanggalRaw)
        : null;
      if (!tanggal) {
        report.dilewati += 1;
        return;
      }

      // Baca saldo lebih dulu: baris seperti "SALDO AWAL" tidak punya mutasi
      // tetapi tetap memberi informasi saldo yang berguna.
      const saldoRaw = sel(row, mapping.saldo);
      if (saldoRaw) {
        const parsedSaldo = parseAmount(saldoRaw, 'IDR');
        if (parsedSaldo) saldoTerakhir = { as_of: `${tanggal}T23:59:59+07:00`, saldo_minor: parsedSaldo.minor };
      }

      const debit = sel(row, mapping.debit);
      const kredit = sel(row, mapping.kredit);
      const nominalRaw = sel(row, mapping.nominal);
      const arahRaw = (sel(row, mapping.arah) ?? '').toLowerCase();

      let direction: 'masuk' | 'keluar' | null = null;
      let minor: number | null = null;

      if (debit && parseAmount(debit, 'IDR')?.minor) {
        direction = 'keluar';
        minor = parseAmount(debit, 'IDR')!.minor;
      } else if (kredit && parseAmount(kredit, 'IDR')?.minor) {
        direction = 'masuk';
        minor = parseAmount(kredit, 'IDR')!.minor;
      } else if (nominalRaw) {
        const parsed = parseAmount(nominalRaw, 'IDR');
        if (parsed) {
          minor = Math.abs(parsed.minor);
          if (/^(d|db|debet|debit|keluar|-)/.test(arahRaw)) direction = 'keluar';
          else if (/^(c|cr|kredit|credit|masuk|\+)/.test(arahRaw)) direction = 'masuk';
          else direction = parsed.minor < 0 ? 'keluar' : 'masuk';
        }
      }

      if (!direction || !minor) {
        report.tidak_jelas.push({
          baris: nomorBaris,
          alasan: 'Arah atau nominal mutasi tidak dapat dipastikan.',
          isi: row,
        });
        return;
      }

      const keterangan = sel(row, mapping.keterangan);
      const referensi =
        sel(row, mapping.referensi) ??
        // Tanpa nomor referensi, pakai sidik jari baris agar impor ulang idempoten.
        `csv-${sha256(`${input.account_id}|${tanggal}|${direction}|${minor}|${keterangan ?? ''}|${i}`).slice(0, 16)}`;

      if (dryRun) {
        report.transaksi_dibuat += 1;
        return;
      }

      const res = recordCashEvent(
        {
          occurred_at: `${tanggal}T12:00:00+07:00`,
          direction,
          amount_minor: minor,
          account_id: input.account_id,
          kind: 'belum_dikategorikan',
          merchant_raw: keterangan,
          reference_no: referensi,
          status: 'perlu_verifikasi',
          certainty: 'terverifikasi',
          source: 'csv',
          note: 'Dari impor mutasi rekening.',
          actor: 'importer',
        },
        database,
      );
      if (res.created) report.transaksi_dibuat += 1;
      else report.transaksi_digabung += 1;

      if (runId !== null) {
        database
          .prepare(
            `INSERT INTO import_item (import_run_id, source, row_key, entity, entity_id, action, reason, payload_json, created_at)
             VALUES (?, 'mutasi_csv', ?, 'cash_event', ?, ?, NULL, ?, ?)
             ON CONFLICT(source, row_key) DO UPDATE SET import_run_id = excluded.import_run_id`,
          )
          .run(
            runId,
            `mutasi:${input.account_id}:${referensi}`,
            res.id,
            res.created ? 'buat' : 'lewati',
            JSON.stringify(row),
            nowIso(),
          );
      }
    });
  };

  if (dryRun) {
    jalankan();
  } else {
    const run = database.transaction(jalankan);
    run();
  }

  if (saldoTerakhir && (input.pakaiSaldoTerakhir ?? true) && !dryRun) {
    const s = saldoTerakhir as { as_of: string; saldo_minor: number };
    recordReconciliation(
      {
        account_id: input.account_id,
        as_of: s.as_of,
        statement_balance_minor: s.saldo_minor,
        source: 'csv',
        note: 'Saldo baris terakhir mutasi dipakai sebagai titik tambat.',
      },
      database,
    );
    report.rekonsiliasi = s;
    report.catatan.push(
      `Saldo ${s.saldo_minor} per ${s.as_of.slice(0, 10)} dicatat sebagai saldo terkonfirmasi.`,
    );
  } else if (!saldoTerakhir) {
    report.catatan.push(
      'Mutasi ini tidak memuat kolom saldo, jadi saldo rekening belum dapat dipastikan. ' +
        'Masukkan saldo terkonfirmasi secara manual di Pengaturan.',
    );
  }

  if (!dryRun && runId !== null) {
    database
      .prepare(`UPDATE import_run SET finished_at = ?, status = 'selesai', stats_json = ? WHERE id = ?`)
      .run(nowIso(), JSON.stringify(report), runId);
  }

  if (report.transaksi_dibuat > 0 && !dryRun) {
    createDecision(
      {
        kind: 'kategori_transaksi',
        question:
          `${report.transaksi_dibuat} transaksi baru dari mutasi ${akun.name} belum berkategori. ` +
          'Buka Transaksi di web untuk mengelompokkannya.',
        options: [{ id: 'benar', label: 'Oke, nanti kucek' }],
        dedupe_key: `mutasi-perlu-kategori:${runId ?? nowIso()}`,
        priority: 4,
      },
      database,
    );
  }

  return report;
}

/**
 * Ambil baris mutasi dari teks PDF yang sudah diekstrak (mis. oleh pdftotext).
 * Hasilnya diubah menjadi CSV sederhana agar melewati jalur yang sama.
 */
export function pdfTextToCsv(text: string): string {
  const baris = text.split(/\r?\n/);
  const out: string[] = ['tanggal;keterangan;debit;kredit;saldo'];
  const pola =
    /^(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})\s+(.{3,}?)\s{2,}([\d.,]+)?\s*(DB|CR|D|K)?\s*([\d.,]+)?\s*$/i;
  for (const b of baris) {
    const m = b.trim().match(pola);
    if (!m) continue;
    const tanggal = m[1]!;
    const keterangan = (m[2] ?? '').replace(/;/g, ' ').trim();
    const nominal = m[3] ?? '';
    const arah = (m[4] ?? '').toUpperCase();
    const saldo = m[5] ?? '';
    const debit = arah.startsWith('D') ? nominal : '';
    const kredit = arah.startsWith('C') || arah === 'K' ? nominal : '';
    out.push([tanggal, keterangan, debit, kredit, saldo].join(';'));
  }
  return out.join('\n');
}
