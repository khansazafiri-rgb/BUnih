import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { addDays, addMonths, nowIso, today, type IsoDate } from './time.js';
import { numberAssumption, assumptionAt } from './assumptions.js';
import { writeAudit } from './audit.js';

export type ObligationRow = {
  id: number;
  kind: string;
  due_date: string;
  amount_minor: number | null;
  currency: string;
  amount_certainty: 'terverifikasi' | 'perkiraan' | 'asumsi_sheet';
  bearer: 'pribadi' | 'company' | 'belum_jelas';
  paid_by: 'saya' | 'company' | 'belum_jelas';
  affects_my_cash: number;
  account_id: number | null;
  service_id: number | null;
  invoice_id: number | null;
  purchase_id: number | null;
  scenario_tag: string | null;
  status: 'rencana' | 'terealisasi' | 'dibatalkan' | 'kedaluwarsa';
  realized_cash_event_id: number | null;
  label: string;
  generation_key: string;
  generated_from: string;
  note: string | null;
};

export type RebuildResult = {
  dibuat: number;
  diperbarui: number;
  dibatalkan: number;
  topup_dibuat: number;
  catatan: string[];
};

const INVOICE_SUDAH_SELESAI = new Set([
  'lunas_terkonfirmasi',
  'pembayaran_terdeteksi',
  'dibatalkan',
  'refund',
]);

