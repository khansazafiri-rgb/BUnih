import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { sha256 } from '../util/crypto.js';
import { dateOf, nowIso, today } from '../domain/time.js';
import { formatMoney } from '../domain/money.js';
import { recordCashEvent, normalizeMerchant, type CashEventInput } from '../domain/ledger.js';
import { applyInvoiceStatus } from '../domain/services.js';
import { createDecision } from '../domain/decisions.js';
import { matchCandidates } from '../domain/receivables.js';
import { writeAudit } from '../domain/audit.js';
import { parseMessage } from './parsers/index.js';
import { AMBANG_OTOMATIS, type MailMessage, type ParseResult, type ParsedInvoice, type ParsedStatusChange, type ParsedTransaction } from './types.js';
import type { CashKind } from '../domain/types.js';

export type IngestSummary = {
  evidence_id: number | null;
  evidence_baru: boolean;
  transaksi_dibuat: number;
  transaksi_digabung: number;
  invoice_disentuh: number;
  keputusan_dibuat: number;
  dilewati: string[];
  catatan: string[];
};

const KOSONG: IngestSummary = {
  evidence_id: null,
  evidence_baru: false,
  transaksi_dibuat: 0,
  transaksi_digabung: 0,
  invoice_disentuh: 0,
  keputusan_dibuat: 0,
  dilewati: [],
  catatan: [],
};

function bodyHash(msg: MailMessage): string {
  // Dinormalkan agar email yang sama (misalnya dikirim ulang) menghasilkan hash sama.
  const normal = `${msg.from}\n${msg.subject}\n${msg.text.replace(/\s+/g, ' ').trim()}`;
  return sha256(normal);
}

export function storeEvidence(
  msg: MailMessage,
  result: ParseResult,
  database: DB = db(),
): { id: number; baru: boolean } {
  const hash = bodyHash(msg);
  const existing = database
    .prepare(`SELECT id FROM evidence WHERE source = 'gmail' AND body_hash = ?`)
    .get(hash) as { id: number } | undefined;
  if (existing) return { id: existing.id, baru: false };

  const promo = result.confidence === 0 && (result.catatan ?? []).some((c) => /promosi/i.test(c));
  const res = database
    .prepare(
      `INSERT INTO evidence
        (source, external_id, kind, received_at, from_email, subject, permalink, body_hash,
         parsed_json, parser, confidence, is_promo, needs_review, created_at)
       VALUES ('gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      msg.id,
      result.evidence_kind,
      msg.date,
      msg.from,
      msg.subject,
      msg.permalink ?? `https://mail.google.com/mail/u/0/#all/${msg.id}`,
      hash,
      JSON.stringify(result.items),
      result.parser,
      result.confidence,
      promo ? 1 : 0,
      result.confidence < AMBANG_OTOMATIS ? 1 : 0,
      nowIso(),
    );
  return { id: Number(res.lastInsertRowid), baru: true };
}

type AccountRow = {
  id: number;
  name: string;
  bank: string;
  last4: string | null;
  is_savings_target: number;
  verified: number;
};

function myAccounts(database: DB): AccountRow[] {
  return database
    .prepare(`SELECT id, name, bank, last4, is_savings_target, verified FROM account WHERE is_mine = 1 AND active = 1`)
    .all() as AccountRow[];
}

function resolveAccount(
  bank: string | null | undefined,
  tail: string | null | undefined,
  database: DB,
): AccountRow | null {
  const accounts = myAccounts(database);
  const bankLower = (bank ?? '').toLowerCase();

  if (tail) {
    const byTail = accounts.filter((a) => a.last4 && a.last4 === tail);
    if (byTail.length === 1) return byTail[0]!;
    if (byTail.length > 1 && bankLower) {
      const narrowed = byTail.find((a) => bankLower.includes(a.bank.toLowerCase()));
      if (narrowed) return narrowed;
    }
    // Empat digit terakhir diketahui tetapi tidak cocok dengan rekening mana pun:
    // ini rekening ORANG LAIN. Jangan jatuh kembali ke pencocokan nama bank,
    // karena transfer ke BCA orang lain bukan transfer internal.
    return null;
  }

  if (bankLower) {
    const byBank = accounts.filter((a) => bankLower.includes(a.bank.toLowerCase()));
    // Hanya dipakai bila tidak ambigu dan rekeningnya sudah dikonfirmasi.
    if (byBank.length === 1 && byBank[0]!.verified === 1) return byBank[0]!;
  }
  return null;
}

