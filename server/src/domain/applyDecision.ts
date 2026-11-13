import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso, dateOf, today } from './time.js';
import { formatIDR, splitEvenly } from './money.js';
import {
  getCashEvent, matchInternalTransfer, recategorize, resplitCashEvent, type AllocationInput,
} from './ledger.js';
import { answerDecision, getDecision, type DecisionRow } from './decisions.js';
import { setTopupStatus } from './topup.js';
import { recordReconciliation } from './balances.js';
import { writeAudit } from './audit.js';
import { ensurePerson } from './people.js';

export type Lanjutan =
  | { tipe: 'pilih_kategori'; cash_event_id: number }
  | { tipe: 'input_bagi_biaya'; cash_event_id: number; nominal_minor: number }
  | { tipe: 'input_nominal'; topup_plan_id: number }
  | { tipe: 'pilih_opsi_bebas'; cash_event_id: number };

export type ApplyResult = {
  ok: boolean;
  pesan: string;
  lanjutan?: Lanjutan;
};

const personId = (kind: 'company' | 'teman', nama: string | null, database: DB) => ensurePerson(kind, nama, database);

function konfirmasiTransaksi(cashEventId: number, database: DB): void {
  database
    .prepare(
      `UPDATE cash_event SET status = CASE WHEN status = 'perlu_verifikasi' THEN 'terkonfirmasi' ELSE status END,
         updated_at = ? WHERE id = ?`,
    )
    .run(nowIso(), cashEventId);
}

/** Ubah transaksi menjadi klaim reimburse company (saya bayar dulu). */
export function jadikanReimburseCompany(
  cashEventId: number,
  opts: { bagian_company_minor?: number | null; actor?: string } = {},
  database: DB = db(),
): void {
  const ev = getCashEvent(cashEventId, database);
  if (!ev) throw new Error(`Transaksi ${cashEventId} tidak ditemukan.`);
  const company = personId('company', null, database);
  const bagianCompany = opts.bagian_company_minor ?? ev.amount_minor;
  const sisaPribadi = ev.amount_minor - bagianCompany;

  const allocations: AllocationInput[] = [
    {
      amount_minor: bagianCompany,
      purpose: 'piutang_company',
      bearer_type: 'company',
      bearer_person_id: company,
      category_id: ev.category_id,
      note: 'Saya bayar dulu, akan direimburse company.',
    },
  ];
  if (sisaPribadi > 0) {
    allocations.push({
      amount_minor: sisaPribadi,
      purpose: 'biaya_pribadi',
      bearer_type: 'saya',
      category_id: ev.category_id,
    });
  }
  recategorize(cashEventId, { kind: 'pengeluaran_reimburse_company' }, opts.actor ?? 'telegram', database);
  resplitCashEvent(cashEventId, allocations, opts.actor ?? 'telegram', database);
  konfirmasiTransaksi(cashEventId, database);
}

/** Company membayar langsung: saldo saya tidak berubah. */
export function jadikanCompanyLangsung(
  cashEventId: number,
  actor = 'telegram',
  database: DB = db(),
): void {
  const ev = getCashEvent(cashEventId, database);
  if (!ev) throw new Error(`Transaksi ${cashEventId} tidak ditemukan.`);
  const company = personId('company', null, database);
  recategorize(cashEventId, { kind: 'pengeluaran_company_langsung' }, actor, database);
  resplitCashEvent(
    cashEventId,
    [
      {
        amount_minor: ev.amount_minor,
        purpose: 'biaya_company_langsung',
        bearer_type: 'company',
        bearer_person_id: company,
        category_id: ev.category_id,
        note: 'Dibayar langsung oleh company.',
      },
    ],
    actor,
    database,
  );
  // Uang tidak lewat rekening saya.
  database
    .prepare(`UPDATE cash_event SET account_id = NULL, is_cash = 0, status = 'terkonfirmasi', updated_at = ? WHERE id = ?`)
    .run(nowIso(), cashEventId);
  writeAudit(
    {
      entity: 'cash_event',
      entity_id: cashEventId,
      action: 'jadi_company_langsung',
      actor,
      reason: 'Company membayar langsung, saldo pribadi tidak berubah.',
    },
    database,
  );
}

