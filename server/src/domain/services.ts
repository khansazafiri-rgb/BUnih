import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { addDays, nowIso, today, type IsoDate } from './time.js';
import { resolveScenario, SKENARIO_DASAR } from './scenarios.js';
import { writeAudit } from './audit.js';
import type { InvoiceStatus } from './types.js';

export type ServiceView = {
  id: number;
  slug: string;
  name: string;
  vendor: string;
  plan: string | null;
  bearer: string;
  paid_by: string;
  billing_cycle: string;
  amount_minor: number | null;
  currency: string;
  amount_certainty: string;
  next_due_date: string | null;
  due_date_certainty: string;
  status: string;
  scenario_tag: string | null;
  benefit_period_start: string | null;
  benefit_period_end: string | null;
  reserve_for_renewal_minor: number | null;
  note: string | null;
  jumlah_invoice: number;
  jumlah_pembayaran: number;
  total_dibayar_minor: number;
  pembayaran_terakhir: string | null;
};

export function listServices(database: DB = db()): ServiceView[] {
  return database
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM invoice i WHERE i.service_id = s.id) AS jumlah_invoice,
              (SELECT COUNT(*) FROM cash_event ce WHERE ce.service_id = s.id AND ce.status <> 'dibatalkan') AS jumlah_pembayaran,
              (SELECT COALESCE(SUM(ce.amount_minor),0) FROM cash_event ce
                WHERE ce.service_id = s.id AND ce.direction = 'keluar' AND ce.status <> 'dibatalkan') AS total_dibayar_minor,
              (SELECT MAX(ce.occurred_at) FROM cash_event ce WHERE ce.service_id = s.id AND ce.status <> 'dibatalkan') AS pembayaran_terakhir
         FROM service s
        ORDER BY
          CASE s.status WHEN 'aktif' THEN 0 WHEN 'akan_perpanjang' THEN 1 WHEN 'perlu_verifikasi' THEN 2
            WHEN 'opsional_skenario' THEN 3 WHEN 'lunas_periode_ini' THEN 4 WHEN 'kandidat' THEN 5 ELSE 6 END,
          s.name`,
    )
    .all() as ServiceView[];
}

const PRIORITAS_FINAL: InvoiceStatus[] = ['lunas_terkonfirmasi', 'refund', 'dibatalkan'];

/**
 * Catat satu peristiwa status tagihan, lalu hitung ulang status akhir.
 *
 * Status akhir mengikuti URUTAN PERISTIWA: bila ada gagal bayar lalu kemudian
 * kuitansi, status akhir adalah lunas. Bukti terbaru yang menang, bukan
 * bukti yang paling dulu masuk ke sistem.
 */
export function applyInvoiceStatus(
  input: {
    invoice_id: number;
    status: InvoiceStatus;
    occurred_at: string;
    evidence_id?: number | null;
    note?: string | null;
    actor?: string;
  },
  database: DB = db(),
): { status_akhir: InvoiceStatus; berubah: boolean } {
  const at = nowIso();
  const run = database.transaction(() => {
    const before = database
      .prepare(`SELECT status FROM invoice WHERE id = ?`)
      .get(input.invoice_id) as { status: InvoiceStatus } | undefined;
    if (!before) throw new Error(`Tagihan ${input.invoice_id} tidak ditemukan.`);

    database
      .prepare(
        `INSERT INTO invoice_status_event (invoice_id, status, occurred_at, evidence_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.invoice_id,
        input.status,
        input.occurred_at,
        input.evidence_id ?? null,
        input.note ?? null,
        at,
      );

    const latest = database
      .prepare(
        `SELECT status FROM invoice_status_event WHERE invoice_id = ?
          ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      )
      .get(input.invoice_id) as { status: InvoiceStatus };

    let statusAkhir = latest.status;

    // Bila ada transaksi kas yang tertaut dan terkonfirmasi, tagihan tidak mungkin
    // masih "tagihan baru".
    const pembayaran = database
      .prepare(
        `SELECT COUNT(*) AS n, MAX(occurred_at) AS terakhir FROM cash_event
          WHERE invoice_id = ? AND status <> 'dibatalkan' AND direction = 'keluar'`,
      )
      .get(input.invoice_id) as { n: number; terakhir: string | null };
    if (
      pembayaran.n > 0 &&
      !PRIORITAS_FINAL.includes(statusAkhir) &&
      statusAkhir !== 'pembayaran_terdeteksi'
    ) {
      const eventTerbaru = database
        .prepare(
          `SELECT occurred_at FROM invoice_status_event WHERE invoice_id = ?
            ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        )
        .get(input.invoice_id) as { occurred_at: string };
      if ((pembayaran.terakhir ?? '') >= eventTerbaru.occurred_at) {
        statusAkhir = 'pembayaran_terdeteksi';
      }
    }

    database
      .prepare(`UPDATE invoice SET status = ?, updated_at = ? WHERE id = ?`)
      .run(statusAkhir, at, input.invoice_id);

    writeAudit(
      {
        entity: 'invoice',
        entity_id: input.invoice_id,
        action: 'status',
        actor: input.actor ?? 'gmail-sync',
        before: { status: before.status },
        after: { status: statusAkhir, peristiwa: input.status, pada: input.occurred_at },
        reason: input.note ?? null,
      },
      database,
    );
    return { status_akhir: statusAkhir, berubah: before.status !== statusAkhir };
  });
  return run();
}

