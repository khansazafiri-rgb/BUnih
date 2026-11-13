import crypto from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { dateOf, isValidDate, nowIso, toJakartaInstant } from './time.js';
import {
  recategorize, recordCashEvent, getCashEvent, LedgerError, type AllocationInput, type EvidenceLink,
} from './ledger.js';
import { ensurePerson } from './people.js';
import { jadikanPelunasanPiutang } from './applyDecision.js';
import { getCategory } from './categories.js';
import { resolveMerchant } from './merchants.js';
import { normalizeMerchant } from './merchantNorm.js';
import { writeAudit } from './audit.js';
import type { CashKind } from './types.js';

export class TransaksiError extends Error {}

export type Penanggung = 'saya' | 'hadiah' | 'company_bayar_dulu' | 'company_langsung' | 'talangan';

export type TransaksiBaru = {
  jenis: 'pengeluaran' | 'pemasukan' | 'refund' | 'transfer_sendiri' | 'tabungan';
  jumlah_minor: number;
  /** "YYYY-MM-DD" atau "YYYY-MM-DDTHH:mm". Kosong = sekarang. */
  waktu?: string;
  rekening_id?: number | null;
  tunai?: boolean;
  merchant?: string | null;
  kategori_id?: number | null;
  catatan?: string | null;
  proyek?: string | null;
  referensi?: string | null;
  penanggung?: Penanggung;
  /** Bagian yang memang menjadi pengeluaran pribadiku, bila sisanya ditanggung orang lain/company. */
  bagian_saya_minor?: number | null;
  /** Memecah satu transaksi ke beberapa kategori. */
  pembagian_kategori?: Array<{ kategori_id: number | null; jumlah_minor: number }>;
  /** Patungan atau talangan: siapa saja yang akan mengganti dan berapa. */
  orang?: Array<{ nama: string; jumlah_minor: number }>;
  melunasi_piutang_id?: number | null;
  tujuan_rekening_id?: number | null;
  bukti?: EvidenceLink[];
};

export type HasilTransaksi = {
  id: number;
  ids: number[];
  dibuat: boolean;
  pesan: string[];
};

const KOTAK_KATEGORI = (database: DB, id: number | null | undefined) => {
  if (id === null || id === undefined) return;
  const kat = getCategory(id, database);
  if (!kat) throw new TransaksiError('Kategori tidak ditemukan.');
  if (!kat.active) throw new TransaksiError(`Kategori "${kat.name}" sudah dinonaktifkan.`);
};

function waktuLengkap(waktu: string | undefined): string {
  if (!waktu) return nowIso();
  if (/^\d{4}-\d{2}-\d{2}$/.test(waktu)) {
    if (!isValidDate(waktu)) throw new TransaksiError('Tanggal tidak valid.');
    return `${waktu}T${nowIso().slice(11, 19)}+07:00`;
  }
  try {
    const t = toJakartaInstant(waktu.length === 16 ? `${waktu}:00` : waktu);
    if (!isValidDate(t.slice(0, 10))) throw new Error('x');
    return t;
  } catch {
    throw new TransaksiError('Waktu tidak valid.');
  }
}

function akunSaya(database: DB, id: number | null | undefined) {
  if (id === null || id === undefined) return null;
  const row = database.prepare(`SELECT id, name, is_savings_target, is_mine FROM account WHERE id = ? AND active = 1`).get(id) as
    | { id: number; name: string; is_savings_target: number; is_mine: number }
    | undefined;
  if (!row) throw new TransaksiError('Rekening tidak ditemukan.');
  if (!row.is_mine) throw new TransaksiError('Rekening ini bukan milikku.');
  return row;
}

function jumlah(arr: Array<{ jumlah_minor: number }>): number {
  return arr.reduce((s, x) => s + x.jumlah_minor, 0);
}

/**
 * Catat transaksi dari web atau Telegram dengan semua pembagian peran yang mungkin:
 * siapa yang membayar lebih dulu, siapa penanggung akhir, kategori, dan orang yang akan mengganti.
 *
 * Satu rupiah tetap hanya punya satu makna: yang keluar dari rekening dicatat sekali, lalu
 * dipecah menjadi potongan (pribadi, piutang, company) yang jumlahnya WAJIB sama dengan nominalnya.
 */