/**
 * Cari pembayaran sementara (tanpa rekening, status perlu_verifikasi) yang cocok
 * dengan notifikasi bank yang baru masuk, lalu lengkapi alih-alih membuat baru.
 */
function absorbProvisional(
  input: { direction: 'masuk' | 'keluar'; amount_minor: number; occurred_at: string; merchant_norm: string | null; account_id: number | null; reference_no: string | null },
  database: DB,
): number | null {
  if (!input.account_id) return null;
  const row = database
    .prepare(
      `SELECT id, amount_minor, currency FROM cash_event
        WHERE account_id IS NULL
          AND status = 'perlu_verifikasi'
          AND direction = ?
          AND abs(julianday(occurred_at) - julianday(?)) <= 7
          AND (amount_minor = ? OR (merchant_norm IS NOT NULL AND merchant_norm = ?))
        ORDER BY abs(julianday(occurred_at) - julianday(?)) LIMIT 1`,
    )
    .get(
      input.direction,
      input.occurred_at,
      input.amount_minor,
      input.merchant_norm,
      input.occurred_at,
    ) as { id: number; amount_minor: number; currency: string } | undefined;
  if (!row) return null;

  database
    .prepare(
      `UPDATE cash_event SET
         account_id = ?, amount_minor = ?, currency = 'IDR', occurred_at = ?,
         reference_no = COALESCE(?, reference_no), status = 'terkonfirmasi', updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.account_id,
      input.amount_minor,
      input.occurred_at,
      input.reference_no,
      nowIso(),
      row.id,
    );

  // Nominal rupiah aktual untuk tagihan mata uang asing.
  const inv = database
    .prepare(`SELECT invoice_id FROM cash_event WHERE id = ?`)
    .get(row.id) as { invoice_id: number | null } | undefined;
  if (inv?.invoice_id) {
    database
      .prepare(`UPDATE invoice SET amount_idr_actual = ?, updated_at = ? WHERE id = ?`)
      .run(input.amount_minor, nowIso(), inv.invoice_id);
  }

  writeAudit(
    {
      entity: 'cash_event',
      entity_id: row.id,
      action: 'pembayaran_sementara_dilengkapi',
      actor: 'gmail-sync',
      after: { account_id: input.account_id, amount_minor: input.amount_minor },
      reason: 'Notifikasi bank melengkapi pembayaran yang sebelumnya hanya diketahui dari kuitansi.',
    },
    database,
  );
  return row.id;
}

function applyMerchantRule(
  merchantNorm: string | null,
  database: DB,
): { kind: CashKind | null; category_id: number | null; service_id: number | null; auto: boolean } | null {
  if (!merchantNorm) return null;
  const rules = database
    .prepare(`SELECT * FROM merchant_rule ORDER BY length(pattern) DESC`)
    .all() as Array<{
    id: number;
    pattern: string;
    category_id: number | null;
    kind: string | null;
    service_id: number | null;
    auto_approve: number;
  }>;
  for (const r of rules) {
    if (merchantNorm.includes(r.pattern.toLowerCase())) {
      database.prepare(`UPDATE merchant_rule SET hit_count = hit_count + 1 WHERE id = ?`).run(r.id);
      return {
        kind: (r.kind as CashKind | null) ?? null,
        category_id: r.category_id,
        service_id: r.service_id,
        auto: r.auto_approve === 1,
      };
    }
  }
  return null;
}

function ingestTransaction(
  msg: MailMessage,
  result: ParseResult,
  tx: ParsedTransaction,
  evidenceId: number,
  summary: IngestSummary,
  database: DB,
): void {
  const accounts = myAccounts(database);
  const sumberAkun = resolveAccount(tx.source_bank, tx.source_account_tail, database);
  const tujuanKandidat = resolveAccount(tx.dest_bank, tx.dest_account_tail, database);
  // Rekening tujuan yang sama dengan rekening sumber bukan transfer: itu pembacaan yang keliru.
  const tujuanAkun = tujuanKandidat && sumberAkun && tujuanKandidat.id === sumberAkun.id ? null : tujuanKandidat;
  const merchantNorm = normalizeMerchant(tx.merchant ?? tx.counterparty ?? null);
  const rule = applyMerchantRule(merchantNorm, database);

  let kind: CashKind = rule?.kind ?? tx.kind;
  let catatanTambahan: string[] = [];

  // Transfer ke rekening saya sendiri = transfer internal / setoran tabungan.
  // Transfer ke rekening BCA orang lain tetap transaksi biasa.
  if (tx.direction === 'keluar' && tujuanAkun) {
    kind = tujuanAkun.is_savings_target === 1 ? 'setoran_tabungan' : 'transfer_internal';
    catatanTambahan.push(
      `Tujuan cocok dengan rekening saya (${tujuanAkun.name}), jadi dicatat sebagai ` +
        `${kind === 'setoran_tabungan' ? 'setoran tabungan' : 'transfer antar rekening saya'}.`,
    );
  } else if (tx.direction === 'keluar' && tx.dest_bank && !tujuanAkun) {
    const bankSaya = accounts.some((a) =>
      (tx.dest_bank ?? '').toLowerCase().includes(a.bank.toLowerCase()),
    );
    if (bankSaya) {
      catatanTambahan.push(
        `Tujuan di bank yang sama dengan rekening saya tetapi 4 digitnya tidak cocok, ` +
          'jadi diperlakukan sebagai transfer ke orang lain.',
      );
    }
  }
  if (tx.direction === 'masuk' && sumberAkun && tujuanAkun) {
    kind = 'transfer_internal';
  }

  const input: CashEventInput = {
    occurred_at: tx.occurred_at,
    direction: tx.direction,
    amount_minor: tx.amount_minor,
    currency: tx.currency,
    account_id: sumberAkun?.id ?? tujuanAkun?.id ?? null,
    kind,
    merchant_raw: tx.merchant ?? null,
    counterparty: tx.counterparty ?? tx.dest_name ?? null,
    reference_no: tx.reference_no ?? null,
    status: result.confidence >= AMBANG_OTOMATIS ? 'terkonfirmasi' : 'perlu_verifikasi',
    certainty: 'terverifikasi',
    service_id: rule?.service_id ?? null,
    category_id: rule?.category_id ?? null,
    source: 'gmail',
    note: [tx.note, ...catatanTambahan].filter(Boolean).join(' ') || null,
    evidence: [{ evidence_id: evidenceId, role: 'notifikasi_bank' }],
    actor: 'gmail-sync',
  };

  // Lengkapi pembayaran sementara bila ada, agar kuitansi + notifikasi bank
  // tidak menjadi dua transaksi.
  const absorbed = absorbProvisional(
    {
      direction: tx.direction,
      amount_minor: tx.amount_minor,
      occurred_at: tx.occurred_at,
      merchant_norm: merchantNorm,
      account_id: input.account_id ?? null,
      reference_no: tx.reference_no ?? null,
    },
    database,
  );
  if (absorbed !== null) {
    database
      .prepare(
        `INSERT OR IGNORE INTO cash_event_evidence (cash_event_id, evidence_id, role) VALUES (?, ?, 'notifikasi_bank')`,
      )
      .run(absorbed, evidenceId);
    summary.transaksi_digabung += 1;
    summary.catatan.push(
      'Notifikasi bank melengkapi pembayaran yang sebelumnya hanya diketahui dari kuitansi.',
    );
    return;
  }

  const res = recordCashEvent(input, database);
  if (res.created) summary.transaksi_dibuat += 1;
  else summary.transaksi_digabung += 1;
  summary.catatan.push(...res.pesan);

  if (!res.created) return;

  // Setiap transaksi bank baru yang valid mendapat SATU notifikasi Telegram yang dapat ditindaklanjuti
  // (kategori disarankan bila sudah dikenali). Pengecualian: perpindahan uang yang sudah dikenali
  // sebagai transfer/tabungan sendiri, dan uang masuk yang cocok dengan piutang (pertanyaan pelunasan
  // di bawah sudah menjadi notifikasinya, supaya tidak ada dua pesan untuk satu transaksi).
  const gerakanInternal = ['transfer_internal', 'setoran_tabungan', 'penarikan_tabungan'].includes(kind);
  const kandidatPiutang =
    tx.direction === 'masuk' ? matchCandidates(tx.amount_minor, { toleransi: 1000 }, database) : [];
  const perluTanya = !gerakanInternal && kandidatPiutang.length === 0;

  if (perluTanya) {
    const opsi = [
      { id: 'benar', label: 'Benar' },
      { id: 'ganti_kategori', label: 'Ganti kategori' },
      { id: 'bagi_biaya', label: 'Bagi biaya' },
      { id: 'reimburse', label: 'Reimburse' },
      { id: 'transfer_sendiri', label: 'Transfer sendiri' },
      { id: 'hadiah', label: 'Hadiah' },
      { id: 'lainnya', label: 'Lainnya' },
    ];
    const dibuat = createDecision(
      {
        kind: 'kategori_transaksi',
        cash_event_id: res.id,
        question:
          `${formatMoney(tx.amount_minor, tx.currency)} ${tx.direction === 'keluar' ? 'keluar' : 'masuk'}` +
          ` di ${sumberAkun?.name ?? 'rekening belum diketahui'}` +
          `${tx.merchant ? ` ke ${tx.merchant}` : ''}. Kategorinya benar?`,
        options: opsi,
        dedupe_key: `kategori:${res.id}`,
        priority: tx.amount_minor >= 500_000 ? 2 : 4,
      },
      database,
    );
    if (dibuat) summary.keputusan_dibuat += 1;
  }

  // Uang masuk yang mungkin pelunasan piutang.
  if (tx.direction === 'masuk') {
    const kandidat = kandidatPiutang;
    if (kandidat.length) {
      const dibuat = createDecision(
        {
          kind: 'reimburse',
          cash_event_id: res.id,
          question:
            `Uang masuk ${formatMoney(tx.amount_minor, tx.currency)}. Ini pelunasan piutang dari ` +
            `${kandidat.map((k) => k.debtor_name ?? k.debtor_type).join(' / ')}?`,
          options: [
            ...kandidat.map((k) => ({
              id: `piutang_${k.id}`,
              label: `Ya, dari ${k.debtor_name ?? k.debtor_type} (sisa ${formatMoney(k.sisa_minor)})`,
              payload: { receivable_id: k.id, sisa_minor: k.sisa_minor },
            })),
            { id: 'bukan', label: 'Bukan, ini pemasukan biasa' },
            { id: 'topup', label: 'Ini top-up' },
          ],
          dedupe_key: `reimburse:${res.id}`,
          priority: 3,
        },
        database,
      );
      if (dibuat) summary.keputusan_dibuat += 1;
    }
  }
}

function resolveServiceId(
  parsed: { service_slug?: string | null; vendor: string },
  database: DB,
): { id: number | null; ambigu: boolean; kandidat: Array<{ id: number; name: string }> } {
  if (parsed.service_slug) {
    const row = database.prepare(`SELECT id FROM service WHERE slug = ?`).get(parsed.service_slug) as
      | { id: number }
      | undefined;
    if (row) return { id: row.id, ambigu: false, kandidat: [] };
  }
  const byVendor = database
    .prepare(`SELECT id, name FROM service WHERE lower(vendor) = lower(?)`)
    .all(parsed.vendor) as Array<{ id: number; name: string }>;
  if (byVendor.length === 1) return { id: byVendor[0]!.id, ambigu: false, kandidat: byVendor };
  return { id: null, ambigu: byVendor.length > 1, kandidat: byVendor };
}

function upsertInvoice(
  parsed: ParsedInvoice,
  evidenceId: number,
  summary: IngestSummary,
  database: DB,
): number | null {
  const svc = resolveServiceId(parsed, database);
  const kunci = [
    'gmail',
    parsed.vendor.toLowerCase().replace(/\s+/g, '-'),
    parsed.invoice_no ?? parsed.due_date ?? parsed.period_start ?? 'tanpa-nomor',
    parsed.amount_minor ?? 'tanpa-nominal',
    parsed.currency,
  ].join(':');

  const at = nowIso();
  const existing = database
    .prepare(`SELECT id, status FROM invoice WHERE dedupe_key = ?`)
    .get(kunci) as { id: number; status: string } | undefined;

  let invoiceId: number;
  if (existing) {
    invoiceId = existing.id;
    database
      .prepare(
        `UPDATE invoice SET
           service_id = COALESCE(service_id, ?),
           invoice_no = COALESCE(invoice_no, ?),
           issued_at  = COALESCE(issued_at, ?),
           due_date   = COALESCE(due_date, ?),
           period_start = COALESCE(period_start, ?),
           period_end   = COALESCE(period_end, ?),
           amount_minor = COALESCE(amount_minor, ?),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        svc.id,
        parsed.invoice_no,
        parsed.issued_at,
        parsed.due_date,
        parsed.period_start,
        parsed.period_end,
        parsed.amount_minor,
        at,
        invoiceId,
      );
  } else {
    const res = database
      .prepare(
        `INSERT INTO invoice
          (service_id, invoice_no, issued_at, due_date, period_start, period_end, amount_minor,
           currency, amount_idr_actual, status, paid_by, reimbursable, dedupe_key, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'belum_jelas', 0, ?, ?, ?, ?)`,
      )
      .run(
        svc.id,
        parsed.invoice_no,
        parsed.issued_at,
        parsed.due_date,
        parsed.period_start,
        parsed.period_end,
        parsed.amount_minor,
        parsed.currency,
        parsed.status,
        kunci,
        parsed.note ?? null,
        at,
        at,
      );
    invoiceId = Number(res.lastInsertRowid);
  }

  database
    .prepare(
      `INSERT OR IGNORE INTO invoice_evidence (invoice_id, evidence_id, role) VALUES (?, ?, ?)`,
    )
    .run(invoiceId, evidenceId, parsed.status === 'lunas_terkonfirmasi' ? 'kuitansi' : 'invoice');

  summary.invoice_disentuh += 1;

  if (svc.ambigu) {
    const dibuat = createDecision(
      {
        kind: 'verifikasi_langganan',
        invoice_id: invoiceId,
        question:
          `Tagihan ${parsed.vendor} ${formatMoney(parsed.amount_minor, parsed.currency)} ` +
          'cocok dengan lebih dari satu layanan. Ini layanan mana?',
        options: svc.kandidat.map((k) => ({
          id: `service_${k.id}`,
          label: k.name,
          payload: { service_id: k.id },
        })),
        dedupe_key: `layanan-invoice:${invoiceId}`,
        priority: 3,
      },
      database,
    );
    if (dibuat) summary.keputusan_dibuat += 1;
  }

  return invoiceId;
}