/** Bagi biaya: bagian saya + beberapa orang lain yang akan mengganti. */
export function bagiBiaya(
  cashEventId: number,
  input: {
    bagian_saya_minor?: number | null;
    jumlah_orang?: number | null;
    orang?: Array<{ nama: string; nominal_minor: number }>;
    actor?: string;
  },
  database: DB = db(),
): { pesan: string } {
  const ev = getCashEvent(cashEventId, database);
  if (!ev) throw new Error(`Transaksi ${cashEventId} tidak ditemukan.`);
  const actor = input.actor ?? 'telegram';

  let bagianSaya: number;
  let lainnya: Array<{ nama: string; nominal_minor: number }>;

  if (input.orang?.length) {
    lainnya = input.orang;
    const totalLain = lainnya.reduce((s, o) => s + o.nominal_minor, 0);
    bagianSaya = input.bagian_saya_minor ?? ev.amount_minor - totalLain;
  } else if (input.bagian_saya_minor !== null && input.bagian_saya_minor !== undefined) {
    bagianSaya = input.bagian_saya_minor;
    const sisa = ev.amount_minor - bagianSaya;
    const n = Math.max(1, (input.jumlah_orang ?? 2) - 1);
    const bagian = splitEvenly(sisa, n);
    lainnya = bagian.map((nominal, i) => ({ nama: `Teman ${i + 1}`, nominal_minor: nominal }));
  } else if (input.jumlah_orang && input.jumlah_orang > 1) {
    const bagian = splitEvenly(ev.amount_minor, input.jumlah_orang);
    bagianSaya = bagian[0]!;
    lainnya = bagian.slice(1).map((nominal, i) => ({ nama: `Teman ${i + 1}`, nominal_minor: nominal }));
  } else {
    throw new Error('Perlu bagian saya atau jumlah orang untuk membagi biaya.');
  }

  const totalLain = lainnya.reduce((s, o) => s + o.nominal_minor, 0);
  if (bagianSaya + totalLain !== ev.amount_minor) {
    throw new Error(
      `Pembagian tidak pas: ${formatIDR(bagianSaya)} + ${formatIDR(totalLain)} ` +
        `tidak sama dengan ${formatIDR(ev.amount_minor)}.`,
    );
  }

  const allocations: AllocationInput[] = [];
  if (bagianSaya > 0) {
    allocations.push({
      amount_minor: bagianSaya,
      purpose: 'biaya_pribadi',
      bearer_type: 'saya',
      category_id: ev.category_id,
      note: 'Bagian saya.',
    });
  }
  for (const o of lainnya) {
    if (o.nominal_minor <= 0) continue;
    allocations.push({
      amount_minor: o.nominal_minor,
      purpose: 'piutang_teman',
      bearer_type: 'teman',
      bearer_person_id: personId('teman', o.nama, database),
      category_id: ev.category_id,
      note: `Bagian ${o.nama}, akan diganti.`,
    });
  }

  recategorize(cashEventId, { kind: 'pengeluaran_bersama' }, actor, database);
  resplitCashEvent(cashEventId, allocations, actor, database);
  konfirmasiTransaksi(cashEventId, database);

  return {
    pesan:
      `Arus kas keluar ${formatIDR(ev.amount_minor)}, pengeluaran pribadiku ` +
      `${formatIDR(bagianSaya)}, piutang ${formatIDR(totalLain)}.`,
  };
}

/** Uang masuk dicatat sebagai pelunasan piutang, bukan pendapatan baru. */
export function jadikanPelunasanPiutang(
  cashEventId: number,
  receivableId: number,
  actor = 'telegram',
  database: DB = db(),
): { pesan: string } {
  const ev = getCashEvent(cashEventId, database);
  if (!ev) throw new Error(`Transaksi ${cashEventId} tidak ditemukan.`);
  const recv = database
    .prepare(`SELECT origin_amount_minor, settled_minor FROM receivable WHERE id = ?`)
    .get(receivableId) as { origin_amount_minor: number; settled_minor: number } | undefined;
  if (!recv) throw new Error(`Piutang ${receivableId} tidak ditemukan.`);

  const sisa = recv.origin_amount_minor - recv.settled_minor;
  const dipakai = Math.min(sisa, ev.amount_minor);
  const kelebihan = ev.amount_minor - dipakai;

  const allocations: AllocationInput[] = [
    {
      amount_minor: dipakai,
      purpose: 'pelunasan_piutang',
      bearer_type: 'saya',
      receivable_id: receivableId,
      note: 'Pelunasan piutang — bukan pemasukan baru.',
    },
  ];
  if (kelebihan > 0) {
    allocations.push({
      amount_minor: kelebihan,
      purpose: 'pemasukan',
      bearer_type: 'saya',
      note: 'Kelebihan di atas sisa piutang dicatat sebagai pemasukan.',
    });
  }
  resplitCashEvent(cashEventId, allocations, actor, database);
  konfirmasiTransaksi(cashEventId, database);

  const sisaAkhir = sisa - dipakai;
  return {
    pesan:
      `Piutang berkurang ${formatIDR(dipakai)}. Sisa piutang ${formatIDR(sisaAkhir)}.` +
      (kelebihan > 0 ? ` Kelebihan ${formatIDR(kelebihan)} dicatat sebagai pemasukan.` : ''),
  };
}