export function buatTransaksi(
  input: TransaksiBaru,
  actor = 'web',
  database: DB = db(),
): HasilTransaksi {
  if (!Number.isInteger(input.jumlah_minor) || input.jumlah_minor <= 0) {
    throw new TransaksiError('Nominal harus berupa angka bulat lebih dari nol.');
  }
  const run = database.transaction((): HasilTransaksi => {
    const waktu = waktuLengkap(input.waktu);
    KOTAK_KATEGORI(database, input.kategori_id);
    for (const p of input.pembagian_kategori ?? []) KOTAK_KATEGORI(database, p.kategori_id);

    const dasar = {
      occurred_at: waktu,
      merchant_raw: input.merchant?.trim() || null,
      reference_no: input.referensi?.trim() || null,
      project: input.proyek?.trim() || null,
      note: input.catatan?.trim() || null,
      source: 'manual' as const,
      actor,
      evidence: input.bukti,
    };

    /* ----------------------------------------------------------- transfer / tabungan */
    if (input.jenis === 'transfer_sendiri' || input.jenis === 'tabungan') {
      const asal = akunSaya(database, input.rekening_id);
      if (!asal) throw new TransaksiError('Pilih rekening asal.');
      let tujuan = akunSaya(database, input.tujuan_rekening_id);
      if (!tujuan && input.jenis === 'tabungan') {
        const t = database
          .prepare(`SELECT id FROM account WHERE is_mine = 1 AND is_savings_target = 1 AND active = 1 AND id <> ? ORDER BY id LIMIT 1`)
          .get(asal.id) as { id: number } | undefined;
        tujuan = akunSaya(database, t?.id);
      }
      if (!tujuan) throw new TransaksiError('Pilih rekening tujuan.');
      if (tujuan.id === asal.id) throw new TransaksiError('Rekening asal dan tujuan harus berbeda.');

      const token = `tf-${crypto.randomUUID().slice(0, 8)}`;
      const kindKeluar: CashKind = tujuan.is_savings_target
        ? 'setoran_tabungan'
        : asal.is_savings_target
          ? 'penarikan_tabungan'
          : 'transfer_internal';
      const keluar = recordCashEvent(
        { ...dasar, direction: 'keluar', amount_minor: input.jumlah_minor, account_id: asal.id, kind: kindKeluar, reference_no: `${token}-keluar`, merchant_raw: `Transfer ke ${tujuan.name}` },
        database,
      );
      const masuk = recordCashEvent(
        { ...dasar, direction: 'masuk', amount_minor: input.jumlah_minor, account_id: tujuan.id, kind: 'transfer_internal', reference_no: `${token}-masuk`, merchant_raw: `Transfer dari ${asal.name}`, evidence: undefined },
        database,
      );
      const dicocokkan = !!getCashEvent(keluar.id, database)?.transfer_group_id;
      return {
        id: keluar.id,
        ids: [keluar.id, masuk.id],
        dibuat: true,
        pesan: [
          dicocokkan
            ? `Perpindahan uang ke ${tujuan.name} dicatat sebagai satu transfer (bukan pengeluaran dan bukan pemasukan).`
            : 'Transfer dicatat, tetapi kedua sisinya belum cocok.',
        ],
      };
    }

    /* ----------------------------------------------------------- pemasukan */
    if (input.jenis === 'pemasukan') {
      const akun = input.tunai ? null : akunSaya(database, input.rekening_id);
      if (!akun && !input.tunai) throw new TransaksiError('Pilih rekening penerima atau tandai tunai.');
      const res = recordCashEvent(
        { ...dasar, direction: 'masuk', amount_minor: input.jumlah_minor, account_id: akun?.id ?? null, is_cash: !akun, kind: 'pemasukan_luar', category_id: input.kategori_id ?? null },
        database,
      );
      const pesan = [...res.pesan];
      if (input.melunasi_piutang_id) {
        const r = jadikanPelunasanPiutang(res.id, input.melunasi_piutang_id, actor, database);
        pesan.push(r.pesan);
      }
      return { id: res.id, ids: [res.id], dibuat: res.created, pesan };
    }

    /* ----------------------------------------------------------- refund */
    if (input.jenis === 'refund') {
      const akun = input.tunai ? null : akunSaya(database, input.rekening_id);
      if (!akun && !input.tunai) throw new TransaksiError('Pilih rekening penerima atau tandai tunai.');
      const res = recordCashEvent(
        { ...dasar, direction: 'masuk', amount_minor: input.jumlah_minor, account_id: akun?.id ?? null, is_cash: !akun, kind: 'refund', category_id: input.kategori_id ?? null },
        database,
      );
      return { id: res.id, ids: [res.id], dibuat: res.created, pesan: [...res.pesan, 'Refund mengurangi pengeluaran, bukan menambah pemasukan.'] };
    }

    /* ----------------------------------------------------------- pengeluaran */
    const penanggung: Penanggung = input.penanggung ?? 'saya';
    const langsung = penanggung === 'company_langsung';
    const akun = langsung || input.tunai ? null : akunSaya(database, input.rekening_id);
    if (!akun && !langsung && !input.tunai) throw new TransaksiError('Pilih rekening pembayar atau tandai tunai.');

    const adaOrang = (input.orang?.length ?? 0) > 0;
    const adaSplit = (input.pembagian_kategori?.length ?? 0) > 0;
    if (adaOrang && adaSplit) throw new TransaksiError('Pembagian kategori dan pembagian dengan orang belum bisa digabung dalam satu transaksi.');

    if (adaSplit) {
      if (jumlah(input.pembagian_kategori!) !== input.jumlah_minor) {
        throw new TransaksiError('Jumlah semua pembagian kategori harus sama persis dengan nominal transaksi.');
      }
      if (input.pembagian_kategori!.some((p) => !Number.isInteger(p.jumlah_minor) || p.jumlah_minor <= 0)) {
        throw new TransaksiError('Setiap bagian harus lebih dari nol.');
      }
    }

    let kind: CashKind;
    let allocations: AllocationInput[];
    const company = ensurePerson('company', null, database);

    const potong = (purpose: AllocationInput['purpose'], bearer: AllocationInput['bearer_type'], personId?: number | null, catatan?: string): AllocationInput[] =>
      adaSplit
        ? input.pembagian_kategori!.map((p) => ({ amount_minor: p.jumlah_minor, purpose, bearer_type: bearer, bearer_person_id: personId ?? null, category_id: p.kategori_id, note: catatan }))
        : [{ amount_minor: input.jumlah_minor, purpose, bearer_type: bearer, bearer_person_id: personId ?? null, category_id: input.kategori_id ?? null, note: catatan }];

    if (adaOrang) {
      const orang = input.orang!;
      if (orang.some((o) => !o.nama.trim() || !Number.isInteger(o.jumlah_minor) || o.jumlah_minor <= 0)) {
        throw new TransaksiError('Setiap orang harus punya nama dan nominal lebih dari nol.');
      }
      const totalOrang = jumlah(orang);
      const bagianSaya = input.bagian_saya_minor ?? input.jumlah_minor - totalOrang;
      if (bagianSaya < 0 || bagianSaya + totalOrang !== input.jumlah_minor) {
        throw new TransaksiError(
          `Pembagian tidak pas: bagianku ${bagianSaya} + orang lain ${totalOrang} harus sama dengan ${input.jumlah_minor}.`,
        );
      }
      kind = bagianSaya === 0 || penanggung === 'talangan' ? 'talangan' : 'pengeluaran_bersama';
      allocations = [];
      if (bagianSaya > 0) allocations.push({ amount_minor: bagianSaya, purpose: 'biaya_pribadi', bearer_type: 'saya', category_id: input.kategori_id ?? null, note: 'Bagian saya.' });
      for (const o of orang) {
        allocations.push({
          amount_minor: o.jumlah_minor,
          purpose: 'piutang_teman',
          bearer_type: 'teman',
          bearer_person_id: ensurePerson('teman', o.nama, database),
          category_id: input.kategori_id ?? null,
          note: `Bagian ${o.nama.trim()}, akan diganti.`,
        });
      }
    } else if (penanggung === 'company_langsung') {
      kind = 'pengeluaran_company_langsung';
      allocations = potong('biaya_company_langsung', 'company', company, 'Dibayar langsung oleh company.');
    } else if (penanggung === 'company_bayar_dulu') {
      kind = 'pengeluaran_reimburse_company';
      const bagianSaya = input.bagian_saya_minor ?? 0;
      if (bagianSaya < 0 || bagianSaya >= input.jumlah_minor) throw new TransaksiError('Bagianku harus kurang dari total.');
      if (bagianSaya > 0) {
        if (adaSplit) throw new TransaksiError('Bagian pribadi belum bisa digabung dengan pembagian kategori.');
        allocations = [
          { amount_minor: input.jumlah_minor - bagianSaya, purpose: 'piutang_company', bearer_type: 'company', bearer_person_id: company, category_id: input.kategori_id ?? null, note: 'Saya bayar dulu, akan direimburse company.' },
          { amount_minor: bagianSaya, purpose: 'biaya_pribadi', bearer_type: 'saya', category_id: input.kategori_id ?? null },
        ];
      } else {
        allocations = potong('piutang_company', 'company', company, 'Saya bayar dulu, akan direimburse company.');
      }
    } else if (penanggung === 'talangan') {
      kind = 'talangan';
      allocations = potong('piutang_teman', 'teman', ensurePerson('teman', 'Teman', database), 'Talangan — harus dibayar kembali.');
    } else if (penanggung === 'hadiah') {
      kind = 'hadiah';
      allocations = potong('biaya_pribadi', 'saya', null, 'Hadiah untuk orang lain, tetap biaya pribadiku.');
    } else {
      kind = 'pengeluaran_pribadi';
      allocations = potong('biaya_pribadi', 'saya');
    }

    const res = recordCashEvent(
      {
        ...dasar,
        direction: 'keluar',
        amount_minor: input.jumlah_minor,
        account_id: akun?.id ?? null,
        is_cash: !akun && !langsung,
        kind,
        category_id: input.kategori_id ?? (adaSplit ? (input.pembagian_kategori![0]?.kategori_id ?? null) : null),
        allocations,
        status: 'terkonfirmasi',
      },
      database,
    );
    return { id: res.id, ids: [res.id], dibuat: res.created, pesan: res.pesan };
  });
  return run();
}

