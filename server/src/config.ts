import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BUNIH_PORT: z.coerce.number().int().positive().default(8787),
  BUNIH_HOST: z.string().default('127.0.0.1'),
  BUNIH_BASE_URL: z.string().default('http://127.0.0.1:8787'),
  BUNIH_DATA_DIR: z.string().default('./data'),
  BUNIH_DB_FILE: z.string().default(''),
  /** Kunci enkripsi token (32 byte hex / base64 / teks bebas yang akan di-hash). Wajib di produksi. */
  BUNIH_SECRET_KEY: z.string().default(''),
  /** Kata sandi masuk web (satu pengguna). */
  BUNIH_WEB_PASSWORD: z.string().default(''),
  BUNIH_TIMEZONE: z.string().default('Asia/Jakarta'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default(''),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_ALLOWED_CHAT_ID: z.string().default(''),
  TELEGRAM_MODE: z.enum(['polling', 'webhook', 'off']).default('polling'),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),

  BUNIH_ENABLE_SCHEDULER: bool(true),
  BUNIH_GMAIL_SYNC_CRON_MINUTES: z.coerce.number().int().positive().default(10),
  BUNIH_DAILY_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(7),
});

export type Config = z.infer<typeof schema> & {
  dbFile: string;
  dataDir: string;
  isProd: boolean;
};

function build(): Config {
  const parsed = schema.parse(process.env);
  const dataDir = path.resolve(parsed.BUNIH_DATA_DIR);
  const dbFile = parsed.BUNIH_DB_FILE
    ? path.resolve(parsed.BUNIH_DB_FILE)
    : path.join(dataDir, 'bunih.sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  const isProd = parsed.NODE_ENV === 'production';

  if (isProd) {
    const missing: string[] = [];
    if (!parsed.BUNIH_SECRET_KEY) missing.push('BUNIH_SECRET_KEY');
    if (!parsed.BUNIH_WEB_PASSWORD) missing.push('BUNIH_WEB_PASSWORD');
    if (missing.length) {
      throw new Error(
        `Konfigurasi produksi belum lengkap: ${missing.join(', ')}. Lihat .env.example.`,
      );
    }
  }
  return { ...parsed, dataDir, dbFile, isProd };
}

export const config: Config = build();
export const TZ = config.BUNIH_TIMEZONE;