function upsertObligation(
  database: DB,
  o: {
    kind: string;
    due_date: IsoDate;
    amount_minor: number | null;
    currency?: string;
    amount_certainty: 'terverifikasi' | 'perkiraan' | 'asumsi_sheet';
    bearer: 'pribadi' | 'company' | 'belum_jelas';
    paid_by: 'saya' | 'company' | 'belum_jelas';
    service_id?: number | null;
    invoice_id?: number | null;
    purchase_id?: number | null;
    scenario_tag?: string | null;
    label: string;
    generation_key: string;
    generated_from: string;
    note?: string | null;
  },
): 'dibuat' | 'diperbarui' {
  const at = nowIso();
  const affects = o.paid_by === 'company' ? 0 : 1;
  const existing = database
    .prepare(`SELECT id, status FROM obligation WHERE generation_key = ?`)
    .get(o.generation_key) as { id: number; status: string } | undefined;

  if (existing) {
    // Rencana yang sudah terealisasi / dibatalkan tidak boleh ditulis ulang.
    if (existing.status !== 'rencana') return 'diperbarui';
    database
      .prepare(
        `UPDATE obligation SET
           due_date = ?, amount_minor = ?, currency = ?, amount_certainty = ?,
           bearer = ?, paid_by = ?, affects_my_cash = ?, service_id = ?, invoice_id = ?,
           purchase_id = ?, scenario_tag = ?, label = ?, note = ?, status = 'rencana', updated_at = ?
         WHERE id = ?`,
      )
      .run(
        o.due_date,
        o.amount_minor,
        o.currency ?? 'IDR',
        o.amount_certainty,
        o.bearer,
        o.paid_by,
        affects,
        o.service_id ?? null,
        o.invoice_id ?? null,
        o.purchase_id ?? null,
        o.scenario_tag ?? null,
        o.label,
        o.note ?? null,
        at,
        existing.id,
      );
    return 'diperbarui';
  }

  database
    .prepare(
      `INSERT INTO obligation
        (kind, due_date, amount_minor, currency, amount_certainty, bearer, paid_by, affects_my_cash,
         account_id, service_id, invoice_id, purchase_id, scenario_tag, status, realized_cash_event_id,
         label, generation_key, generated_from, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'rencana', NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.kind,
      o.due_date,
      o.amount_minor,
      o.currency ?? 'IDR',
      o.amount_certainty,
      o.bearer,
      o.paid_by,
      affects,
      o.service_id ?? null,
      o.invoice_id ?? null,
      o.purchase_id ?? null,
      o.scenario_tag ?? null,
      o.label,
      o.generation_key,
      o.generated_from,
      o.note ?? null,
      at,
      at,
    );
  return 'dibuat';
}

/**
 * Bangun ulang seluruh rencana pengeluaran dari katalog layanan, tagihan, dan belanja.
 *
 * Idempoten lewat generation_key: menjalankan ulang tidak menciptakan duplikat.
 * Katalog langganan TIDAK memotong saldo; ia hanya membuat kewajiban/proyeksi.
 * Uang keluar baru tercatat saat pembayaran benar-benar terjadi (cash_event).
 */
export function rebuildObligations(
  opts: { horizonTo?: IsoDate; asOf?: IsoDate } = {},
  database: DB = db(),
): RebuildResult {
  const asOf = opts.asOf ?? today();
  const horizonTo = opts.horizonTo ?? addDays(asOf, 180);
  const catatan: string[] = [];
  let dibuat = 0;
  let diperbarui = 0;
  let dibatalkan = 0;

  const run = database.transaction(() => {
    const seen = new Set<string>();

    // --- Tagihan konkret (invoice) ---------------------------------------
    const invoices = database
      .prepare(
        `SELECT i.*, s.name AS service_name, s.bearer AS service_bearer, s.slug AS service_slug,
                s.scenario_tag AS service_tag,
                (SELECT COUNT(*) FROM cash_event ce WHERE ce.invoice_id = i.id AND ce.status <> 'dibatalkan') AS pembayaran
           FROM invoice i LEFT JOIN service s ON s.id = i.service_id`,
      )
      .all() as Array<Record<string, unknown>>;

    for (const inv of invoices) {
      const status = String(inv['status']);
      const pembayaran = Number(inv['pembayaran'] ?? 0);
      const dueDate = inv['due_date'] ? String(inv['due_date']) : null;
      if (!dueDate) continue;
      // Sudah dibayar / dibatalkan, atau sudah ada transaksi kas tertaut:
      // jangan buat rencana lagi, supaya tidak memotong saldo dua kali.
      if (INVOICE_SUDAH_SELESAI.has(status) || pembayaran > 0) continue;
      if (dueDate > horizonTo) continue;

      const key = `inv:${inv['id']}`;
      seen.add(key);
      const res = upsertObligation(database, {
        kind: 'tagihan',
        due_date: dueDate,
        amount_minor: inv['amount_minor'] === null ? null : Number(inv['amount_minor']),
        currency: String(inv['currency'] ?? 'IDR'),
        amount_certainty: 'perkiraan',
        bearer: (inv['service_bearer'] as 'pribadi' | 'company' | 'belum_jelas') ?? 'belum_jelas',
        paid_by: (inv['paid_by'] as 'saya' | 'company' | 'belum_jelas') ?? 'belum_jelas',
        service_id: inv['service_id'] === null ? null : Number(inv['service_id']),
        invoice_id: Number(inv['id']),
        scenario_tag: (inv['service_tag'] as string | null) ?? null,
        label: `${inv['service_name'] ?? 'Tagihan'}${inv['invoice_no'] ? ` #${inv['invoice_no']}` : ''}`,
        generation_key: key,
        generated_from: 'invoice',
        note: status === 'gagal_bayar' ? 'Pernah gagal bayar — perlu dibayar ulang.' : null,
      });
      if (res === 'dibuat') dibuat += 1;
      else diperbarui += 1;

      if (inv['paid_by'] === 'belum_jelas') {
        catatan.push(
          `Tagihan ${inv['service_name']} jatuh tempo ${dueDate}: belum ditentukan company bayar langsung atau saya menalangi.`,
        );
      }
    }

    // --- Langganan berulang ----------------------------------------------
    const services = database
      .prepare(
        `SELECT * FROM service
          WHERE status IN ('aktif','akan_perpanjang','opsional_skenario','lunas_periode_ini')`,
      )
      .all() as Array<Record<string, unknown>>;

    for (const svc of services) {
      const cycle = String(svc['billing_cycle']);
      const status = String(svc['status']);
      const slug = String(svc['slug']);

      // Pembelian sesuai pemakaian tidak membuat tagihan bulanan tetap.
      if (cycle === 'sesuai_pemakaian' || cycle === 'sekali' || cycle === 'belum_jelas') {
        if (cycle === 'belum_jelas')
          catatan.push(`Siklus penagihan ${svc['name']} belum jelas, jadi belum masuk proyeksi.`);
        continue;
      }

      const nextDue = svc['next_due_date'] ? String(svc['next_due_date']) : null;
      if (!nextDue) {
        catatan.push(
          `${svc['name']} belum punya tanggal tagihan yang dikonfirmasi, jadi belum masuk proyeksi.`,
        );
        continue;
      }

      const benefitEnd = svc['benefit_period_end'] ? String(svc['benefit_period_end']) : null;
      const amount = svc['amount_minor'] === null ? null : Number(svc['amount_minor']);

      let cursor: IsoDate = nextDue;
      let guard = 0;
      while (cursor <= horizonTo && guard < 400) {
        guard += 1;
        // Periode yang sudah dibayar di muka tidak ditagih ulang.
        const sudahDibayarDiMuka =
          status === 'lunas_periode_ini' && benefitEnd !== null && cursor <= benefitEnd;

        if (!sudahDibayarDiMuka) {
          // Jangan duplikasi bila sudah ada invoice untuk tanggal itu.
          const adaInvoice = database
            .prepare(
              `SELECT 1 FROM invoice WHERE service_id = ? AND due_date = ? LIMIT 1`,
            )
            .get(svc['id'], cursor);
          if (!adaInvoice) {
            const key = `svc:${svc['id']}:${cursor}`;
            seen.add(key);
            const res = upsertObligation(database, {
              kind: 'langganan',
              due_date: cursor,
              amount_minor: amount,
              currency: String(svc['currency'] ?? 'IDR'),
              amount_certainty: String(svc['amount_certainty']) as 'terverifikasi' | 'perkiraan' | 'asumsi_sheet',
              bearer: String(svc['bearer']) as 'pribadi' | 'company' | 'belum_jelas',
              paid_by: String(svc['paid_by']) as 'saya' | 'company' | 'belum_jelas',
              service_id: Number(svc['id']),
              scenario_tag: (svc['scenario_tag'] as string | null) ?? null,
              label: String(svc['name']),
              generation_key: key,
              generated_from: 'service',
              note:
                status === 'opsional_skenario'
                  ? 'Hanya dihitung pada skenario yang mengaktifkan layanan ini.'
                  : null,
            });
            if (res === 'dibuat') dibuat += 1;
            else diperbarui += 1;
            if (amount === null) {
              catatan.push(`${svc['name']} belum punya nominal, jadi risikonya belum dapat dihitung.`);
            }
          }
        }
        cursor = cycle === 'tahunan' ? addMonths(cursor, 12) : addMonths(cursor, 1);
      }

      // Dana cadangan perpanjangan untuk layanan tahunan yang sudah dibayar.
      const reserve = svc['reserve_for_renewal_minor'];
      if (cycle === 'tahunan' && reserve !== null && reserve !== undefined && benefitEnd) {
        const key = `reserve:${svc['id']}:${benefitEnd}`;
        seen.add(key);
        const res = upsertObligation(database, {
          kind: 'cadangan_perpanjangan',
          due_date: benefitEnd,
          amount_minor: Number(reserve),
          amount_certainty: 'perkiraan',
          bearer: String(svc['bearer']) as 'pribadi' | 'company' | 'belum_jelas',
          paid_by: String(svc['paid_by']) as 'saya' | 'company' | 'belum_jelas',
          service_id: Number(svc['id']),
          label: `Cadangan perpanjangan ${svc['name']}`,
          generation_key: key,
          generated_from: 'service',
          note: 'Rencana terpisah; bukan potongan saldo bulanan.',
        });
        if (res === 'dibuat') dibuat += 1;
        else diperbarui += 1;
      }
    }

    // --- Belanja terencana yang belum dibayar ----------------------------
    const purchases = database
      .prepare(
        `SELECT * FROM purchase
          WHERE payment_status IN ('belum_dibayar','sebagian')
            AND wanted_on IS NOT NULL`,
      )
      .all() as Array<Record<string, unknown>>;

    for (const p of purchases) {
      const wantedOn = String(p['wanted_on']);
      if (wantedOn > horizonTo) continue;
      const key = `buy:${p['id']}`;
      seen.add(key);
      const unknown = Number(p['price_unknown']) === 1 || p['total_minor'] === null;
      const res = upsertObligation(database, {
        kind: 'belanja_rencana',
        due_date: wantedOn,
        amount_minor: unknown ? null : Number(p['total_minor']),
        amount_certainty: unknown ? 'perkiraan' : 'terverifikasi',
        bearer: p['final_bearer'] === 'company' ? 'company' : 'pribadi',
        paid_by: p['final_bearer'] === 'company' ? 'belum_jelas' : 'saya',
        purchase_id: Number(p['id']),
        label: String(p['name']),
        generation_key: key,
        generated_from: 'purchase',
        note: unknown ? 'Harga belum diketahui — risiko anggaran belum dapat dihitung.' : null,
      });
      if (res === 'dibuat') dibuat += 1;
      else diperbarui += 1;
      if (unknown) {
        catatan.push(`Belanja "${p['name']}" belum punya harga, jadi tidak dianggap gratis tetapi juga belum terhitung.`);
      }
    }

    // --- Bersihkan rencana yang sudah tidak berlaku ----------------------
    const stale = database
      .prepare(
        `SELECT id, generation_key, label FROM obligation
          WHERE status = 'rencana' AND generated_from IN ('service','invoice','purchase')`,
      )
      .all() as Array<{ id: number; generation_key: string; label: string }>;
    for (const s of stale) {
      if (seen.has(s.generation_key)) continue;
      database
        .prepare(`UPDATE obligation SET status = 'dibatalkan', updated_at = ? WHERE id = ?`)
        .run(nowIso(), s.id);
      writeAudit(
        {
          entity: 'obligation',
          entity_id: s.id,
          action: 'dibatalkan_otomatis',
          actor: 'scheduler',
          reason: 'Sumbernya tidak lagi menghasilkan rencana ini (lunas, dibatalkan, atau berubah).',
        },
        database,
      );
      dibatalkan += 1;
    }
  });

  run();
  const topup = ensureTopupPlans({ horizonTo, asOf }, database);
  catatan.push(...topup.catatan);
  return { dibuat, diperbarui, dibatalkan, topup_dibuat: topup.dibuat, catatan };
}

/**
 * Buat baris rencana top-up dari asumsi (tanggal mulai + interval + nominal).
 * Rencana ini BELUM menjadi pemasukan; statusnya tetap 'rencana' sampai ada
 * bukti masuk atau konfirmasi dari pengguna.
 */
export function ensureTopupPlans(
  opts: { horizonTo?: IsoDate; asOf?: IsoDate } = {},
  database: DB = db(),
): { dibuat: number; catatan: string[] } {
  const asOf = opts.asOf ?? today();
  const horizonTo = opts.horizonTo ?? addDays(asOf, 180);
  const catatan: string[] = [];

  const mulai =
    assumptionAt<string>('topup_mulai', asOf, database)?.value ??
    assumptionAt<string>('periode_mulai', asOf, database)?.value ??
    null;
  if (!mulai) {
    catatan.push(
      'Tanggal mulai top-up/periode belum dikonfirmasi, jadi rencana top-up belum dapat dibuat. ' +
        'Isi "periode_mulai" di Pengaturan.',
    );
    return { dibuat: 0, catatan };
  }

  const nominal = numberAssumption('topup_nominal', 0, asOf, database);
  const interval = numberAssumption('topup_interval_hari', 5, asOf, database);
  if (nominal.value <= 0 || interval.value <= 0) {
    catatan.push('Nominal atau interval top-up belum valid, jadi rencana top-up tidak dibuat.');
    return { dibuat: 0, catatan };
  }

  const akun = database
    .prepare(`SELECT id FROM account WHERE is_mine = 1 AND is_savings_target = 0 ORDER BY id LIMIT 1`)
    .get() as { id: number } | undefined;

  let dibuat = 0;
  const run = database.transaction(() => {
    const at = nowIso();
    const ins = database.prepare(
      `INSERT OR IGNORE INTO topup_plan
        (plan_date, plan_amount_minor, currency, account_id, source_label, status,
         actual_amount_minor, actual_date, cash_event_id, generation_key, note, created_at, updated_at)
       VALUES (?, ?, 'IDR', ?, ?, 'rencana', NULL, NULL, NULL, ?, ?, ?, ?)`,
    );
    let cursor: IsoDate = String(mulai);
    let guard = 0;
    while (cursor <= horizonTo && guard < 500) {
      guard += 1;
      const key = `topup:${cursor}`;
      const res = ins.run(
        cursor,
        nominal.value,
        akun?.id ?? null,
        'Rencana dari asumsi PENGATURAN',
        key,
        `Interval ${interval.value} hari (${nominal.certainty}).`,
        at,
        at,
      );
      if (res.changes) dibuat += 1;
      cursor = addDays(cursor, interval.value);
    }
  });
  run();
  return { dibuat, catatan };
}

export function listObligations(
  opts: { from?: IsoDate; to?: IsoDate; status?: string } = {},
  database: DB = db(),
): ObligationRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.from) {
    clauses.push(`due_date >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push(`due_date <= ?`);
    params.push(opts.to);
  }
  if (opts.status) {
    clauses.push(`status = ?`);
    params.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return database
    .prepare(`SELECT * FROM obligation ${where} ORDER BY due_date, id`)
    .all(...params) as ObligationRow[];
}
