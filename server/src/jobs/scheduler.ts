import { config } from '../config.js';
import { db } from '../db/index.js';
import { nowIso, today } from '../domain/time.js';
import { rebuildObligations } from '../domain/obligations.js';
import { tanyakanTopupLewat } from '../domain/topup.js';
import { syncIncremental } from '../gmail/sync.js';
import { gmailStatus } from '../gmail/oauth.js';
import { belumPernahDikirim, catatTerkirim, kumpulkanPengingat } from '../notify/index.js';
import { kirimPesan, sendPendingDecisions } from '../telegram/bot.js';

let timers: NodeJS.Timeout[] = [];
let jalan = false;

async function kirimPengingat(mode: 'langsung' | 'harian' | 'mingguan'): Promise<number> {
  const database = db();
  const daftar = kumpulkanPengingat(mode, database);
  let terkirim = 0;
  for (const p of daftar) {
    if (!belumPernahDikirim(p, database)) continue;
    const ok = await kirimPesan(p.text, database);
    if (ok) {
      catatTerkirim(p, database);
      terkirim += 1;
    }
  }
  return terkirim;
}

/** Siklus cepat: sinkronisasi Gmail, bangun ulang rencana, kirim pertanyaan dan peringatan mendesak. */
export async function siklusCepat(): Promise<void> {
  if (jalan) return;
  jalan = true;
  try {
    const database = db();
    if (gmailStatus(database).tersambung) {
      const hasil = await syncIncremental({}, database);
      if (hasil.transaksi_dibuat > 0 || hasil.invoice_disentuh > 0) {
        rebuildObligations({}, database);
      }
    }
    await sendPendingDecisions(5, database);
    await kirimPengingat('langsung');
  } catch (err) {
    console.error('[scheduler] siklus cepat gagal:', (err as Error).message);
  } finally {
    jalan = false;
  }
}

/** Siklus harian: bangun ulang rencana, tanyakan top-up yang lewat, kirim ringkasan. */
export async function siklusHarian(): Promise<void> {
  try {
    const database = db();
    rebuildObligations({}, database);
    tanyakanTopupLewat(database);
    await sendPendingDecisions(10, database);
    await kirimPengingat('harian');
    const hari = new Date(`${today()}T00:00:00Z`).getUTCDay();
    if (hari === 1) await kirimPengingat('mingguan');
    console.log(`[scheduler] siklus harian selesai ${nowIso()}`);
  } catch (err) {
    console.error('[scheduler] siklus harian gagal:', (err as Error).message);
  }
}

export function startScheduler(): void {
  if (!config.BUNIH_ENABLE_SCHEDULER) {
    console.log('[scheduler] dimatikan lewat BUNIH_ENABLE_SCHEDULER=false.');
    return;
  }
  stopScheduler();

  const menit = config.BUNIH_GMAIL_SYNC_CRON_MINUTES;
  timers.push(setInterval(() => void siklusCepat(), menit * 60_000));
  console.log(`[scheduler] siklus cepat tiap ${menit} menit.`);

  // Pemeriksaan tiap menit untuk menemukan jam ringkasan harian (zona Asia/Jakarta).
  let hariTerakhir = '';
  timers.push(
    setInterval(() => {
      const iso = nowIso();
      const jam = Number(iso.slice(11, 13));
      const tanggal = iso.slice(0, 10);
      if (jam === config.BUNIH_DAILY_DIGEST_HOUR && hariTerakhir !== tanggal) {
        hariTerakhir = tanggal;
        void siklusHarian();
      }
    }, 60_000),
  );

  // Bangun rencana sekali saat start agar proyeksi langsung siap.
  setTimeout(() => {
    try {
      rebuildObligations({}, db());
    } catch (err) {
      console.error('[scheduler] gagal membangun rencana awal:', (err as Error).message);
    }
  }, 2_000);
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}