export function jadikanTransferSendiri(
  cashEventId: number,
  opts: { ke_tabungan?: boolean; actor?: string } = {},
  database: DB = db(),
): { pesan: string } {
  const ev = getCashEvent(cashEventId, database);
  if (!ev) throw new Error(`Transaksi ${cashEventId} tidak ditemukan.`);
  const actor = opts.actor ?? 'telegram';
  const kind = opts.ke_tabungan ? 'setoran_tabungan' : 'transfer_internal';
  recategorize(cashEventId, { kind }, actor, database);
  resplitCashEvent(
    cashEventId,
    [
      {
        amount_minor: ev.amount_minor,
        purpose: opts.ke_tabungan ? 'tabungan' : 'transfer_internal',
        bearer_type: 'saya',
        note: 'Perpindahan uang saya sendiri — bukan pengeluaran dan bukan pendapatan.',
      },
    ],
    actor,
    database,
  );
  const match = matchInternalTransfer(cashEventId, 3, database);
  return {
    pesan: match.matched
      ? 'Dicatat sebagai transfer antar rekening saya; kedua sisi sudah cocok.'
      : 'Dicatat sebagai transfer antar rekening saya. Sisi pasangan belum terlihat, ditandai menunggu pasangan.',
  };
}

export function jadikanHadiah(
  cashEventId: number,
  actor = 'telegram',
  database: DB = db(),
): { pesan: string } {
  const ev = getCashEvent(cashEventId, database);
  if (!ev) throw new Error(`Transaksi ${cashEventId} tidak ditemukan.`);
  const kategoriHadiah = database.prepare(`SELECT id FROM category WHERE slug = 'hadiah'`).get() as
    | { id: number }
    | undefined;
  recategorize(cashEventId, { kind: 'hadiah', category_id: kategoriHadiah?.id ?? null }, actor, database);
  resplitCashEvent(
    cashEventId,
    [
      {
        amount_minor: ev.amount_minor,
        purpose: 'biaya_pribadi',
        bearer_type: 'saya',
        category_id: kategoriHadiah?.id ?? null,
        note: 'Hadiah untuk orang lain, tetap biaya pribadi saya.',
      },
    ],
    actor,
    database,
  );
  konfirmasiTransaksi(cashEventId, database);
  return { pesan: 'Dicatat sebagai hadiah — tetap pengeluaran pribadiku, bukan piutang.' };
}

export function jadikanTalangan(
  cashEventId: number,
  nama: string | null,
  actor = 'telegram',
  database: DB = db(),
): { pesan: string } {
  const ev = getCashEvent(cashEventId, database);
  if (!ev) throw new Error(`Transaksi ${cashEventId} tidak ditemukan.`);
  recategorize(cashEventId, { kind: 'talangan' }, actor, database);
  resplitCashEvent(
    cashEventId,
    [
      {
        amount_minor: ev.amount_minor,
        purpose: 'piutang_teman',
        bearer_type: 'teman',
        bearer_person_id: personId('teman', nama ?? 'Teman', database),
        category_id: ev.category_id,
        note: 'Talangan — harus dibayar kembali.',
      },
    ],
    actor,
    database,
  );
  konfirmasiTransaksi(cashEventId, database);
  return {
    pesan: `Uang keluar ${formatIDR(ev.amount_minor)} dan piutang ${formatIDR(ev.amount_minor)} dicatat.`,
  };
}