export type TagihanView = {
  id: number;
  service_id: number | null;
  service_name: string | null;
  invoice_no: string | null;
  due_date: string | null;
  amount_minor: number | null;
  currency: string;
  amount_idr_actual: number | null;
  status: InvoiceStatus;
  paid_by: string;
  bearer: string | null;
  reimbursable: number;
  note: string | null;
  sudah_dibayar: boolean;
  hari_ke_jatuh_tempo: number | null;
  bukti: Array<{ evidence_id: number; role: string; kind: string; permalink: string | null }>;
};

export function listInvoices(
  opts: { from?: IsoDate; to?: IsoDate; status?: InvoiceStatus[]; asOf?: IsoDate } = {},
  database: DB = db(),
): TagihanView[] {
  const asOf = opts.asOf ?? today();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.from) {
    clauses.push(`i.due_date >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push(`i.due_date <= ?`);
    params.push(opts.to);
  }
  if (opts.status?.length) {
    clauses.push(`i.status IN (${opts.status.map(() => '?').join(',')})`);
    params.push(...opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = database
    .prepare(
      `SELECT i.*, s.name AS service_name, s.bearer,
              (SELECT COUNT(*) FROM cash_event ce WHERE ce.invoice_id = i.id AND ce.status <> 'dibatalkan') AS pembayaran
         FROM invoice i LEFT JOIN service s ON s.id = i.service_id
         ${where}
        ORDER BY i.due_date IS NULL, i.due_date, i.id`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  const buktiStmt = database.prepare(
    `SELECT ie.evidence_id, ie.role, e.kind, e.permalink
       FROM invoice_evidence ie JOIN evidence e ON e.id = ie.evidence_id
      WHERE ie.invoice_id = ?`,
  );

  return rows.map((r) => {
    const due = (r['due_date'] as string | null) ?? null;
    return {
      id: Number(r['id']),
      service_id: r['service_id'] === null ? null : Number(r['service_id']),
      service_name: (r['service_name'] as string | null) ?? null,
      invoice_no: (r['invoice_no'] as string | null) ?? null,
      due_date: due,
      amount_minor: r['amount_minor'] === null ? null : Number(r['amount_minor']),
      currency: String(r['currency']),
      amount_idr_actual: r['amount_idr_actual'] === null ? null : Number(r['amount_idr_actual']),
      status: String(r['status']) as InvoiceStatus,
      paid_by: String(r['paid_by']),
      bearer: (r['bearer'] as string | null) ?? null,
      reimbursable: Number(r['reimbursable']),
      note: (r['note'] as string | null) ?? null,
      sudah_dibayar: Number(r['pembayaran'] ?? 0) > 0,
      hari_ke_jatuh_tempo: due
        ? Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000)
        : null,
      bukti: buktiStmt.all(Number(r['id'])) as TagihanView['bukti'],
    };
  });
}

/**
 * Peringatan: layanan yang sudah dibatalkan tetapi masih tertagih atau terbayar
 * setelah tanggal pembatalan yang dikonfirmasi.
 */
export function cancelledButCharged(database: DB = db()): Array<{
  service_id: number;
  service_name: string;
  cancelled_at: string;
  temuan: Array<{ tipe: 'invoice' | 'pembayaran'; id: number; tanggal: string; nominal_minor: number | null }>;
}> {
  const services = database
    .prepare(
      `SELECT id, name, cancelled_at FROM service
        WHERE status IN ('dibatalkan','tidak_dilanjutkan') AND cancelled_at IS NOT NULL`,
    )
    .all() as Array<{ id: number; name: string; cancelled_at: string }>;

  const out: ReturnType<typeof cancelledButCharged> = [];
  for (const s of services) {
    const invoices = database
      .prepare(
        `SELECT id, due_date, amount_minor FROM invoice
          WHERE service_id = ? AND due_date > ? AND status NOT IN ('dibatalkan','refund')`,
      )
      .all(s.id, s.cancelled_at.slice(0, 10)) as Array<{
      id: number;
      due_date: string;
      amount_minor: number | null;
    }>;
    const payments = database
      .prepare(
        `SELECT id, occurred_at, amount_minor FROM cash_event
          WHERE service_id = ? AND date(occurred_at) > ? AND status <> 'dibatalkan' AND direction = 'keluar'`,
      )
      .all(s.id, s.cancelled_at.slice(0, 10)) as Array<{
      id: number;
      occurred_at: string;
      amount_minor: number;
    }>;

    const temuan = [
      ...invoices.map((i) => ({
        tipe: 'invoice' as const,
        id: i.id,
        tanggal: i.due_date,
        nominal_minor: i.amount_minor,
      })),
      ...payments.map((p) => ({
        tipe: 'pembayaran' as const,
        id: p.id,
        tanggal: p.occurred_at,
        nominal_minor: p.amount_minor,
      })),
    ];
    if (temuan.length) {
      out.push({
        service_id: s.id,
        service_name: s.name,
        cancelled_at: s.cancelled_at,
        temuan,
      });
    }
  }
  return out;
}

export type LayananKandidat = {
  merchant_norm: string;
  merchant_contoh: string | null;
  jumlah_transaksi: number;
  total_minor: number;
  nominal_khas_minor: number | null;
  pertama: string;
  terakhir: string;
  berulang: boolean;
  cash_event_ids: number[];
  bukti_ids: number[];
};

/**
 * "Layanan belum teridentifikasi": pengeluaran berulang atau invoice/kuitansi
 * yang belum terhubung ke layanan mana pun. Dibuat sebagai kandidat; aturan
 * berulang hanya dibuat setelah dikonfirmasi pengguna.
 */
export function unidentifiedServices(
  opts: { minJumlah?: number; asOf?: IsoDate } = {},
  database: DB = db(),
): LayananKandidat[] {
  const minJumlah = opts.minJumlah ?? 2;
  const rows = database
    .prepare(
      `SELECT ce.merchant_norm, ce.merchant_raw, ce.id, ce.occurred_at, ce.amount_minor
         FROM cash_event ce
        WHERE ce.service_id IS NULL
          AND ce.direction = 'keluar'
          AND ce.status <> 'dibatalkan'
          AND ce.merchant_norm IS NOT NULL
          AND ce.kind IN ('bayar_langganan','beli_kredit_layanan','belum_dikategorikan','pengeluaran_pribadi')
        ORDER BY ce.merchant_norm, ce.occurred_at`,
    )
    .all() as Array<{
    merchant_norm: string;
    merchant_raw: string | null;
    id: number;
    occurred_at: string;
    amount_minor: number;
  }>;

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = groups.get(r.merchant_norm) ?? [];
    list.push(r);
    groups.set(r.merchant_norm, list);
  }

  const buktiStmt = database.prepare(
    `SELECT evidence_id FROM cash_event_evidence WHERE cash_event_id = ?`,
  );

  const out: LayananKandidat[] = [];
  for (const [norm, list] of groups) {
    if (list.length < minJumlah) continue;
    const amounts = list.map((r) => r.amount_minor);
    const sama = new Set(amounts).size <= Math.max(1, Math.floor(list.length / 2));
    const buktiIds = list.flatMap(
      (r) => (buktiStmt.all(r.id) as Array<{ evidence_id: number }>).map((b) => b.evidence_id),
    );
    out.push({
      merchant_norm: norm,
      merchant_contoh: list[0]?.merchant_raw ?? null,
      jumlah_transaksi: list.length,
      total_minor: amounts.reduce((s, a) => s + a, 0),
      nominal_khas_minor: sama ? (amounts[0] ?? null) : null,
      pertama: list[0]!.occurred_at,
      terakhir: list[list.length - 1]!.occurred_at,
      berulang: sama && list.length >= 2,
      cash_event_ids: list.map((r) => r.id),
      bukti_ids: [...new Set(buktiIds)],
    });
  }

  // Invoice/kuitansi yang belum terhubung ke layanan apa pun.
  const lepas = database
    .prepare(
      `SELECT e.id, e.from_email, e.subject, e.received_at
         FROM evidence e
        WHERE e.kind IN ('invoice','kuitansi')
          AND e.is_promo = 0
          AND NOT EXISTS (SELECT 1 FROM invoice_evidence ie WHERE ie.evidence_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM cash_event_evidence cee WHERE cee.evidence_id = e.id)
        ORDER BY e.received_at DESC LIMIT 50`,
    )
    .all() as Array<{ id: number; from_email: string | null; subject: string | null; received_at: string }>;

  for (const e of lepas) {
    out.push({
      merchant_norm: e.from_email ?? 'tanpa-pengirim',
      merchant_contoh: e.subject,
      jumlah_transaksi: 0,
      total_minor: 0,
      nominal_khas_minor: null,
      pertama: e.received_at,
      terakhir: e.received_at,
      berulang: false,
      cash_event_ids: [],
      bukti_ids: [e.id],
    });
  }

  return out.sort((a, b) => b.jumlah_transaksi - a.jumlah_transaksi);
}

/**
 * Tagihan yang perlu disiapkan dananya dalam N hari ke depan.
 *
 * Kewajiban yang hanya hidup di skenario tertentu (mis. Claude Pro pribadi)
 * tetap ditampilkan agar terlihat, tetapi TIDAK ikut dijumlahkan ke dana yang
 * perlu disiapkan kecuali skenario yang dipilih mengaktifkannya.
 */
export function tagihanMendekat(
  opts: { hari?: number; asOf?: IsoDate; skenario?: string } = {},
  database: DB = db(),
) {
  const asOf = opts.asOf ?? today();
  const sampai = addDays(asOf, opts.hari ?? 14);
  const skenario = resolveScenario(opts.skenario ?? SKENARIO_DASAR, database);
  const rows = database
    .prepare(
      `SELECT o.id, o.label, o.due_date, o.amount_minor, o.amount_certainty, o.bearer, o.paid_by,
              o.affects_my_cash, o.kind, o.service_id, o.invoice_id, o.scenario_tag,
              i.status AS invoice_status
         FROM obligation o LEFT JOIN invoice i ON i.id = o.invoice_id
        WHERE o.status = 'rencana'
          AND o.kind IN ('langganan','tagihan','cadangan_perpanjangan')
          AND o.due_date <= ?
        ORDER BY o.due_date, o.amount_minor DESC`,
    )
    .all(sampai) as Array<Record<string, unknown>>;

  const daftar = rows.map((r) => {
    const tag = (r['scenario_tag'] as string | null) ?? null;
    return {
      obligation_id: Number(r['id']),
      label: String(r['label']),
      tanggal: String(r['due_date']),
      nominal_minor: r['amount_minor'] === null ? null : Number(r['amount_minor']),
      kepastian: String(r['amount_certainty']),
      penanggung: String(r['bearer']),
      pembayar: String(r['paid_by']),
      memotong_saldo_saya: Number(r['affects_my_cash']) === 1,
      terlambat: String(r['due_date']) < asOf,
      invoice_status: (r['invoice_status'] as string | null) ?? null,
      service_id: r['service_id'] === null ? null : Number(r['service_id']),
      skenario_tag: tag,
      /** false = hanya muncul bila skenario lain dipilih; tidak ikut dijumlahkan. */
      aktif_di_skenario: tag === null || skenario.enabledTags.has(tag),
    };
  });

  const perlu = daftar.filter(
    (d) => d.memotong_saldo_saya && d.nominal_minor !== null && d.aktif_di_skenario,
  );
  return {
    sampai,
    skenario: { slug: skenario.slug, nama: skenario.name },
    daftar,
    dana_perlu_disiapkan_minor: perlu.reduce((s, d) => s + (d.nominal_minor ?? 0), 0),
    jumlah_tanpa_nominal: daftar.filter((d) => d.aktif_di_skenario && d.nominal_minor === null).length,
    jumlah_terlambat: daftar.filter((d) => d.aktif_di_skenario && d.terlambat).length,
    jumlah_hanya_skenario_lain: daftar.filter((d) => !d.aktif_di_skenario).length,
  };
}
