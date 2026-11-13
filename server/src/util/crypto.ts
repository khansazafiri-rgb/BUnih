import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Enkripsi token (Gmail refresh token, dll.) sebelum masuk database.
 * AES-256-GCM dengan kunci turunan dari BUNIH_SECRET_KEY.
 */
function key(): Buffer {
  const raw = config.BUNIH_SECRET_KEY;
  if (!raw) {
    if (config.isProd) throw new Error('BUNIH_SECRET_KEY wajib diisi di produksi.');
    // Kunci pengembangan yang jelas tidak untuk produksi.
    return crypto.createHash('sha256').update('bunih-dev-only-key').digest();
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptJson<T = unknown>(payload: string): T {
  const [version, ivB64, tagB64, dataB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Format token terenkripsi tidak dikenali.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(dec.toString('utf8')) as T;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Sidik jari nomor rekening: dipakai untuk mencocokkan email tanpa menyimpan nomornya. */
export function accountFingerprint(numberDigits: string): string {
  const digits = numberDigits.replace(/\D/g, '');
  return sha256(`rek:${digits}`).slice(0, 32);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Redaksi untuk log: nomor panjang, email, dan nominal tidak boleh bocor utuh. */
export function redact(text: string): string {
  return text
    .replace(/\b\d{6,}\b/g, (m) => `${'*'.repeat(Math.max(0, m.length - 4))}${m.slice(-4)}`)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => `${m.slice(0, 2)}***@***`);
}