/**
 * Tautkan kuitansi ke pembayaran yang sudah tercatat dari notifikasi bank.
 * Bila tidak ada yang cocok, buat pembayaran sementara tanpa rekening dan
 * minta konfirmasi — bukan menebak rekening.
 */
function linkReceiptToPayment(
  parsed: ParsedStatusChange,
  invoiceId: number | null,
  evidenceId: number,
  summary: IngestSummary,
  database: DB,
): void {
  const amount = parsed.amount_minor;
  const currency = (parsed.currency ?? 'IDR').toUpperCase();
  const vendorNorm = normalizeMerchant(parsed.vendor);
  const svc = resolveServiceId(parsed as { vendor: string; service_slug?: string | null }, database);

  const kondisi: string[] = [
    `ce.direction = 'keluar'`,
    `ce.status <> 'dibatalkan'`,
    `abs(julianday(ce.occurred_at) - julianday(@pada)) <= 7`,
    `ce.account_id IS NOT NULL`,
  ];
  if (currency === 'IDR' && amount) kondisi.push(`ce.amount_minor = @nominal`);
  else kondisi.push(`(ce.service_id = @service OR ce.merchant_norm LIKE @merchant)`);

  const kandidat = database
    .prepare(
      `SELECT ce.id, ce.amount_minor, ce.invoice_id FROM cash_event ce
        WHERE ${kondisi.join(' AND ')}
        ORDER BY abs(julianday(ce.occurred_at) - julianday(@pada)) LIMIT 3`,
    )
    .all({
      pada: parsed.occurred_at,
      nominal: amount ?? 0,
      service: svc.id ?? -1,
      merchant: `%${vendorNorm ?? 'tidak-ada'}%`,
    }) as Array<{ id: number; amount_minor: number; invoice_id: number | null }>;

  if (kandidat.length) {
    const pilih = kandidat[0]!;
    database
      .prepare(
        `UPDATE cash_event SET invoice_id = COALESCE(invoice_id, ?), service_id = COALESCE(service_id, ?),
           kind = CASE WHEN kind IN ('belum_dikategorikan') THEN 'bayar_langganan' ELSE kind END,
           updated_at = ? WHERE id = ?`,
      )
      .run(invoiceId, svc.id, nowIso(), pilih.id);
    database
      .prepare(
        `INSERT OR IGNORE INTO cash_event_evidence (cash_event_id, evidence_id, role) VALUES (?, ?, 'kuitansi')`,
      )
      .run(pilih.id, evidenceId);
    if (invoiceId && currency !== 'IDR') {
      database
        .prepare(`UPDATE invoice SET amount_idr_actual = ?, updated_at = ? WHERE id = ?`)
        .run(pilih.amount_minor, nowIso(), invoiceId);
    }
    summary.transaksi_digabung += 1;
    summary.catatan.push(
      'Kuitansi ditautkan ke pembayaran yang sudah tercatat dari notifikasi bank (satu peristiwa, dua bukti).',
    );
    if (kandidat.length > 1) {
      const dibuat = createDecision(
        {
          kind: 'konfirmasi_kuitansi',
          cash_event_id: pilih.id,
          invoice_id: invoiceId,
          question:
            `Kuitansi ${parsed.vendor} ${formatMoney(amount, currency)} cocok dengan ` +
            `${kandidat.length} transaksi. Sudah benar yang dipilih?`,
          options: kandidat.map((k) => ({
            id: `tx_${k.id}`,
            label: `Transaksi #${k.id} (${formatMoney(k.amount_minor)})`,
            payload: { cash_event_id: k.id },
          })),
          dedupe_key: `kuitansi-ambigu:${invoiceId ?? 'na'}:${pilih.id}`,
          priority: 3,
        },
        database,
      );
      if (dibuat) summary.keputusan_dibuat += 1;
    }
    return;
  }

  // Tidak ada notifikasi bank yang cocok: catat sebagai pembayaran sementara
  // tanpa rekening. Tidak memengaruhi saldo rekening mana pun sampai dikonfirmasi.
  if (!amount) {
    summary.dilewati.push(
      'Kuitansi tanpa nominal dan tanpa pembayaran yang cocok — tidak ada transaksi dibuat.',
    );
    return;
  }

  const res = recordCashEvent(
    {
      occurred_at: parsed.occurred_at,
      direction: 'keluar',
      amount_minor: amount,
      currency,
      account_id: null,
      kind: 'bayar_langganan',
      merchant_raw: parsed.vendor,
      reference_no: parsed.invoice_no ?? null,
      status: 'perlu_verifikasi',
      certainty: 'terverifikasi',
      service_id: svc.id,
      invoice_id: invoiceId,
      source: 'gmail',
      note:
        'Pembayaran diketahui dari kuitansi, tetapi belum ada notifikasi bank yang cocok. ' +
        'Rekening pendebitan belum diketahui, jadi belum memotong saldo rekening mana pun.',
      evidence: [{ evidence_id: evidenceId, role: 'kuitansi' }],
      actor: 'gmail-sync',
    },
    database,
  );
  if (res.created) summary.transaksi_dibuat += 1;

  const dibuat = createDecision(
    {
      kind: 'konfirmasi_kuitansi',
      cash_event_id: res.id,
      invoice_id: invoiceId,
      question:
        `Kuitansi ${parsed.vendor} ${formatMoney(amount, currency)} terdeteksi, tetapi belum ada ` +
        'notifikasi bank yang cocok. Rekening mana yang terdebit?',
      options: myAccounts(database).map((a) => ({
        id: `akun_${a.id}`,
        label: a.last4 ? `${a.name} ••${a.last4}` : a.name,
        payload: { account_id: a.id },
      })),
      dedupe_key: `kuitansi-tanpa-bank:${res.id}`,
      priority: 2,
    },
    database,
  );
  if (dibuat) summary.keputusan_dibuat += 1;
}

