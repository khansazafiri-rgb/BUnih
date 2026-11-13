import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import { webhookCallback } from 'grammy';
import { config } from './config.js';
import { db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { nowIso } from './domain/time.js';
import { rebuildObligations } from './domain/obligations.js';
import { buatRouter } from './api/routes.js';
import { createBot, startBot } from './telegram/bot.js';
import { startScheduler } from './jobs/scheduler.js';
import { redact } from './util/crypto.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

function webDir(): string | null {
  const kandidat = [
    path.join(here, '..', '..', 'web', 'dist'),
    path.join(here, '..', 'public'),
    path.join(process.cwd(), 'web', 'dist'),
  ];
  for (const c of kandidat) if (fs.existsSync(path.join(c, 'index.html'))) return c;
  return null;
}

export function buatApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '20mb' }));
  app.use(express.text({ limit: '20mb', type: 'text/csv' }));

  // Header keamanan dasar. HTTPS diterminasi oleh nginx (lihat deploy/nginx).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
    );
    next();
  });

  // Log permintaan tanpa membocorkan isi sensitif.
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api')) {
      console.log(`[api] ${req.method} ${redact(req.path)}`);
    }
    next();
  });

  app.use('/api', buatRouter());

  // Webhook Telegram (dipakai bila TELEGRAM_MODE=webhook).
  if (config.TELEGRAM_MODE === 'webhook') {
    const bot = createBot();
    if (bot) {
      const jalur = config.TELEGRAM_WEBHOOK_SECRET
        ? `/api/telegram/webhook/${config.TELEGRAM_WEBHOOK_SECRET}`
        : '/api/telegram/webhook';
      app.post(jalur, webhookCallback(bot, 'express'));
      console.log(`[telegram] webhook terpasang di ${jalur}`);
    }
  }

  const web = webDir();
  if (web) {
    app.use(express.static(web, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(web, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .status(200)
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><title>BUnih</title>' +
            '<body style="font-family:system-ui;padding:24px;line-height:1.6">' +
            '<h1>BUnih berjalan</h1>' +
            '<p>Antarmuka web belum dibangun. Jalankan <code>npm run build</code> di akar proyek.</p>' +
            '<p>API tersedia di <code>/api/kesehatan</code>.</p></body>',
        );
    });
  }

  return app;
}

async function main(): Promise<void> {
  const database = db();
  const migrasi = migrate(database);
  if (migrasi.length) console.log(`[db] migrasi diterapkan: ${migrasi.join(', ')}`);
  const hasilSeed = seed(database);
  if (Object.keys(hasilSeed).length) console.log(`[db] seed: ${JSON.stringify(hasilSeed)}`);

  try {
    rebuildObligations({}, database);
  } catch (err) {
    console.error('[db] gagal membangun rencana awal:', (err as Error).message);
  }

  const app = buatApp();
  const server = app.listen(config.BUNIH_PORT, config.BUNIH_HOST, () => {
    console.log(`[bunih] siap di http://${config.BUNIH_HOST}:${config.BUNIH_PORT} (${nowIso()})`);
    if (!config.BUNIH_WEB_PASSWORD && !config.isProd) {
      console.log('[bunih] BUNIH_WEB_PASSWORD kosong: mode pengembangan tanpa login.');
    }
  });

  if (config.TELEGRAM_MODE === 'polling') await startBot();
  else if (config.TELEGRAM_MODE === 'webhook') console.log('[telegram] menunggu webhook.');

  startScheduler();

  const tutup = (sinyal: string) => {
    console.log(`[bunih] ${sinyal} diterima, menutup...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGTERM', () => tutup('SIGTERM'));
  process.on('SIGINT', () => tutup('SIGINT'));
}

const dijalankanLangsung =
  process.argv[1] && path.resolve(process.argv[1]).includes(path.join('dist', 'index'));
if (dijalankanLangsung || process.env['BUNIH_FORCE_START'] === '1') {
  main().catch((err) => {
    console.error('[bunih] gagal start:', err);
    process.exit(1);
  });
}