export type UbahTransaksi = {
  waktu?: string;
  merchant?: string | null;
  catatan?: string | null;
  proyek?: string | null;
  kategori_id?: number | null;
  rekening_id?: number | null;
  jumlah_minor?: number;
  /** Simpan kategori ini sebagai kategori bawaan merchant transaksi ini. */
  ingat_untuk_merchant?: boolean;
};

/**
 * Edit transaksi dengan jejak audit. Bukti dan transaksi aslinya tidak dihapus.
 * Mengubah nominal hanya diizinkan untuk transaksi tanpa bukti bank dan tanpa pembagian;
 * selain itu pakai koreksi terpisah supaya bukti bank tetap cocok dengan catatannya.
 */
export function ubahTransaksi(
  id: number,
  patch: UbahTransaksi,
  actor = 'web',
  database: DB = db(),
): { perubahan: string[] } {
  const run = database.transaction(() => {
    const before = getCashEvent(id, database);
    if (!before) throw new TransaksiError('Transaksi tidak ditemukan.');
    const perubahan: string[] = [];
    const at = nowIso();

    if (patch.jumlah_minor !== undefined && patch.jumlah_minor !== before.amount_minor) {
      if (!Number.isInteger(patch.jumlah_minor) || patch.jumlah_minor <= 0) throw new TransaksiError('Nominal harus lebih dari nol.');
      const buktiBank = database
        .prepare(`SELECT COUNT(*) AS n FROM cash_event_evidence WHERE cash_event_id = ? AND role IN ('notifikasi_bank','mutasi','kuitansi')`)
        .get(id) as { n: number };
      const potongan = database.prepare(`SELECT id FROM allocation WHERE cash_event_id = ?`).all(id) as Array<{ id: number }>;
      const pelunasan = database.prepare(`SELECT COUNT(*) AS n FROM receivable_settlement WHERE cash_event_id = ?`).get(id) as { n: number };
      const punyaPiutang = database
        .prepare(`SELECT COUNT(*) AS n FROM receivable r JOIN allocation a ON a.id = r.allocation_id WHERE a.cash_event_id = ?`)
        .get(id) as { n: number };
      if (buktiBank.n > 0) throw new TransaksiError('Transaksi ini punya bukti dari bank, jadi nominalnya tidak boleh diubah. Buat koreksi terpisah.');
      if (potongan.length !== 1 || pelunasan.n > 0 || punyaPiutang.n > 0) {
        throw new TransaksiError('Transaksi ini terbagi atau terkait piutang. Bagi ulang dulu sebelum mengubah nominal.');
      }
      database.prepare(`UPDATE allocation SET amount_minor = ? WHERE id = ?`).run(patch.jumlah_minor, potongan[0]!.id);
      database.prepare(`UPDATE cash_event SET amount_minor = ?, updated_at = ? WHERE id = ?`).run(patch.jumlah_minor, at, id);
      perubahan.push('nominal');
    }

    if (patch.waktu !== undefined) {
      const t = waktuLengkap(patch.waktu);
      database.prepare(`UPDATE cash_event SET occurred_at = ?, updated_at = ? WHERE id = ?`).run(t, at, id);
      perubahan.push('waktu');
    }

    if (patch.rekening_id !== undefined && patch.rekening_id !== before.account_id) {
      if (before.transfer_group_id) throw new TransaksiError('Rekening transfer antar rekening tidak bisa diubah.');
      const akun = akunSaya(database, patch.rekening_id);
      database
        .prepare(`UPDATE cash_event SET account_id = ?, is_cash = ?, updated_at = ? WHERE id = ?`)
        .run(akun?.id ?? null, akun ? 0 : 1, at, id);
      perubahan.push('rekening');
    }

    let merchantId = before.merchant_id;
    if (patch.merchant !== undefined) {
      const nama = patch.merchant?.trim() || null;
      const m = nama ? resolveMerchant(nama, database) : null;
      merchantId = m?.id ?? null;
      database
        .prepare(`UPDATE cash_event SET merchant_raw = ?, merchant_norm = ?, merchant_id = ?, updated_at = ? WHERE id = ?`)
        .run(nama, normalizeMerchant(nama), merchantId, at, id);
      perubahan.push('merchant');
    }

    if (patch.catatan !== undefined || patch.proyek !== undefined) {
      recategorize(
        id,
        {
          ...(patch.catatan !== undefined ? { note: patch.catatan } : {}),
          ...(patch.proyek !== undefined ? { project: patch.proyek?.trim() || null } : {}),
        },
        actor,
        database,
      );
      if (patch.catatan !== undefined) perubahan.push('catatan');
      if (patch.proyek !== undefined) perubahan.push('proyek');
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'kategori_id')) {
      KOTAK_KATEGORI(database, patch.kategori_id);
      recategorize(id, { category_id: patch.kategori_id ?? null }, actor, database);
      perubahan.push('kategori');
      if (patch.ingat_untuk_merchant && merchantId && patch.kategori_id) {
        database
          .prepare(`UPDATE merchant SET default_category_id = ?, updated_at = ? WHERE id = ?`)
          .run(patch.kategori_id, at, merchantId);
        perubahan.push('kategori bawaan merchant');
      }
    }

    if (perubahan.length) {
      writeAudit(
        {
          entity: 'cash_event',
          entity_id: id,
          action: 'diedit',
          actor,
          before: { amount_minor: before.amount_minor, occurred_at: before.occurred_at, merchant_raw: before.merchant_raw, category_id: before.category_id, account_id: before.account_id },
          after: { ...patch, perubahan },
        },
        database,
      );
    }
    void dateOf;
    void LedgerError;
    return { perubahan };
  });
  return run();
}
