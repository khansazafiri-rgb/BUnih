import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { today } from '../domain/time.js';
import { analitik, rincian } from '../domain/analytics.js';
import { ringkasanDashboard, setSetting, getSetting } from '../domain/dashboard.js';
import {
  CategoryError, createCategory, deactivateCategory, listCategoryTree, updateCategory,
} from '../domain/categories.js';
import {
  MerchantError, addAlias, listMerchants, mergeMerchants, removeAlias, renameMerchant, resolveMerchant,
  setMerchantDefaultCategory,
} from '../domain/merchants.js';
import {
  BudgetError, budgetRevisions, createBudget, listBudgets, reviseBudget, updateBudget,
} from '../domain/budgets.js';
import {
  GoalError, addContribution, createGoal, goalContributions, listGoals, updateGoal,
} from '../domain/goals.js';
import { TransaksiError, buatTransaksi, ubahTransaksi } from '../domain/manualTx.js';
import { LedgerError } from '../domain/ledger.js';
import { rebuildObligations } from '../domain/obligations.js';

const TANGGAL = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function bungkus(handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const hasil = await handler(req, res);
      if (!res.headersSent && hasil !== undefined) res.json(hasil);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof z.ZodError) {
        const pertama = err.issues[0];
        res.status(400).json({ error: 'tidak_valid', pesan: `${pertama?.path.join('.') || 'Isian'}: ${pertama?.message ?? 'tidak valid'}` });
        return;
      }
      const domain =
        err instanceof CategoryError || err instanceof MerchantError || err instanceof BudgetError ||
        err instanceof GoalError || err instanceof TransaksiError || err instanceof LedgerError;
      res.status(domain ? 400 : 500).json({ error: domain ? 'ditolak' : 'galat_server', pesan: (err as Error).message });
    }
  };
}

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new TransaksiError('Id tidak valid.');
  return n;
};

