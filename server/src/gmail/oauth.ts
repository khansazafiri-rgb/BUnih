import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { decryptJson, encryptJson } from '../util/crypto.js';
import { nowIso } from '../domain/time.js';
import { writeAudit } from '../domain/audit.js';

/**
 * Izin minimum: hanya membaca email. Aplikasi ini tidak pernah mengirim,
 * menghapus, atau mengubah email, dan tidak pernah meminta kata sandi Gmail.
 *
 * Catatan: akses Gmail yang mungkin dimiliki percakapan AI lain TIDAK otomatis
 * tersedia di sini. Penyambungan harus dilakukan sekali lewat halaman Pengaturan.
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

export type StoredToken = {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
};

export function oauthConfigured(): boolean {
  return Boolean(
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && redirectUri(),
  );
}

export function redirectUri(): string {
  return config.GOOGLE_REDIRECT_URI || `${config.BUNIH_BASE_URL}/api/gmail/callback`;
}

function baseClient(): OAuth2Client {
  if (!oauthConfigured()) {
    throw new Error(
      'Google OAuth belum dikonfigurasi. Isi GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, dan ' +
        'GOOGLE_REDIRECT_URI di .env (lihat docs/06-deploy-tencent.md).',
    );
  }
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    redirectUri(),
  );
}

export function authUrl(state: string): string {
  return baseClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    include_granted_scopes: false,
    state,
  });
}

export async function exchangeCode(code: string, database: DB = db()): Promise<string | null> {
  const client = baseClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  let email: string | null = null;
  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    email = profile.data.emailAddress ?? null;
  } catch {
    email = null;
  }

  const at = nowIso();
  const existing = database
    .prepare(`SELECT payload_enc FROM oauth_token WHERE provider = 'google'`)
    .get() as { payload_enc: string } | undefined;

  // Google hanya mengirim refresh_token pada persetujuan pertama.
  let refresh = tokens.refresh_token ?? undefined;
  if (!refresh && existing) {
    try {
      refresh = decryptJson<StoredToken>(existing.payload_enc).refresh_token;
    } catch {
      refresh = undefined;
    }
  }

  const payload: StoredToken = {
    access_token: tokens.access_token ?? undefined,
    refresh_token: refresh,
    expiry_date: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? GMAIL_SCOPES.join(' '),
    token_type: tokens.token_type ?? 'Bearer',
  };

  database
    .prepare(
      `INSERT INTO oauth_token (provider, account_email, scopes, payload_enc, created_at, updated_at)
       VALUES ('google', ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         account_email = excluded.account_email,
         scopes = excluded.scopes,
         payload_enc = excluded.payload_enc,
         updated_at = excluded.updated_at`,
    )
    .run(email, GMAIL_SCOPES.join(' '), encryptJson(payload), at, at);

  writeAudit(
    {
      entity: 'oauth_token',
      entity_id: null,
      action: 'gmail_tersambung',
      actor: 'web',
      after: { account_email: email, scopes: GMAIL_SCOPES },
    },
    database,
  );
  return email;
}

export function gmailStatus(database: DB = db()): {
  tersambung: boolean;
  email: string | null;
  scopes: string[];
  terhubung_pada: string | null;
  punya_refresh_token: boolean;
} {
  const row = database
    .prepare(`SELECT account_email, scopes, payload_enc, created_at FROM oauth_token WHERE provider = 'google'`)
    .get() as
    | { account_email: string | null; scopes: string; payload_enc: string; created_at: string }
    | undefined;
  if (!row) {
    return { tersambung: false, email: null, scopes: [], terhubung_pada: null, punya_refresh_token: false };
  }
  let punyaRefresh = false;
  try {
    punyaRefresh = Boolean(decryptJson<StoredToken>(row.payload_enc).refresh_token);
  } catch {
    punyaRefresh = false;
  }
  return {
    tersambung: true,
    email: row.account_email,
    scopes: row.scopes.split(' '),
    terhubung_pada: row.created_at,
    punya_refresh_token: punyaRefresh,
  };
}

export async function getGmailClient(database: DB = db()): Promise<OAuth2Client> {
  const row = database
    .prepare(`SELECT payload_enc FROM oauth_token WHERE provider = 'google'`)
    .get() as { payload_enc: string } | undefined;
  if (!row) throw new Error('Akun Gmail belum disambungkan. Buka Pengaturan > Koneksi Gmail.');

  const token = decryptJson<StoredToken>(row.payload_enc);
  const client = baseClient();
  client.setCredentials(token);

  // Simpan token yang diperbarui agar tidak perlu menyambung ulang.
  client.on('tokens', (tokens) => {
    const merged: StoredToken = {
      ...token,
      access_token: tokens.access_token ?? token.access_token,
      refresh_token: tokens.refresh_token ?? token.refresh_token,
      expiry_date: tokens.expiry_date ?? token.expiry_date,
    };
    database
      .prepare(`UPDATE oauth_token SET payload_enc = ?, updated_at = ? WHERE provider = 'google'`)
      .run(encryptJson(merged), nowIso());
  });

  return client;
}

/** Cabut akses dan hapus token tersimpan. */
export async function revokeGmail(database: DB = db()): Promise<void> {
  try {
    const client = await getGmailClient(database);
    await client.revokeCredentials();
  } catch {
    // Pencabutan di sisi Google mungkin sudah dilakukan manual; lanjut hapus lokal.
  }
  database.prepare(`DELETE FROM oauth_token WHERE provider = 'google'`).run();
  database
    .prepare(`UPDATE gmail_state SET history_id = NULL, initial_done = 0, updated_at = ? WHERE id = 1`)
    .run(nowIso());
  writeAudit(
    { entity: 'oauth_token', entity_id: null, action: 'gmail_dicabut', actor: 'web' },
    database,
  );
}