/** Terapkan jawaban atas sebuah keputusan dari Telegram atau web. */
export function applyDecision(
  decisionId: number,
  optionId: string,
  extra: Record<string, unknown> = {},
  actor = 'telegram',
  database: DB = db(),
): ApplyResult {
  const d: DecisionRow | undefined = getDecision(decisionId, database);
  if (!d) return { ok: false, pesan: 'Pertanyaan itu sudah tidak ada.' };
  if (d.state === 'dijawab') return { ok: false, pesan: 'Pertanyaan itu sudah dijawab.' };

  const opsi = JSON.parse(d.options_json) as Array<{ id: string; payload?: Record<string, unknown> }>;
  const payload = { ...(opsi.find((o) => o.id === optionId)?.payload ?? {}), ...extra };

  const selesai = (pesan: string, lanjutan?: Lanjutan): ApplyResult => {
    answerDecision(decisionId, { optionId, payload }, actor, database);
    return { ok: true, pesan, lanjutan };
  };

  try {
    switch (d.kind) {
      case 'kategori_transaksi': {
        const id = d.cash_event_id;
        if (!id) return { ok: false, pesan: 'Transaksi terkait tidak ditemukan.' };
        switch (optionId) {
          case 'benar':
            konfirmasiTransaksi(id, database);
            return selesai('Oke, dikunci sebagai benar.');
          case 'ganti_kategori':
            return { ok: true, pesan: 'Pilih kategorinya:', lanjutan: { tipe: 'pilih_kategori', cash_event_id: id } };
          case 'bagi_biaya': {
            const ev = getCashEvent(id, database);
            return {
              ok: true,
              pesan:
                `Total ${formatIDR(ev?.amount_minor ?? 0)}. Tulis pembagiannya, misalnya ` +
                '"aku 30rb, 3 teman" atau "berempat".',
              lanjutan: { tipe: 'input_bagi_biaya', cash_event_id: id, nominal_minor: ev?.amount_minor ?? 0 },
            };
          }
          case 'reimburse':
            jadikanReimburseCompany(id, { actor }, database);
            return selesai('Dicatat sebagai klaim reimburse company. Saldoku turun sampai uangnya kembali.');
          case 'transfer_sendiri': {
            const r = jadikanTransferSendiri(id, { ke_tabungan: Boolean(payload['ke_tabungan']), actor }, database);
            return selesai(r.pesan);
          }
          case 'hadiah': {
            const r = jadikanHadiah(id, actor, database);
            return selesai(r.pesan);
          }
          case 'lainnya':
            return {
              ok: true,
              pesan: 'Pilih salah satu:',
              lanjutan: { tipe: 'pilih_opsi_bebas', cash_event_id: id },
            };
          default:
            return { ok: false, pesan: 'Pilihan itu belum dikenali.' };
        }
      }

      case 'reimburse': {
        const id = d.cash_event_id;
        if (!id) return { ok: false, pesan: 'Transaksi terkait tidak ditemukan.' };
        if (optionId === 'bukan') {
          recategorize(id, { kind: 'pemasukan_luar' }, actor, database);
          resplitCashEvent(
            id,
            [
              {
                amount_minor: getCashEvent(id, database)!.amount_minor,
                purpose: 'pemasukan',
                bearer_type: 'saya',
              },
            ],
            actor,
            database,
          );
          konfirmasiTransaksi(id, database);
          return selesai('Dicatat sebagai pemasukan biasa.');
        }
        if (optionId === 'topup') {
          const ev = getCashEvent(id, database)!;
          const rencana = database
            .prepare(
              `SELECT id FROM topup_plan WHERE status = 'rencana'
                ORDER BY abs(julianday(plan_date) - julianday(?)) LIMIT 1`,
            )
            .get(dateOf(ev.occurred_at)) as { id: number } | undefined;
          if (rencana) {
            setTopupStatus(
              rencana.id,
              'diterima',
              { actual_amount_minor: ev.amount_minor, actual_date: dateOf(ev.occurred_at), cash_event_id: id, actor },
              database,
            );
          }
          recategorize(id, { kind: 'pemasukan_luar' }, actor, database);
          konfirmasiTransaksi(id, database);
          return selesai(
            rencana
              ? 'Dicatat sebagai top-up yang sudah diterima; proyeksi dihitung ulang.'
              : 'Dicatat sebagai top-up. Tidak ada rencana top-up yang cocok untuk dipasangkan.',
          );
        }
        const m = optionId.match(/^piutang_(\d+)$/);
        if (m) {
          const r = jadikanPelunasanPiutang(id, Number(m[1]), actor, database);
          return selesai(r.pesan);
        }
        return { ok: false, pesan: 'Pilihan itu belum dikenali.' };
      }

      case 'konfirmasi_topup': {
        const topupId = d.topup_plan_id;
        if (!topupId) return { ok: false, pesan: 'Rencana top-up tidak ditemukan.' };
        if (optionId === 'tidak_diterima') {
          setTopupStatus(topupId, 'tidak_diterima', { actor }, database);
          return selesai('Ditandai tidak diterima. Proyeksi sudah dihitung ulang tanpa top-up itu.');
        }
        if (optionId === 'diterima_penuh') {
          setTopupStatus(topupId, 'diterima', { actor }, database);
          return selesai('Ditandai diterima penuh.');
        }
        if (optionId === 'diterima_sebagian') {
          const nominal = Number(payload['nominal_minor'] ?? 0);
          if (!nominal) {
            return {
              ok: true,
              pesan: 'Berapa yang benar-benar masuk? Tulis nominalnya.',
              lanjutan: { tipe: 'input_nominal', topup_plan_id: topupId },
            };
          }
          setTopupStatus(topupId, 'diterima', { actual_amount_minor: nominal, actor }, database);
          return selesai(`Ditandai masuk ${formatIDR(nominal)}; nilai aktual dipakai untuk masa lalu.`);
        }
        return { ok: false, pesan: 'Pilihan itu belum dikenali.' };
      }

      case 'konfirmasi_kuitansi': {
        const akun = optionId.match(/^akun_(\d+)$/);
        if (akun && d.cash_event_id) {
          database
            .prepare(
              `UPDATE cash_event SET account_id = ?, status = 'terkonfirmasi', updated_at = ? WHERE id = ?`,
            )
            .run(Number(akun[1]), nowIso(), d.cash_event_id);
          writeAudit(
            {
              entity: 'cash_event',
              entity_id: d.cash_event_id,
              action: 'rekening_dikonfirmasi',
              actor,
              after: { account_id: Number(akun[1]) },
            },
            database,
          );
          return selesai('Rekening pendebitan dicatat; pembayaran ini sekarang ikut memotong saldo.');
        }
        const tx = optionId.match(/^tx_(\d+)$/);
        if (tx && d.invoice_id) {
          database
            .prepare(`UPDATE cash_event SET invoice_id = ?, updated_at = ? WHERE id = ?`)
            .run(d.invoice_id, nowIso(), Number(tx[1]));
          return selesai('Kuitansi ditautkan ke transaksi yang kamu pilih.');
        }
        return { ok: false, pesan: 'Pilihan itu belum dikenali.' };
      }

      case 'verifikasi_langganan': {
        const svc = optionId.match(/^service_(\d+)$/);
        if (svc && d.invoice_id) {
          database
            .prepare(`UPDATE invoice SET service_id = ?, updated_at = ? WHERE id = ?`)
            .run(Number(svc[1]), nowIso(), d.invoice_id);
          return selesai('Tagihan sudah dihubungkan ke layanan yang benar.');
        }
        if (optionId === 'sudah_dibayar' && d.invoice_id) {
          return selesai(
            'Dicatat. Kalau kuitansinya ada di email, sinkronisasi berikutnya akan menautkannya otomatis.',
          );
        }
        if (optionId === 'belum' && d.invoice_id) {
          database
            .prepare(`UPDATE invoice SET status = 'jatuh_tempo', updated_at = ? WHERE id = ?`)
            .run(nowIso(), d.invoice_id);
          return selesai('Tetap dihitung sebagai kewajiban yang belum dibayar.');
        }
        if (optionId === 'dihentikan' && d.invoice_id) {
          database
            .prepare(`UPDATE invoice SET status = 'dibatalkan', updated_at = ? WHERE id = ?`)
            .run(nowIso(), d.invoice_id);
          return selesai('Tagihan ditandai dibatalkan dan tidak lagi masuk proyeksi.');
        }
        return { ok: false, pesan: 'Pilihan itu belum dikenali.' };
      }

      case 'asumsi_awal': {
        if (optionId === 'abaikan') return selesai('Oke, diabaikan.');
        if (optionId === 'pakai') {
          const akunId = Number(payload['account_id'] ?? 0);
          const saldo = Number(payload['balance_minor'] ?? 0);
          const asOf = String(payload['as_of'] ?? `${today()}T00:00:00+07:00`);
          if (!akunId || !saldo) {
            return { ok: false, pesan: 'Rekening dan nominal saldo harus jelas dulu.' };
          }
          recordReconciliation(
            {
              account_id: akunId,
              as_of: asOf,
              statement_balance_minor: saldo,
              source: 'telegram',
              note: 'Dikonfirmasi lewat Telegram.',
            },
            database,
          );
          return selesai(`Saldo terkonfirmasi ${formatIDR(saldo)} dicatat sebagai titik tambat.`);
        }
        return { ok: false, pesan: 'Pilihan itu belum dikenali.' };
      }

      default:
        return { ok: false, pesan: 'Jenis pertanyaan ini belum punya penanganan otomatis.' };
    }
  } catch (err) {
    return { ok: false, pesan: `Gagal: ${(err as Error).message}` };
  }
}