export function buatRouterV2(): Router {
  const r = Router();

  /* ----------------------------------------------------------- dashboard & analitik */
  r.get('/dashboard', bungkus(() => ringkasanDashboard(db())));
  r.post(
    '/onboarding/tutup',
    bungkus(() => {
      setSetting('onboarding_ditutup', true, db());
      return { ok: true };
    }),
  );
  r.post(
    '/onboarding/buka',
    bungkus(() => {
      setSetting('onboarding_ditutup', false, db());
      return { ok: true, ditutup: getSetting('onboarding_ditutup', false, db()) };
    }),
  );

  r.get(
    '/analitik',
    bungkus((req) => {
      const q = z.object({ preset: z.string().optional(), dari: TANGGAL.optional(), sampai: TANGGAL.optional() }).parse(req.query);
      return analitik(q, db());
    }),
  );

  r.get(
    '/analitik/rincian',
    bungkus((req) => {
      const q = z
        .object({
          dari: TANGGAL,
          sampai: TANGGAL,
          kategori: z.coerce.number().int().optional(),
          tanpa_kategori: z.string().optional(),
          merchant: z.coerce.number().int().optional(),
          makanan: z.string().optional(),
          jenis: z.enum(['berulang', 'sesuka']).optional(),
          proyek: z.string().optional(),
        })
        .parse(req.query);
      return rincian(
        {
          dari: q.dari,
          sampai: q.sampai,
          kategori_id: q.kategori,
          tanpa_kategori: q.tanpa_kategori === '1',
          merchant_id: q.merchant,
          makanan: q.makanan === '1',
          jenis: q.jenis,
          proyek: q.proyek,
        },
        db(),
      );
    }),
  );

  /* ----------------------------------------------------------- kategori */
  r.get(
    '/kategori',
    bungkus((req) => {
      const semua = req.query['semua'] === '1';
      return db()
        .prepare(`SELECT * FROM category ${semua ? '' : 'WHERE active = 1'} ORDER BY sort_order, name`)
        .all();
    }),
  );
  r.get('/kategori/pohon', bungkus((req) => listCategoryTree({ termasukNonaktif: req.query['semua'] === '1' }, db())));
  r.post(
    '/kategori',
    bungkus((req) => {
      const b = z
        .object({
          name: z.string().min(2),
          parent_id: z.number().int().nullable().optional(),
          group_name: z.string().optional(),
          icon: z.string().max(8).nullable().optional(),
          is_routine: z.boolean().optional(),
        })
        .parse(req.body);
      return { id: createCategory(b, 'web', db()) };
    }),
  );
  r.patch(
    '/kategori/:id',
    bungkus((req) => {
      const b = z
        .object({
          name: z.string().optional(),
          parent_id: z.number().int().nullable().optional(),
          group_name: z.string().optional(),
          icon: z.string().max(8).nullable().optional(),
          is_routine: z.boolean().optional(),
          active: z.boolean().optional(),
          sort_order: z.number().int().optional(),
        })
        .parse(req.body);
      updateCategory(id(req), b, 'web', db());
      return { ok: true };
    }),
  );
  r.delete(
    '/kategori/:id',
    bungkus((req) => {
      deactivateCategory(id(req), 'web', db());
      return { ok: true, pesan: 'Kategori dinonaktifkan. Transaksi lama tetap tersimpan dengan kategorinya.' };
    }),
  );

  /* ----------------------------------------------------------- merchant */
  r.get(
    '/merchant',
    bungkus((req) => {
      const q = z.object({ cari: z.string().optional(), semua: z.string().optional() }).parse(req.query);
      return listMerchants({ cari: q.cari, termasukNonaktif: q.semua === '1' }, db());
    }),
  );
  r.get('/merchant/saran', bungkus(() =>
    db().prepare(`SELECT id, name FROM merchant WHERE active = 1 ORDER BY (SELECT COUNT(*) FROM cash_event WHERE merchant_id = merchant.id) DESC, name LIMIT 60`).all(),
  ));
  r.post(
    '/merchant',
    bungkus((req) => {
      const b = z.object({ name: z.string().min(2) }).parse(req.body);
      const m = resolveMerchant(b.name, db());
      if (!m) throw new MerchantError('Nama merchant tidak valid.');
      return m;
    }),
  );
  r.patch(
    '/merchant/:id',
    bungkus((req) => {
      const b = z.object({ name: z.string().optional(), default_category_id: z.number().int().nullable().optional() }).parse(req.body);
      if (b.name !== undefined) renameMerchant(id(req), b.name, 'web', db());
      if (b.default_category_id !== undefined) setMerchantDefaultCategory(id(req), b.default_category_id, 'web', db());
      return { ok: true };
    }),
  );
  r.post(
    '/merchant/:id/alias',
    bungkus((req) => {
      const b = z.object({ alias: z.string().min(2) }).parse(req.body);
      addAlias(id(req), b.alias, 'web', db());
      return { ok: true };
    }),
  );
  r.delete(
    '/merchant/alias/:id',
    bungkus((req) => {
      removeAlias(id(req), 'web', db());
      return { ok: true };
    }),
  );
  r.post(
    '/merchant/:id/gabung',
    bungkus((req) => {
      const b = z.object({ dari: z.number().int() }).parse(req.body);
      return mergeMerchants(b.dari, id(req), 'web', db());
    }),
  );

  /* ----------------------------------------------------------- anggaran */
  r.get(
    '/anggaran',
    bungkus((req) => listBudgets({ termasukNonaktif: req.query['semua'] === '1' }, db())),
  );
  r.post(
    '/anggaran',
    bungkus((req) => {
      const b = z
        .object({
          name: z.string().min(1),
          category_id: z.number().int().nullable().optional(),
          period: z.enum(['harian', 'mingguan', 'bulanan', 'kustom']),
          amount_minor: z.number().int().positive(),
          start_date: TANGGAL.optional(),
          end_date: TANGGAL.nullable().optional(),
          recurring: z.boolean().optional(),
          rollover: z.boolean().optional(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      const novo = createBudget(b, 'web', db());
      return { id: novo };
    }),
  );
  r.patch(
    '/anggaran/:id',
    bungkus((req) => {
      const b = z
        .object({
          name: z.string().optional(),
          category_id: z.number().int().nullable().optional(),
          end_date: TANGGAL.nullable().optional(),
          rollover: z.boolean().optional(),
          note: z.string().nullable().optional(),
          active: z.boolean().optional(),
        })
        .parse(req.body);
      updateBudget(id(req), b, 'web', db());
      return { ok: true };
    }),
  );
  r.post(
    '/anggaran/:id/revisi',
    bungkus((req) => {
      const b = z.object({ amount_minor: z.number().int().positive(), effective_from: TANGGAL.optional(), note: z.string().optional() }).parse(req.body);
      reviseBudget(id(req), b.amount_minor, { effective_from: b.effective_from, note: b.note ?? null }, 'web', db());
      return { ok: true };
    }),
  );
  r.get('/anggaran/:id/revisi', bungkus((req) => budgetRevisions(id(req), db())));
  r.delete(
    '/anggaran/:id',
    bungkus((req) => {
      updateBudget(id(req), { active: false }, 'web', db());
      return { ok: true, pesan: 'Anggaran dinonaktifkan. Riwayat nominalnya tetap tersimpan.' };
    }),
  );

  /* ----------------------------------------------------------- tujuan */
  r.get('/tujuan', bungkus((req) => listGoals({ termasukSelesai: req.query['semua'] === '1' }, db())));
  r.post(
    '/tujuan',
    bungkus((req) => {
      const b = z
        .object({
          name: z.string().min(1),
          target_minor: z.number().int().positive(),
          start_minor: z.number().int().min(0).optional(),
          target_date: TANGGAL.nullable().optional(),
          account_id: z.number().int().nullable().optional(),
          icon: z.string().max(8).nullable().optional(),
          reminder: z.boolean().optional(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      return { id: createGoal(b, 'web', db()) };
    }),
  );
  r.patch(
    '/tujuan/:id',
    bungkus((req) => {
      const b = z
        .object({
          name: z.string().optional(),
          target_minor: z.number().int().positive().optional(),
          start_minor: z.number().int().min(0).optional(),
          target_date: TANGGAL.nullable().optional(),
          account_id: z.number().int().nullable().optional(),
          icon: z.string().max(8).nullable().optional(),
          reminder: z.boolean().optional(),
          note: z.string().nullable().optional(),
          status: z.enum(['aktif', 'dijeda', 'tercapai', 'dibatalkan']).optional(),
        })
        .parse(req.body);
      updateGoal(id(req), b, 'web', db());
      return { ok: true };
    }),
  );
  r.post(
    '/tujuan/:id/setoran',
    bungkus((req) => {
      const b = z
        .object({
          amount_minor: z.number().int(),
          kind: z.enum(['disisihkan', 'transfer_tercatat']).optional(),
          occurred_on: TANGGAL.optional(),
          cash_event_id: z.number().int().nullable().optional(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      return { id: addContribution(id(req), b, 'web', db()) };
    }),
  );
  r.get('/tujuan/:id/setoran', bungkus((req) => goalContributions(id(req), db())));

  /* ----------------------------------------------------------- transaksi */
  r.post(
    '/transaksi/baru',
    bungkus((req) => {
      const b = z
        .object({
          jenis: z.enum(['pengeluaran', 'pemasukan', 'refund', 'transfer_sendiri', 'tabungan']),
          jumlah_minor: z.number().int().positive(),
          waktu: z.string().optional(),
          rekening_id: z.number().int().nullable().optional(),
          tunai: z.boolean().optional(),
          merchant: z.string().nullable().optional(),
          kategori_id: z.number().int().nullable().optional(),
          catatan: z.string().nullable().optional(),
          proyek: z.string().nullable().optional(),
          referensi: z.string().nullable().optional(),
          penanggung: z.enum(['saya', 'hadiah', 'company_bayar_dulu', 'company_langsung', 'talangan']).optional(),
          bagian_saya_minor: z.number().int().min(0).nullable().optional(),
          pembagian_kategori: z.array(z.object({ kategori_id: z.number().int().nullable(), jumlah_minor: z.number().int() })).optional(),
          orang: z.array(z.object({ nama: z.string(), jumlah_minor: z.number().int() })).optional(),
          melunasi_piutang_id: z.number().int().nullable().optional(),
          tujuan_rekening_id: z.number().int().nullable().optional(),
        })
        .parse(req.body);
      const hasil = buatTransaksi(b, 'web', db());
      rebuildObligations({}, db());
      return hasil;
    }),
  );
  r.patch(
    '/transaksi/:id/ubah',
    bungkus((req) => {
      const b = z
        .object({
          waktu: z.string().optional(),
          merchant: z.string().nullable().optional(),
          catatan: z.string().nullable().optional(),
          proyek: z.string().nullable().optional(),
          kategori_id: z.number().int().nullable().optional(),
          rekening_id: z.number().int().nullable().optional(),
          jumlah_minor: z.number().int().positive().optional(),
          ingat_untuk_merchant: z.boolean().optional(),
        })
        .parse(req.body);
      return ubahTransaksi(id(req), b, 'web', db());
    }),
  );

  r.get('/hari-ini', bungkus(() => ({ tanggal: today() })));
  return r;
}
