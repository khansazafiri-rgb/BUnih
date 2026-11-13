import { google, type gmail_v1 } from 'googleapis';
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso, today, addDays, type IsoDate } from '../domain/time.js';
import { redact } from '../util/crypto.js';
import { getGmailClient } from './oauth.js';
import { ingestMessage } from './ingest.js';
import { stripHtml } from './parsers/helpers.js';
import { VENDOR_PROFILES } from './parsers/vendors.js';
import type { MailMessage } from './types.js';

export type SyncResult = {
  mode: 'historis' | 'berkelanjutan';
  dari: string | null;
  sampai: string | null;
  email_dilihat: number;
  email_diproses: number;
  transaksi_dibuat: number;
  transaksi_digabung: number;
  invoice_disentuh: number;
  keputusan_dibuat: number;
  dilewati: number;
  history_id: string | null;
  catatan: string[];
  error: string | null;
};

const DOMAIN_KEUANGAN = [
  'bankmandiri.co.id',
  'mandiri.co.id',
  'bca.co.id',
  'klikbca.com',
  ...new Set(
    VENDOR_PROFILES.flatMap((v) =>
      v.senders
        .map((s) => s.source.replace(/^@|\$$/g, '').replace(/\\\./g, '.'))
        .filter((s) => /^[a-z0-9.-]+$/i.test(s)),
    ),
  ),
];

const KATA_SUBJEK = [
  'invoice', 'tagihan', 'receipt', 'kuitansi', 'pembayaran', 'payment',
  '"jatuh tempo"', '"due date"', 'refund', 'notifikasi', 'transaksi', 'billing',
];

/** Kueri bawaan: batasi ke pengirim keuangan dan subjek yang relevan. */
export function defaultQuery(): string {
  const from = `from:(${DOMAIN_KEUANGAN.join(' OR ')})`;
  const subject = `subject:(${KATA_SUBJEK.join(' OR ')})`;
  return `(${from}) OR (${subject})`;
}

function headerMap(headers: gmail_v1.Schema$MessagePartHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (h.name) out[h.name.toLowerCase()] = h.value ?? '';
  }
  return out;
}

function decodeBody(data: string | null | undefined): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

function collectText(part: gmail_v1.Schema$MessagePart | undefined, acc: { plain: string[]; html: string[] }): void {
  if (!part) return;
  const mime = part.mimeType ?? '';
  if (mime === 'text/plain') acc.plain.push(decodeBody(part.body?.data));
  else if (mime === 'text/html') acc.html.push(decodeBody(part.body?.data));
  for (const sub of part.parts ?? []) collectText(sub, acc);
}

export function toMailMessage(msg: gmail_v1.Schema$Message): MailMessage {
  const headers = headerMap(msg.payload?.headers);
  const acc = { plain: [] as string[], html: [] as string[] };
  collectText(msg.payload, acc);
  const text = acc.plain.length
    ? acc.plain.join('\n\n')
    : acc.html.length
      ? stripHtml(acc.html.join('\n\n'))
      : (msg.snippet ?? '');

  const fromRaw = headers['from'] ?? '';
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  const from = (emailMatch?.[1] ?? fromRaw).trim().toLowerCase();
  const fromName = emailMatch ? fromRaw.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '') : undefined;

  const internalDate = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined;

  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? undefined,
    from,
    fromName,
    to: headers['to'],
    subject: headers['subject'] ?? '',
    date: internalDate ?? headers['date'] ?? new Date().toISOString(),
    text,
    headers,
    permalink: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
    labelIds: msg.labelIds ?? [],
  };
}

function emptyResult(mode: SyncResult['mode']): SyncResult {
  return {
    mode,
    dari: null,
    sampai: null,
    email_dilihat: 0,
    email_diproses: 0,
    transaksi_dibuat: 0,
    transaksi_digabung: 0,
    invoice_disentuh: 0,
    keputusan_dibuat: 0,
    dilewati: 0,
    history_id: null,
    catatan: [],
    error: null,
  };
}

async function processIds(
  gmail: gmail_v1.Gmail,
  ids: string[],
  result: SyncResult,
  database: DB,
): Promise<void> {
  for (const id of ids) {
    result.email_dilihat += 1;
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const mail = toMailMessage(full.data);
      const summary = ingestMessage(mail, database);
      result.email_diproses += 1;
      result.transaksi_dibuat += summary.transaksi_dibuat;
      result.transaksi_digabung += summary.transaksi_digabung;
      result.invoice_disentuh += summary.invoice_disentuh;
      result.keputusan_dibuat += summary.keputusan_dibuat;
      if (summary.dilewati.length) result.dilewati += 1;
    } catch (err) {
      // Log tanpa membocorkan isi email.
      result.catatan.push(`Gagal memproses satu email: ${redact((err as Error).message)}`);
    }
  }
}

function gmailDate(d: IsoDate): string {
  return d.replace(/-/g, '/');
}

/**
 * Sinkronisasi historis dengan rentang tanggal yang dipilih pengguna.
 * Aman dijalankan berulang: bukti yang sama tidak diproses dua kali.
 */
