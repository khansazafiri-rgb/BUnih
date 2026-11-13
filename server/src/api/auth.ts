import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { timingSafeEqual } from '../util/crypto.js';

const COOKIE = 'bunih_sesi';
const UMUR_DETIK = 60 * 60 * 24 * 14;

function secret(): string {
  return config.BUNIH_SECRET_KEY || 'bunih-dev-only-key';
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function buatToken(): string {
  const exp = Math.floor(Date.now() / 1000) + UMUR_DETIK;
  const payload = `v1.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function tokenValid(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [v, expRaw, sig] = parts as [string, string, string];
  if (v !== 'v1') return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return timingSafeEqual(sign(`${v}.${expRaw}`), sig);
}

function bacaCookie(req: Request): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return rest.join('=');
  }
  return undefined;
}

export function setSesiCookie(res: Response, token: string): void {
  const aman = config.isProd ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${UMUR_DETIK}${aman}`,
  );
}

export function hapusSesiCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Satu pengguna, satu kata sandi. Tanpa kata sandi di produksi, server menolak start. */
export function periksaKataSandi(input: string): boolean {
  const expected = config.BUNIH_WEB_PASSWORD;
  if (!expected) return !config.isProd; // mode pengembangan: bebas masuk
  return timingSafeEqual(
    crypto.createHash('sha256').update(input).digest('hex'),
    crypto.createHash('sha256').update(expected).digest('hex'),
  );
}

export function wajibMasuk(req: Request, res: Response, next: NextFunction): void {
  if (!config.BUNIH_WEB_PASSWORD && !config.isProd) {
    next();
    return;
  }
  if (tokenValid(bacaCookie(req))) {
    next();
    return;
  }
  res.status(401).json({ error: 'Belum masuk', pesan: 'Silakan masuk dulu.' });
}

export function sudahMasuk(req: Request): boolean {
  if (!config.BUNIH_WEB_PASSWORD && !config.isProd) return true;
  return tokenValid(bacaCookie(req));
}
