import crypto from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso, dateOf, toJakartaInstant, type IsoDate } from './time.js';
import { writeAudit } from './audit.js';
import { normalizeMerchant } from './merchantNorm.js';
import { resolveMerchant } from './merchants.js';
import type {
  AllocationPurpose,
  BearerType,
  CashDirection,
  CashKind,
  CashStatus,
  Certainty,
  SourceKind,
} from './types.js';

export type AllocationInput = {
  amount_minor: number;
  purpose: AllocationPurpose;
  bearer_type: BearerType;
  bearer_person_id?: number | null;
  category_id?: number | null;
  note?: string | null;
  /** Wajib untuk purpose 'pelunasan_piutang': piutang mana yang dikurangi. */
  receivable_id?: number | null;
  /** Perkiraan tanggal uang kembali, untuk piutang. */
  expected_on?: IsoDate | null;
};

export type EvidenceLink = {
  evidence_id: number;
  role: 'notifikasi_bank' | 'kuitansi' | 'mutasi' | 'foto' | 'manual' | 'lainnya';
};

export type CashEventInput = {
  occurred_at: string;
  direction: CashDirection;
  amount_minor: number;
  currency?: string;
  /** null = uang tidak lewat rekening saya (company bayar langsung). */
  account_id?: number | null;
  is_cash?: boolean;
  kind: CashKind;
  merchant_raw?: string | null;
  counterparty?: string | null;
  reference_no?: string | null;
  status?: CashStatus;
  certainty?: Certainty;
  service_id?: number | null;
  invoice_id?: number | null;
  category_id?: number | null;
  obligation_id?: number | null;
  /** Proyek terkait (mis. MEDCOEL), opsional. */
  project?: string | null;
  source: SourceKind;
  note?: string | null;
  allocations?: AllocationInput[];
  evidence?: EvidenceLink[];
  actor?: string;
};