/** Tulis hasil parse ke database dengan aman untuk diproses ulang. */
export function ingestParsed(
  msg: MailMessage,
  result: ParseResult,
  database: DB = db(),
): IngestSummary {
  const summary: IngestSummary = { ...KOSONG, dilewati: [], catatan: [] };

  const ev = storeEvidence(msg, result, database);
  summary.evidence_id = ev.id;
  summary.evidence_baru = ev.baru;

  if (!ev.baru) {
    summary.dilewati.push('Email ini sudah pernah diproses (bukti sama).');
    return summary;
  }
  if (result.confidence === 0 || result.items.length === 0) {
    summary.dilewati.push(...(result.catatan ?? ['Tidak ada data keuangan yang dapat diambil.']));
    return summary;
  }

  const run = database.transaction(() => {
    let invoiceId: number | null = null;

    for (const item of result.items) {
      if (item.tipe === 'invoice') {
        invoiceId = upsertInvoice(item, ev.id, summary, database);
        if (invoiceId) {
          applyInvoiceStatus(
            {
              invoice_id: invoiceId,
              status: item.status,
              occurred_at: item.issued_at ? `${item.issued_at}T00:00:00+07:00` : msg.date,
              evidence_id: ev.id,
              note: item.note ?? null,
              actor: 'gmail-sync',
            },
            database,
          );
        }
      }
    }

    for (const item of result.items) {
      if (item.tipe === 'transaksi') {
        ingestTransaction(msg, result, item, ev.id, summary, database);
      } else if (item.tipe === 'status_tagihan') {
        if (invoiceId) {
          applyInvoiceStatus(
            {
              invoice_id: invoiceId,
              status: item.status,
              occurred_at: item.occurred_at,
              evidence_id: ev.id,
              note: item.note ?? null,
              actor: 'gmail-sync',
            },
            database,
          );
        }
        if (item.status === 'lunas_terkonfirmasi') {
          linkReceiptToPayment(item, invoiceId, ev.id, summary, database);
        }
        if (item.status === 'gagal_bayar') {
          const dibuat = createDecision(
            {
              kind: 'verifikasi_langganan',
              invoice_id: invoiceId,
              question:
                `${item.vendor}: terdeteksi gagal bayar pada ${dateOf(item.occurred_at)}. ` +
                'Sudah dibayar ulang, atau layanan dihentikan?',
              options: [
                { id: 'sudah_dibayar', label: 'Sudah dibayar ulang' },
                { id: 'belum', label: 'Belum dibayar' },
                { id: 'dihentikan', label: 'Layanan dihentikan' },
              ],
              dedupe_key: `gagal-bayar:${item.vendor}:${dateOf(item.occurred_at)}`,
              priority: 1,
            },
            database,
          );
          if (dibuat) summary.keputusan_dibuat += 1;
        }
      } else if (item.tipe === 'saldo_disebut') {
        // Saldo dari email TIDAK otomatis menjadi saldo bank.
        const dibuat = createDecision(
          {
            kind: 'asumsi_awal',
            question:
              `Email menyebut saldo ${formatMoney(item.balance_minor, item.currency)} per ` +
              `${dateOf(item.as_of)}. Pakai sebagai saldo terkonfirmasi (rekonsiliasi)?`,
            options: [
              { id: 'pakai', label: 'Ya, pakai sebagai saldo terkonfirmasi', payload: { ...item } },
              { id: 'abaikan', label: 'Abaikan' },
            ],
            dedupe_key: `saldo-email:${dateOf(item.as_of)}:${item.balance_minor}`,
            priority: 4,
          },
          database,
        );
        if (dibuat) summary.keputusan_dibuat += 1;
      }
    }
  });
  run();

  return summary;
}

export function ingestMessage(msg: MailMessage, database: DB = db()): IngestSummary {
  const result = parseMessage(msg);
  if (!result) {
    return {
      ...KOSONG,
      dilewati: ['Tidak ada parser yang mengenali email ini.'],
      catatan: [],
    };
  }
  return ingestParsed(msg, result, database);
}

export const _internal = { resolveAccount, absorbProvisional, bodyHash, today };