export async function syncHistorical(
  opts: { dari: IsoDate; sampai?: IsoDate; query?: string; maxEmail?: number },
  database: DB = db(),
): Promise<SyncResult> {
  const result = emptyResult('historis');
  const sampai = opts.sampai ?? today();
  result.dari = opts.dari;
  result.sampai = sampai;
  const maxEmail = opts.maxEmail ?? 2000;

  const runId = database
    .prepare(
      `INSERT INTO import_run (source, label, started_at, status) VALUES ('gmail', ?, ?, 'jalan')`,
    )
    .run(`Historis ${opts.dari} s/d ${sampai}`, nowIso()).lastInsertRowid;

  try {
    const auth = await getGmailClient(database);
    const gmail = google.gmail({ version: 'v1', auth });
    const q = `(${opts.query ?? defaultQuery()}) after:${gmailDate(opts.dari)} before:${gmailDate(addDays(sampai, 1))}`;

    let pageToken: string | undefined;
    const ids: string[] = [];
    do {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q,
        maxResults: 100,
        pageToken,
      });
      for (const m of list.data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken && ids.length < maxEmail);

    if (ids.length >= maxEmail) {
      result.catatan.push(
        `Dibatasi ${maxEmail} email per jalan. Jalankan lagi dengan rentang lebih sempit untuk sisanya.`,
      );
    }

    await processIds(gmail, ids.slice(0, maxEmail), result, database);

    const profile = await gmail.users.getProfile({ userId: 'me' });
    result.history_id = profile.data.historyId ?? null;

    database
      .prepare(
        `UPDATE gmail_state SET history_id = ?, last_full_sync_at = ?, last_sync_at = ?,
           initial_range_start = COALESCE(initial_range_start, ?), initial_done = 1,
           last_error = NULL, updated_at = ? WHERE id = 1`,
      )
      .run(result.history_id, nowIso(), nowIso(), opts.dari, nowIso());
  } catch (err) {
    result.error = redact((err as Error).message);
    database
      .prepare(`UPDATE gmail_state SET last_error = ?, updated_at = ? WHERE id = 1`)
      .run(result.error, nowIso());
  }

  database
    .prepare(
      `UPDATE import_run SET finished_at = ?, status = ?, stats_json = ?, error = ? WHERE id = ?`,
    )
    .run(
      nowIso(),
      result.error ? 'gagal' : 'selesai',
      JSON.stringify(result),
      result.error,
      runId,
    );
  return result;
}

/**
 * Sinkronisasi berkelanjutan memakai historyId.
 * Bila historyId sudah terlalu tua (Google membalas 404), sistem jatuh kembali
 * ke pencarian beberapa hari terakhir — tidak ada email yang terlewat diam-diam.
 */
export async function syncIncremental(
  opts: { fallbackHari?: number } = {},
  database: DB = db(),
): Promise<SyncResult> {
  const result = emptyResult('berkelanjutan');
  const state = database.prepare(`SELECT * FROM gmail_state WHERE id = 1`).get() as
    | { history_id: string | null; initial_done: number }
    | undefined;

  try {
    const auth = await getGmailClient(database);
    const gmail = google.gmail({ version: 'v1', auth });

    if (!state?.history_id) {
      const hari = opts.fallbackHari ?? 7;
      result.catatan.push(
        `Belum ada titik riwayat Gmail, jadi memeriksa ${hari} hari terakhir.`,
      );
      const fallback = await syncHistorical(
        { dari: addDays(today(), -hari), sampai: today() },
        database,
      );
      return { ...fallback, mode: 'berkelanjutan', catatan: [...result.catatan, ...fallback.catatan] };
    }

    const ids = new Set<string>();
    let pageToken: string | undefined;
    let newHistoryId: string | null = state.history_id;

    try {
      do {
        const hist = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: state.history_id,
          historyTypes: ['messageAdded'],
          maxResults: 500,
          pageToken,
        });
        for (const h of hist.data.history ?? []) {
          for (const added of h.messagesAdded ?? []) {
            if (added.message?.id) ids.add(added.message.id);
          }
        }
        newHistoryId = hist.data.historyId ?? newHistoryId;
        pageToken = hist.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err) {
      const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
      if (status === 404) {
        const hari = opts.fallbackHari ?? 7;
        result.catatan.push(
          `Titik riwayat Gmail sudah kedaluwarsa, jadi memeriksa ${hari} hari terakhir agar tidak ada yang terlewat.`,
        );
        const fallback = await syncHistorical(
          { dari: addDays(today(), -hari), sampai: today() },
          database,
        );
        return { ...fallback, mode: 'berkelanjutan', catatan: [...result.catatan, ...fallback.catatan] };
      }
      throw err;
    }

    await processIds(gmail, [...ids], result, database);
    result.history_id = newHistoryId;

    database
      .prepare(
        `UPDATE gmail_state SET history_id = ?, last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = 1`,
      )
      .run(newHistoryId, nowIso(), nowIso());
  } catch (err) {
    result.error = redact((err as Error).message);
    database
      .prepare(`UPDATE gmail_state SET last_error = ?, updated_at = ? WHERE id = 1`)
      .run(result.error, nowIso());
  }
  return result;
}

export function syncState(database: DB = db()) {
  const row = database.prepare(`SELECT * FROM gmail_state WHERE id = 1`).get() as
    | Record<string, unknown>
    | undefined;
  const jumlahBukti = database
    .prepare(`SELECT COUNT(*) AS n FROM evidence WHERE source = 'gmail'`)
    .get() as { n: number };
  const perluReview = database
    .prepare(`SELECT COUNT(*) AS n FROM evidence WHERE source = 'gmail' AND needs_review = 1`)
    .get() as { n: number };
  return {
    history_id: (row?.['history_id'] as string | null) ?? null,
    sinkron_penuh_terakhir: (row?.['last_full_sync_at'] as string | null) ?? null,
    sinkron_terakhir: (row?.['last_sync_at'] as string | null) ?? null,
    error_terakhir: (row?.['last_error'] as string | null) ?? null,
    rentang_awal: (row?.['initial_range_start'] as string | null) ?? null,
    sinkron_awal_selesai: Number(row?.['initial_done'] ?? 0) === 1,
    jumlah_bukti: jumlahBukti.n,
    bukti_perlu_review: perluReview.n,
  };
}