export type CashEventRow = {
  id: number;
  occurred_at: string;
  direction: CashDirection;
  amount_minor: number;
  currency: string;
  account_id: number | null;
  is_cash: number;
  kind: CashKind;
  merchant_raw: string | null;
  merchant_norm: string | null;
  counterparty: string | null;
  reference_no: string | null;
  status: CashStatus;
  certainty: Certainty;
  transfer_group_id: string | null;
  service_id: number | null;
  invoice_id: number | null;
  category_id: number | null;
  obligation_id: number | null;
  merchant_id: number | null;
  project: string | null;
  source: SourceKind;
  dedupe_key: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type RecordResult = {
  id: number;
  created: boolean;
  /** true bila bukti baru digabung ke peristiwa yang sudah ada. */
  merged: boolean;
  needs_decision: boolean;
  pesan: string[];
};

export class LedgerError extends Error {}

export { normalizeMerchant } from './merchantNorm.js';

/**
 * Kunci deduplikasi yang TIDAK memuat sumber data, supaya satu pembayaran yang
 * muncul lewat notifikasi bank, kuitansi, dan mutasi CSV tetap menjadi satu peristiwa.
 */
export function cashDedupeKey(input: {
  reference_no?: string | null;
  amount_minor: number;
  direction: CashDirection;
  account_id?: number | null;
  occurred_at: string;
  merchant_norm?: string | null;
}): string {
  if (input.reference_no && input.reference_no.trim().length >= 4) {
    return `ref:${input.reference_no.trim().toLowerCase()}:${input.amount_minor}`;
  }
  const parts = [
    'tx',
    input.account_id ?? 'tanpa-rekening',
    dateOf(input.occurred_at),
    input.direction,
    input.amount_minor,
    input.merchant_norm ?? 'tanpa-merchant',
  ];
  return parts.join(':');
}

/**
 * Alokasi bawaan menurut jenis transaksi.
 * Tujuannya: setiap rupiah punya satu makna, sehingga laporan tidak menghitung ganda.
 */
export function defaultAllocations(
  kind: CashKind,
  amount_minor: number,
  categoryId: number | null,
): { allocations: AllocationInput[]; needsDecision: boolean } {
  const base = { amount_minor, category_id: categoryId ?? null };
  const one = (purpose: AllocationPurpose, bearer: BearerType): AllocationInput[] => [
    { ...base, purpose, bearer_type: bearer },
  ];
  switch (kind) {
    case 'pemasukan_luar':
      return { allocations: one('pemasukan', 'saya'), needsDecision: false };
    case 'pengeluaran_pribadi':
    case 'bayar_langganan':
      return { allocations: one('biaya_pribadi', 'saya'), needsDecision: false };
    case 'beli_kredit_layanan':
      return { allocations: one('kredit_layanan', 'saya'), needsDecision: false };
    // Hadiah tetap pengeluaran pribadi saya, bukan piutang.
    case 'hadiah':
      return { allocations: one('biaya_pribadi', 'saya'), needsDecision: false };
    case 'pengeluaran_company_langsung':
      return { allocations: one('biaya_company_langsung', 'company'), needsDecision: false };
    case 'pengeluaran_reimburse_company':
      return { allocations: one('piutang_company', 'company'), needsDecision: false };
    case 'talangan':
      return { allocations: one('piutang_teman', 'teman'), needsDecision: false };
    // Pembayaran bersama butuh rincian siapa dan berapa.
    case 'pengeluaran_bersama':
      return { allocations: one('biaya_pribadi', 'saya'), needsDecision: true };
    case 'transfer_internal':
    case 'penarikan_tabungan':
      return { allocations: one('transfer_internal', 'saya'), needsDecision: false };
    case 'setoran_tabungan':
      return { allocations: one('tabungan', 'saya'), needsDecision: false };
    case 'refund':
      return { allocations: one('refund', 'saya'), needsDecision: false };
    case 'koreksi':
      return { allocations: one('penyesuaian', 'saya'), needsDecision: false };
    case 'belum_dikategorikan':
    default:
      return { allocations: one('penyesuaian', 'saya'), needsDecision: true };
  }
}

function assertAllocationsBalance(amount: number, allocations: AllocationInput[]): void {
  const total = allocations.reduce((s, a) => s + a.amount_minor, 0);
  if (total !== amount) {
    throw new LedgerError(
      `Jumlah pembagian biaya (${total}) tidak sama dengan nominal transaksi (${amount}). ` +
        'Perbaiki rinciannya agar tidak ada rupiah yang hilang atau dihitung dua kali.',
    );
  }
  for (const a of allocations) {
    if (a.amount_minor <= 0) throw new LedgerError('Setiap bagian biaya harus lebih dari nol.');
    if (a.purpose === 'pelunasan_piutang' && !a.receivable_id) {
      throw new LedgerError('Pelunasan piutang harus menunjuk piutang yang dikurangi.');
    }
  }
}

function insertAllocations(
  database: DB,
  cashEventId: number,
  occurredOn: IsoDate,
  allocations: AllocationInput[],
): { receivableIds: number[]; settlementIds: number[] } {
  const at = nowIso();
  const insAlloc = database.prepare(
    `INSERT INTO allocation
      (cash_event_id, amount_minor, purpose, bearer_type, bearer_person_id, category_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insRecv = database.prepare(
    `INSERT INTO receivable
      (allocation_id, debtor_type, debtor_person_id, origin_amount_minor, settled_minor, currency,
       occurred_on, claimed_at, expected_on, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'IDR', ?, NULL, ?, 'belum_diklaim', NULL, ?, ?)`,
  );
  const receivableIds: number[] = [];
  const settlementIds: number[] = [];

  for (const a of allocations) {
    const res = insAlloc.run(
      cashEventId,
      a.amount_minor,
      a.purpose,
      a.bearer_type,
      a.bearer_person_id ?? null,
      a.category_id ?? null,
      a.note ?? null,
      at,
    );
    const allocationId = Number(res.lastInsertRowid);

    if (a.purpose === 'piutang_teman' || a.purpose === 'piutang_company') {
      const debtorType = a.purpose === 'piutang_company' ? 'company' : 'teman';
      const r = insRecv.run(
        allocationId,
        debtorType,
        a.bearer_person_id ?? null,
        a.amount_minor,
        occurredOn,
        a.expected_on ?? null,
        at,
        at,
      );
      receivableIds.push(Number(r.lastInsertRowid));
    }

    if (a.purpose === 'pelunasan_piutang' && a.receivable_id) {
      settlementIds.push(
        applySettlement(
          { receivable_id: a.receivable_id, cash_event_id: cashEventId, amount_minor: a.amount_minor, settled_on: occurredOn },
          database,
        ),
      );
    }
  }
  return { receivableIds, settlementIds };
}

/**
 * Catat uang masuk sebagai pelunasan piutang — BUKAN pendapatan baru.
 * Piutang berkurang; laporan pemasukan tidak bertambah.
 */
export function applySettlement(
  input: { receivable_id: number; cash_event_id: number | null; amount_minor: number; settled_on: IsoDate; note?: string | null },
  database: DB = db(),
): number {
  const recv = database
    .prepare(`SELECT * FROM receivable WHERE id = ?`)
    .get(input.receivable_id) as
    | { id: number; origin_amount_minor: number; settled_minor: number; status: string }
    | undefined;
  if (!recv) throw new LedgerError(`Piutang ${input.receivable_id} tidak ditemukan.`);

  const sisaSebelum = recv.origin_amount_minor - recv.settled_minor;
  if (input.amount_minor > sisaSebelum) {
    throw new LedgerError(
      `Pelunasan ${input.amount_minor} melebihi sisa piutang ${sisaSebelum}. ` +
        'Pisahkan kelebihannya sebagai pemasukan atau koreksi agar tidak menjadi uang baru.',
    );
  }

  const at = nowIso();
  const res = database
    .prepare(
      `INSERT INTO receivable_settlement (receivable_id, cash_event_id, amount_minor, settled_on, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.receivable_id, input.cash_event_id, input.amount_minor, input.settled_on, input.note ?? null, at);

  const settled = recv.settled_minor + input.amount_minor;
  const status =
    settled >= recv.origin_amount_minor ? 'lunas' : settled > 0 ? 'sebagian' : recv.status;
  database
    .prepare(`UPDATE receivable SET settled_minor = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(settled, status, at, input.receivable_id);

  writeAudit(
    {
      entity: 'receivable',
      entity_id: input.receivable_id,
      action: 'pelunasan',
      actor: 'ledger',
      before: { settled_minor: recv.settled_minor, status: recv.status },
      after: { settled_minor: settled, status },
    },
    database,
  );
  return Number(res.lastInsertRowid);
}

/**
 * Cocokkan dua sisi transfer antar rekening saya menjadi satu peristiwa transfer internal.
 * Bila hanya satu sisi yang terlihat, peristiwa tetap ada dengan status 'menunggu_pasangan':
 * uang tidak diciptakan dan tidak dihilangkan.
 */
export function matchInternalTransfer(
  cashEventId: number,
  windowDays = 3,
  database: DB = db(),
): { matched: boolean; group_id: string | null; counterpart_id: number | null } {
  const ev = database.prepare(`SELECT * FROM cash_event WHERE id = ?`).get(cashEventId) as
    | CashEventRow
    | undefined;
  if (!ev) throw new LedgerError(`Transaksi ${cashEventId} tidak ditemukan.`);
  if (!['transfer_internal', 'setoran_tabungan', 'penarikan_tabungan'].includes(ev.kind)) {
    return { matched: false, group_id: ev.transfer_group_id, counterpart_id: null };
  }
  if (ev.transfer_group_id) {
    const other = database
      .prepare(`SELECT id FROM cash_event WHERE transfer_group_id = ? AND id <> ?`)
      .get(ev.transfer_group_id, ev.id) as { id: number } | undefined;
    return { matched: !!other, group_id: ev.transfer_group_id, counterpart_id: other?.id ?? null };
  }

  const opposite: CashDirection = ev.direction === 'keluar' ? 'masuk' : 'keluar';
  const candidate = database
    .prepare(
      `SELECT ce.* FROM cash_event ce
         JOIN account a ON a.id = ce.account_id
        WHERE ce.transfer_group_id IS NULL
          AND ce.id <> ?
          AND ce.direction = ?
          AND ce.amount_minor = ?
          AND ce.currency = ?
          AND a.is_mine = 1
          AND (ce.account_id IS NOT ? OR ? IS NULL)
          AND ce.kind IN ('transfer_internal','setoran_tabungan','penarikan_tabungan')
          AND ce.status <> 'dibatalkan'
          AND abs(julianday(ce.occurred_at) - julianday(?)) <= ?
        ORDER BY abs(julianday(ce.occurred_at) - julianday(?)) ASC
        LIMIT 1`,
    )
    .get(
      ev.id,
      opposite,
      ev.amount_minor,
      ev.currency,
      ev.account_id,
      ev.account_id,
      ev.occurred_at,
      windowDays,
      ev.occurred_at,
    ) as CashEventRow | undefined;

  const at = nowIso();
  if (!candidate) {
    database
      .prepare(`UPDATE cash_event SET status = 'menunggu_pasangan', updated_at = ? WHERE id = ?`)
      .run(at, ev.id);
    return { matched: false, group_id: null, counterpart_id: null };
  }

  const groupId = `tf_${crypto.randomUUID()}`;
  database
    .prepare(
      `UPDATE cash_event SET transfer_group_id = ?, status = 'terkonfirmasi', updated_at = ?
        WHERE id IN (?, ?)`,
    )
    .run(groupId, at, ev.id, candidate.id);
  writeAudit(
    {
      entity: 'cash_event',
      entity_id: ev.id,
      action: 'pasangan_transfer_ditemukan',
      actor: 'ledger',
      after: { transfer_group_id: groupId, counterpart_id: candidate.id },
    },
    database,
  );
  return { matched: true, group_id: groupId, counterpart_id: candidate.id };
}

function linkEvidence(database: DB, cashEventId: number, links: EvidenceLink[] | undefined): void {
  if (!links?.length) return;
  const stmt = database.prepare(
    `INSERT OR IGNORE INTO cash_event_evidence (cash_event_id, evidence_id, role) VALUES (?, ?, ?)`,
  );
  for (const l of links) stmt.run(cashEventId, l.evidence_id, l.role);
}

/**
 * Cari catatan manual/Telegram yang kemungkinan adalah uang yang sama dengan bukti bank ini.
 * Syarat ketat supaya dua pembelian bernominal sama tidak salah digabung:
 *  - arah, nominal, mata uang, dan rekening sama (atau catatan manual belum punya rekening)
 *  - selisih paling lama satu hari
 *  - catatan manual itu belum pernah mendapat bukti dari bank/CSV
 */
function cariKembaranManual(
  database: DB,
  input: CashEventInput,
  occurredAt: string,
): CashEventRow[] {
  return database
    .prepare(
      `SELECT ce.* FROM cash_event ce
        WHERE ce.source IN ('manual','telegram')
          AND ce.status <> 'dibatalkan'
          AND ce.direction = ?
          AND ce.amount_minor = ?
          AND ce.currency = ?
          AND (ce.account_id IS ? OR ce.account_id IS NULL)
          AND ce.reference_no IS NULL
          AND abs(julianday(date(ce.occurred_at)) - julianday(date(?))) <= 1
          AND NOT EXISTS (
            SELECT 1 FROM cash_event_evidence cee
             WHERE cee.cash_event_id = ce.id
               AND cee.role IN ('notifikasi_bank','mutasi','kuitansi')
          )
        ORDER BY ce.id`,
    )
    .all(
      input.direction,
      input.amount_minor,
      (input.currency ?? 'IDR').toUpperCase(),
      input.account_id ?? null,
      occurredAt,
    ) as CashEventRow[];
}

/**
 * Catat satu perpindahan uang yang benar-benar terjadi.
 *
 * Idempoten: bila peristiwa yang sama datang lagi dari sumber lain (mis. notifikasi
 * bank lalu kuitansi), buktinya digabung ke peristiwa yang sudah ada dan tidak ada
 * transaksi baru yang dibuat.
 */
export function recordCashEvent(input: CashEventInput, database: DB = db()): RecordResult {
  const pesan: string[] = [];
  if (input.amount_minor <= 0) throw new LedgerError('Nominal transaksi harus lebih dari nol.');

  const occurredAt = toJakartaInstant(input.occurred_at);
  const occurredOn = dateOf(occurredAt);
  const merchantNorm = normalizeMerchant(input.merchant_raw);
  const currency = (input.currency ?? 'IDR').toUpperCase();
  const baseKey = cashDedupeKey({
    reference_no: input.reference_no,
    amount_minor: input.amount_minor,
    direction: input.direction,
    account_id: input.account_id ?? null,
    occurred_at: occurredAt,
    merchant_norm: merchantNorm,
  });

  // Catatan manual/Telegram TANPA nomor referensi: dua kopi Rp25.000 di hari yang sama
  // adalah dua pembelian, bukan duplikat. Hanya kirim-ganda dalam hitungan detik
  // (tombol ditekan dua kali, pesan Telegram terkirim ulang) yang digabung.
  const manualTanpaRef =
    !(input.reference_no && input.reference_no.trim().length >= 4) &&
    (input.source === 'manual' || input.source === 'telegram');
  let dedupeKey = baseKey;

  const run = database.transaction((): RecordResult => {
    let existing: CashEventRow | undefined;
    if (manualTanpaRef) {
      const kandidat = database
        .prepare(
          `SELECT * FROM cash_event
            WHERE (dedupe_key = ? OR dedupe_key LIKE ?) AND source IN ('manual','telegram')`,
        )
        .all(baseKey, `${baseKey}#m%`) as CashEventRow[];
      const sekarang = Date.now();
      existing = kandidat.find(
        (r) =>
          sekarang - Date.parse(r.created_at) < 120_000 &&
          Math.abs(Date.parse(r.occurred_at) - Date.parse(occurredAt)) < 120_000,
      );
      dedupeKey = `${baseKey}#m${crypto.randomUUID().slice(0, 8)}`;
    } else {
      existing = database
        .prepare(`SELECT * FROM cash_event WHERE dedupe_key = ?`)
        .get(baseKey) as CashEventRow | undefined;

      // Bukti dari bank/CSV/PDF untuk uang yang sudah kucatat sendiri secara manual:
      // lengkapi catatan manualnya, jangan buat transaksi kedua.
      if (!existing && input.source !== 'manual' && input.source !== 'telegram') {
        const manual = cariKembaranManual(database, input, occurredAt);
        if (manual.length === 1) {
          const m = manual[0]!;
          database
            .prepare(
              `UPDATE cash_event SET
                 reference_no = COALESCE(reference_no, ?),
                 account_id   = COALESCE(account_id, ?),
                 merchant_raw = COALESCE(merchant_raw, ?),
                 merchant_norm = COALESCE(merchant_norm, ?),
                 dedupe_key = ?,
                 updated_at = ?
               WHERE id = ?`,
            )
            .run(
              input.reference_no ?? null,
              input.account_id ?? null,
              input.merchant_raw ?? null,
              merchantNorm,
              baseKey,
              nowIso(),
              m.id,
            );
          linkEvidence(database, m.id, input.evidence);
          writeAudit(
            {
              entity: 'cash_event',
              entity_id: m.id,
              action: 'dilengkapi_bukti_bank',
              actor: input.actor ?? input.source,
              after: { source: input.source, reference_no: input.reference_no ?? null },
              reason: 'Catatan manual cocok dengan bukti dari bank (nominal, rekening, dan hari sama).',
            },
            database,
          );
          pesan.push('Bukti bank melengkapi catatan manualmu (satu transaksi, bukan dua).');
          return { id: m.id, created: false, merged: true, needs_decision: false, pesan };
        }
        if (manual.length > 1) {
          pesan.push(
            `Ada ${manual.length} catatan manual yang mirip; dibiarkan terpisah agar tidak salah gabung.`,
          );
        }
      }
    }

    if (existing) {
      // Nomor referensi berbeda = dua transaksi berbeda yang kebetulan serupa.
      const refBeda =
        !!input.reference_no &&
        !!existing.reference_no &&
        input.reference_no.trim().toLowerCase() !== existing.reference_no.trim().toLowerCase();

      if (!refBeda) {
        linkEvidence(database, existing.id, input.evidence);
        // Lengkapi data yang sebelumnya kosong, tanpa menimpa yang sudah ada.
        database
          .prepare(
            `UPDATE cash_event SET
               reference_no = COALESCE(reference_no, ?),
               merchant_raw = COALESCE(merchant_raw, ?),
               merchant_norm = COALESCE(merchant_norm, ?),
               counterparty = COALESCE(counterparty, ?),
               service_id   = COALESCE(service_id, ?),
               invoice_id   = COALESCE(invoice_id, ?),
               updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.reference_no ?? null,
            input.merchant_raw ?? null,
            merchantNorm,
            input.counterparty ?? null,
            input.service_id ?? null,
            input.invoice_id ?? null,
            nowIso(),
            existing.id,
          );
        writeAudit(
          {
            entity: 'cash_event',
            entity_id: existing.id,
            action: 'bukti_digabung',
            actor: input.actor ?? input.source,
            after: { source: input.source, evidence: input.evidence ?? [] },
            reason: 'Peristiwa yang sama datang dari sumber lain.',
          },
          database,
        );
        pesan.push('Bukti digabung ke transaksi yang sudah tercatat (tidak ada uang dihitung dua kali).');
        return { id: existing.id, created: false, merged: true, needs_decision: false, pesan };
      }
      pesan.push('Nomor referensi berbeda, jadi ini dicatat sebagai transaksi terpisah.');
    }

    const finalDedupe = existing
      ? `${dedupeKey}#${(input.reference_no ?? crypto.randomUUID()).slice(0, 24)}`
      : dedupeKey;

    const at = nowIso();

    // Merchant kanonik. Kategori bawaan merchant hanya dipakai untuk uang KELUAR yang
    // bukan perpindahan uang sendiri, dan hanya bila pemanggil tidak menentukan kategori.
    const merchant = input.merchant_raw ? resolveMerchant(input.merchant_raw, database) : null;
    const jenisPerpindahan = ['transfer_internal', 'setoran_tabungan', 'penarikan_tabungan'];
    const kategoriFinal =
      input.category_id !== undefined && input.category_id !== null
        ? input.category_id
        : input.direction === 'keluar' && !jenisPerpindahan.includes(input.kind)
          ? (merchant?.default_category_id ?? null)
          : null;

    const res = database
      .prepare(
        `INSERT INTO cash_event
          (occurred_at, direction, amount_minor, currency, account_id, is_cash, kind,
           merchant_raw, merchant_norm, merchant_id, project, counterparty, reference_no, status, certainty,
           transfer_group_id, service_id, invoice_id, category_id, obligation_id, source,
           dedupe_key, note, created_at, updated_at)
         VALUES (@occurred_at, @direction, @amount_minor, @currency, @account_id, @is_cash, @kind,
           @merchant_raw, @merchant_norm, @merchant_id, @project, @counterparty, @reference_no, @status, @certainty,
           NULL, @service_id, @invoice_id, @category_id, @obligation_id, @source,
           @dedupe_key, @note, @at, @at)`,
      )
      .run({
        occurred_at: occurredAt,
        direction: input.direction,
        amount_minor: input.amount_minor,
        currency,
        account_id: input.account_id ?? null,
        is_cash: input.is_cash ? 1 : 0,
        kind: input.kind,
        merchant_raw: input.merchant_raw ?? null,
        merchant_norm: merchantNorm,
        merchant_id: merchant?.id ?? null,
        project: input.project?.trim() || null,
        counterparty: input.counterparty ?? null,
        reference_no: input.reference_no ?? null,
        status: input.status ?? 'terkonfirmasi',
        certainty: input.certainty ?? 'terverifikasi',
        service_id: input.service_id ?? null,
        invoice_id: input.invoice_id ?? null,
        category_id: kategoriFinal,
        obligation_id: input.obligation_id ?? null,
        source: input.source,
        dedupe_key: finalDedupe,
        note: input.note ?? null,
        at,
      });
    const id = Number(res.lastInsertRowid);

    const fallback = defaultAllocations(input.kind, input.amount_minor, kategoriFinal);
    const allocations = input.allocations?.length ? input.allocations : fallback.allocations;
    assertAllocationsBalance(input.amount_minor, allocations);
    insertAllocations(database, id, occurredOn, allocations);
    linkEvidence(database, id, input.evidence);

    if (['transfer_internal', 'setoran_tabungan', 'penarikan_tabungan'].includes(input.kind)) {
      const match = matchInternalTransfer(id, 3, database);
      pesan.push(
        match.matched
          ? 'Dua sisi transfer antar rekening saya berhasil dicocokkan.'
          : 'Sisi pasangan transfer belum terlihat; ditandai menunggu pasangan.',
      );
    }

    if (input.obligation_id) {
      database
        .prepare(
          `UPDATE obligation SET status = 'terealisasi', realized_cash_event_id = ?, updated_at = ?
            WHERE id = ? AND status = 'rencana'`,
        )
        .run(id, at, input.obligation_id);
    }

    if (input.invoice_id) {
      database
        .prepare(
          `INSERT INTO invoice_status_event (invoice_id, status, occurred_at, evidence_id, note, created_at)
           VALUES (?, 'pembayaran_terdeteksi', ?, NULL, ?, ?)`,
        )
        .run(input.invoice_id, occurredAt, 'Transaksi kas ditautkan ke tagihan ini.', at);
    }

    writeAudit(
      {
        entity: 'cash_event',
        entity_id: id,
        action: 'buat',
        actor: input.actor ?? input.source,
        after: { amount_minor: input.amount_minor, kind: input.kind, occurred_at: occurredAt },
      },
      database,
    );

    const needsDecision = !input.allocations?.length && fallback.needsDecision;
    return { id, created: true, merged: false, needs_decision: needsDecision, pesan };
  });

  return run();
}

/** Ganti pembagian biaya sebuah transaksi (mis. "itu makan berempat"). */
export function resplitCashEvent(
  cashEventId: number,
  allocations: AllocationInput[],
  actor = 'telegram',
  database: DB = db(),
): void {
  const run = database.transaction(() => {
    const ev = database.prepare(`SELECT * FROM cash_event WHERE id = ?`).get(cashEventId) as
      | CashEventRow
      | undefined;
    if (!ev) throw new LedgerError(`Transaksi ${cashEventId} tidak ditemukan.`);
    assertAllocationsBalance(ev.amount_minor, allocations);

    const before = database
      .prepare(`SELECT * FROM allocation WHERE cash_event_id = ?`)
      .all(cashEventId);

    // Uang masuk yang sudah dipakai melunasi piutang tidak boleh dibagi ulang:
    // pelunasan yang sama akan terhitung dua kali.
    const sudahMelunasi = database
      .prepare(`SELECT COUNT(*) AS n FROM receivable_settlement WHERE cash_event_id = ?`)
      .get(cashEventId) as { n: number };
    if (sudahMelunasi.n > 0) {
      throw new LedgerError(
        'Transaksi ini sudah dipakai melunasi piutang. Bagi ulang akan melunasi dua kali; ' +
          'buat koreksi terpisah bila perlu.',
      );
    }

    // Piutang yang sudah sebagian lunas tidak boleh hilang tanpa jejak.
    const terlanjurLunas = database
      .prepare(
        `SELECT COUNT(*) AS n FROM receivable r
           JOIN allocation a ON a.id = r.allocation_id
          WHERE a.cash_event_id = ? AND r.settled_minor > 0`,
      )
      .get(cashEventId) as { n: number };
    if (terlanjurLunas.n > 0) {
      throw new LedgerError(
        'Transaksi ini punya piutang yang sudah sebagian dibayar. ' +
          'Perbaiki lewat koreksi terpisah agar pelunasan yang sudah masuk tidak terhapus.',
      );
    }

    database.prepare(`DELETE FROM allocation WHERE cash_event_id = ?`).run(cashEventId);
    insertAllocations(database, cashEventId, dateOf(ev.occurred_at), allocations);
    database
      .prepare(`UPDATE cash_event SET updated_at = ? WHERE id = ?`)
      .run(nowIso(), cashEventId);

    writeAudit(
      {
        entity: 'cash_event',
        entity_id: cashEventId,
        action: 'bagi_biaya_diubah',
        actor,
        before,
        after: allocations,
      },
      database,
    );
  });
  run();
}

/** Tujuan alokasi yang membawa kategori pengeluaran. Transfer dan pemasukan tidak. */
const TUJUAN_BERKATEGORI = [
  'biaya_pribadi',
  'kredit_layanan',
  'piutang_teman',
  'piutang_company',
  'biaya_company_langsung',
  'refund',
];

/**
 * Ubah jenis/kategori/layanan/catatan sebuah transaksi.
 *
 * Kategori disimpan di dua tempat: `cash_event.category_id` (kategori utama) dan
 * `allocation.category_id` (kategori tiap potongan, yang dibaca laporan). Keduanya
 * harus bergerak bersama:
 *  - potongan yang kategorinya SAMA dengan kategori lama transaksi (atau kosong) ikut berganti
 *  - potongan yang sengaja diberi kategori berbeda (transaksi terbagi) TIDAK disentuh
 *
 * `category_id: null` berarti mengosongkan kategori; menghilangkan kuncinya berarti tidak mengubah.
 */
export function recategorize(
  cashEventId: number,
  patch: {
    kind?: CashKind;
    category_id?: number | null;
    service_id?: number | null;
    note?: string | null;
    project?: string | null;
  },
  actor = 'telegram',
  database: DB = db(),
): { alokasi_berubah: number } {
  const run = database.transaction(() => {
    const before = database
      .prepare(`SELECT * FROM cash_event WHERE id = ?`)
      .get(cashEventId) as CashEventRow | undefined;
    if (!before) throw new LedgerError(`Transaksi ${cashEventId} tidak ditemukan.`);

    const ubahKategori = Object.prototype.hasOwnProperty.call(patch, 'category_id');
    const kategoriBaru = ubahKategori ? (patch.category_id ?? null) : before.category_id;

    database
      .prepare(
        `UPDATE cash_event SET
           kind = COALESCE(?, kind),
           category_id = ?,
           service_id = COALESCE(?, service_id),
           note = COALESCE(?, note),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.kind ?? null,
        kategoriBaru,
        patch.service_id ?? null,
        patch.note ?? null,
        nowIso(),
        cashEventId,
      );

    if (patch.project !== undefined) {
      database
        .prepare(`UPDATE cash_event SET project = ?, updated_at = ? WHERE id = ?`)
        .run(patch.project, nowIso(), cashEventId);
    }

    let berubah = 0;
    if (ubahKategori && kategoriBaru !== before.category_id) {
      const placeholders = TUJUAN_BERKATEGORI.map(() => '?').join(',');
      const res = database
        .prepare(
          `UPDATE allocation SET category_id = ?
            WHERE cash_event_id = ?
              AND purpose IN (${placeholders})
              AND (category_id IS NULL OR category_id IS ?)`,
        )
        .run(kategoriBaru, cashEventId, ...TUJUAN_BERKATEGORI, before.category_id);
      berubah = res.changes;
    }

    writeAudit(
      {
        entity: 'cash_event',
        entity_id: cashEventId,
        action: 'kategori_diubah',
        actor,
        before,
        after: { ...patch, alokasi_berubah: berubah },
      },
      database,
    );
    return { alokasi_berubah: berubah };
  });
  return run();
}

/** Ubah kategori satu potongan saja (untuk transaksi terbagi). */
export function setAllocationCategory(
  allocationId: number,
  categoryId: number | null,
  actor = 'web',
  database: DB = db(),
): void {
  const before = database.prepare(`SELECT * FROM allocation WHERE id = ?`).get(allocationId) as
    | { id: number; cash_event_id: number; category_id: number | null; purpose: string }
    | undefined;
  if (!before) throw new LedgerError(`Potongan ${allocationId} tidak ditemukan.`);
  if (!TUJUAN_BERKATEGORI.includes(before.purpose)) {
    throw new LedgerError('Potongan jenis ini tidak memakai kategori pengeluaran.');
  }
  database.prepare(`UPDATE allocation SET category_id = ? WHERE id = ?`).run(categoryId, allocationId);
  writeAudit(
    {
      entity: 'allocation',
      entity_id: allocationId,
      action: 'kategori_potongan_diubah',
      actor,
      before: { category_id: before.category_id },
      after: { category_id: categoryId },
    },
    database,
  );
}

export function getCashEvent(id: number, database: DB = db()): CashEventRow | undefined {
  return database.prepare(`SELECT * FROM cash_event WHERE id = ?`).get(id) as
    | CashEventRow
    | undefined;
}

export function allocationsOf(cashEventId: number, database: DB = db()) {
  return database
    .prepare(
      `SELECT a.*, c.name AS category_name, p.name AS bearer_name
         FROM allocation a
         LEFT JOIN category c ON c.id = a.category_id
         LEFT JOIN person p ON p.id = a.bearer_person_id
        WHERE a.cash_event_id = ? ORDER BY a.id`,
    )
    .all(cashEventId);
}

export function evidenceOf(cashEventId: number, database: DB = db()) {
  return database
    .prepare(
      `SELECT e.id, e.source, e.kind, e.received_at, e.from_email, e.subject, e.permalink, e.confidence, cee.role
         FROM cash_event_evidence cee
         JOIN evidence e ON e.id = cee.evidence_id
        WHERE cee.cash_event_id = ? ORDER BY e.received_at`,
    )
    .all(cashEventId);
}
