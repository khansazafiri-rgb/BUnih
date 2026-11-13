import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso, today, type IsoDate } from './time.js';
import { writeAudit } from './audit.js';
import type { ReceivableStatus } from './types.js';

export type ReceivableView = {
  id: number;
  debtor_type: 'teman' | 'company' | 'lainnya';
  debtor_name: string | null;
  nominal_awal_minor: number;
  sudah_kembali_minor: number;
  sisa_minor: number;
  occurred_on: IsoDate;
  claimed_at: string | null;
  expected_on: IsoDate | null;
  status: ReceivableStatus;
  umur_hari: number;
  terlambat: boolean;
  cash_event_id: number | null;
  keterangan: string | null;
  bukti: Array<{ evidence_id: number; kind: string; permalink: string | null }>;
};

export type ReceivableSummary = {
  total_sisa_minor: number;
  total_sisa_teman_minor: number;
  total_sisa_company_minor: number;
  jumlah_terbuka: number;
  jumlah_terlambat: number;
  per_orang: Array<{
    debtor_type: string;
    debtor_name: string;
    sisa_minor: number;
    nominal_awal_minor: number;
    sudah_kembali_minor: number;
    jumlah: number;
  }>;
  daftar: ReceivableView[];
};

export function listReceivables(
  opts: { onlyOpen?: boolean; asOf?: IsoDate } = {},
  database: DB = db(),
): ReceivableSummary {
  const asOf = opts.asOf ?? today();
  const where = opts.onlyOpen === false ? '' : `WHERE r.status NOT IN ('lunas','dihapuskan')`;
  const rows = database
    .prepare(
      `SELECT r.*, p.name AS debtor_name, a.cash_event_id, a.note AS alloc_note
         FROM receivable r
         LEFT JOIN person p ON p.id = r.debtor_person_id
         LEFT JOIN allocation a ON a.id = r.allocation_id
         ${where}
        ORDER BY r.occurred_on DESC, r.id DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  const buktiStmt = database.prepare(
    `SELECT e.id AS evidence_id, e.kind, e.permalink
       FROM cash_event_evidence cee JOIN evidence e ON e.id = cee.evidence_id
      WHERE cee.cash_event_id = ?`,
  );

  const daftar: ReceivableView[] = rows.map((r) => {
    const nominal = Number(r['origin_amount_minor']);
    const kembali = Number(r['settled_minor']);
    const occurredOn = String(r['occurred_on']);
    const expected = (r['expected_on'] as string | null) ?? null;
    const umur = Math.round(
      (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${occurredOn}T00:00:00Z`)) / 86_400_000,
    );
    const cashEventId = r['cash_event_id'] === null ? null : Number(r['cash_event_id']);
    return {
      id: Number(r['id']),
      debtor_type: String(r['debtor_type']) as 'teman' | 'company' | 'lainnya',
      debtor_name: (r['debtor_name'] as string | null) ?? null,
      nominal_awal_minor: nominal,
      sudah_kembali_minor: kembali,
      sisa_minor: nominal - kembali,
      occurred_on: occurredOn,
      claimed_at: (r['claimed_at'] as string | null) ?? null,
      expected_on: expected,
      status: String(r['status']) as ReceivableStatus,
      umur_hari: umur,
      terlambat: expected !== null && expected < asOf,
      cash_event_id: cashEventId,
      keterangan: (r['alloc_note'] as string | null) ?? (r['note'] as string | null) ?? null,
      bukti: cashEventId
        ? (buktiStmt.all(cashEventId) as Array<{
            evidence_id: number;
            kind: string;
            permalink: string | null;
          }>)
        : [],
    };
  });

  const terbuka = daftar.filter((d) => d.sisa_minor > 0);
  const perOrangMap = new Map<string, ReceivableSummary['per_orang'][number]>();
  for (const d of terbuka) {
    const nama = d.debtor_name ?? (d.debtor_type === 'company' ? 'Company' : 'Belum diberi nama');
    const key = `${d.debtor_type}:${nama}`;
    const cur =
      perOrangMap.get(key) ??
      {
        debtor_type: d.debtor_type,
        debtor_name: nama,
        sisa_minor: 0,
        nominal_awal_minor: 0,
        sudah_kembali_minor: 0,
        jumlah: 0,
      };
    cur.sisa_minor += d.sisa_minor;
    cur.nominal_awal_minor += d.nominal_awal_minor;
    cur.sudah_kembali_minor += d.sudah_kembali_minor;
    cur.jumlah += 1;
    perOrangMap.set(key, cur);
  }

  return {
    total_sisa_minor: terbuka.reduce((s, d) => s + d.sisa_minor, 0),
    total_sisa_teman_minor: terbuka
      .filter((d) => d.debtor_type === 'teman')
      .reduce((s, d) => s + d.sisa_minor, 0),
    total_sisa_company_minor: terbuka
      .filter((d) => d.debtor_type === 'company')
      .reduce((s, d) => s + d.sisa_minor, 0),
    jumlah_terbuka: terbuka.length,
    jumlah_terlambat: terbuka.filter((d) => d.terlambat).length,
    per_orang: [...perOrangMap.values()].sort((a, b) => b.sisa_minor - a.sisa_minor),
    daftar,
  };
}

export function claimReceivable(
  id: number,
  opts: { expected_on?: IsoDate | null; note?: string | null; actor?: string } = {},
  database: DB = db(),
): void {
  const before = database.prepare(`SELECT * FROM receivable WHERE id = ?`).get(id);
  if (!before) throw new Error(`Piutang ${id} tidak ditemukan.`);
  const at = nowIso();
  database
    .prepare(
      `UPDATE receivable SET status = CASE WHEN status = 'belum_diklaim' THEN 'diklaim' ELSE status END,
         claimed_at = COALESCE(claimed_at, ?), expected_on = COALESCE(?, expected_on),
         note = COALESCE(?, note), updated_at = ? WHERE id = ?`,
    )
    .run(at, opts.expected_on ?? null, opts.note ?? null, at, id);
  writeAudit(
    { entity: 'receivable', entity_id: id, action: 'diklaim', actor: opts.actor ?? 'web', before, after: opts },
    database,
  );
}

export function writeOffReceivable(
  id: number,
  reason: string,
  actor = 'web',
  database: DB = db(),
): void {
  const before = database.prepare(`SELECT * FROM receivable WHERE id = ?`).get(id);
  if (!before) throw new Error(`Piutang ${id} tidak ditemukan.`);
  database
    .prepare(`UPDATE receivable SET status = 'dihapuskan', note = ?, updated_at = ? WHERE id = ?`)
    .run(reason, nowIso(), id);
  writeAudit(
    { entity: 'receivable', entity_id: id, action: 'dihapuskan', actor, before, reason },
    database,
  );
}

/** Piutang terbuka yang nominalnya cocok dengan sebuah uang masuk — kandidat pencocokan. */
export function matchCandidates(
  amountMinor: number,
  opts: { toleransi?: number } = {},
  database: DB = db(),
): ReceivableView[] {
  const tol = opts.toleransi ?? 0;
  const all = listReceivables({ onlyOpen: true }, database);
  return all.daftar
    .filter((d) => Math.abs(d.sisa_minor - amountMinor) <= tol || d.sisa_minor >= amountMinor)
    .sort((a, b) => Math.abs(a.sisa_minor - amountMinor) - Math.abs(b.sisa_minor - amountMinor))
    .slice(0, 5);
}
