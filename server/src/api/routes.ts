import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { formatIDR } from '../domain/money.js';
import { addDays, endOfMonth, startOfMonth, today, nowIso } from '../domain/time.js';
import { project } from '../domain/projection.js';
import { periodReport } from '../domain/periods.js';
import { balanceSummary, listAccounts, recordReconciliation, reconciliationStatus } from '../domain/balances.js';
import {
  allocationsOf, evidenceOf, getCashEvent, recordCashEvent, recategorize,
} from '../domain/ledger.js';
import { listServices, listInvoices, unidentifiedServices, tagihanMendekat, cancelledButCharged, applyInvoiceStatus } from '../domain/services.js';
import { claimReceivable, listReceivables, writeOffReceivable } from '../domain/receivables.js';
import { savingsReport } from '../domain/savings.js';
import { monthlyReport, monthlyReportCsv, transactionsCsv } from '../domain/reports.js';
import { categorySubtreeIds } from '../domain/categories.js';
import { allCurrentAssumptions, assumptionHistory, setAssumption } from '../domain/assumptions.js';
import { deleteScenario, listScenarios, slugPerbandinganBawaan, upsertScenario } from '../domain/scenarios.js';
import { bandingkanSkenario, simulasiPembelian } from '../domain/simulate.js';
import { listDecisions, countOpenDecisions } from '../domain/decisions.js';
import { applyDecision, bagiBiaya, jadikanCompanyLangsung, jadikanHadiah, jadikanPelunasanPiutang, jadikanReimburseCompany, jadikanTalangan, jadikanTransferSendiri } from '../domain/applyDecision.js';
import { listObligations, rebuildObligations } from '../domain/obligations.js';
import { listTopups, setTopupStatus } from '../domain/topup.js';
import { auditFor } from '../domain/audit.js';
import { listNotificationSettings, setNotificationSetting } from '../notify/index.js';
import { authUrl, exchangeCode, gmailStatus, oauthConfigured, revokeGmail } from '../gmail/oauth.js';
import { defaultQuery, syncHistorical, syncIncremental, syncState } from '../gmail/sync.js';
import { importSheetTab, inspectSheetCsv, importHistory, importItems, FIELDS, type SheetTab } from '../importer/sheet.js';
import { importBankCsv, inspectBankCsv, pdfTextToCsv } from '../importer/bank.js';
import { buatRouterV2 } from './routesV2.js';
import { buatToken, hapusSesiCookie, periksaKataSandi, setSesiCookie, sudahMasuk, wajibMasuk } from './auth.js';

const TANGGAL = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function bungkus(handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const hasil = await handler(req, res);
      if (!res.headersSent && hasil !== undefined) res.json(hasil);
    } catch (err) {
      const pesan = (err as Error).message;
      if (!res.headersSent) res.status(400).json({ error: 'gagal', pesan });
    }
  };
}

const stateOauth = new Map<string, number>();

export function buatRouter(): Router {
  const r = Router();

  // ---------------------------------------------------------------- kesehatan
  r.get(
    '/kesehatan',
    bungkus(() => {
      const database = db();
      const migrasi = database.prepare(`SELECT COUNT(*) AS n FROM _migration`).get() as { n: number };
      const transaksi = database.prepare(`SELECT COUNT(*) AS n FROM cash_event`).get() as { n: number };
      return {
        status: 'ok',
        waktu: nowIso(),
        zona: config.BUNIH_TIMEZONE,
        migrasi: migrasi.n,
        jumlah_transaksi: transaksi.n,
        gmail: gmailStatus(database).tersambung,
        telegram: config.TELEGRAM_MODE !== 'off' && Boolean(config.TELEGRAM_BOT_TOKEN),
        scheduler: config.BUNIH_ENABLE_SCHEDULER,
      };
    }),
  );

  // ---------------------------------------------------------------------- sesi
  r.post(
    '/masuk',
    bungkus((req, res) => {
      const body = z.object({ kata_sandi: z.string().min(1) }).parse(req.body);
      if (!periksaKataSandi(body.kata_sandi)) {
        res.status(401).json({ error: 'salah', pesan: 'Kata sandi salah.' });
        return;
      }
      setSesiCookie(res, buatToken());
      res.json({ ok: true });
    }),
  );
  r.post(
    '/keluar',
    bungkus((_req, res) => {
      hapusSesiCookie(res);
      res.json({ ok: true });
    }),
  );
  r.get(
    '/saya',
    bungkus((req) => ({
      masuk: sudahMasuk(req),
      butuh_kata_sandi: Boolean(config.BUNIH_WEB_PASSWORD) || config.isProd,
    })),
  );

  // Semua di bawah ini butuh sesi.
  r.use(wajibMasuk);
  r.use(buatRouterV2());

  // ------------------------------------------------------------------ beranda
  r.get(
    '/beranda',
    bungkus(() => {
      const database = db();
      const hariIni = today();
      const saldo = balanceSummary(undefined, database);
      const tanpa = project({ dari: hariIni, sampai: addDays(hariIni, 45) }, database);
      const pembandingRow = listScenarios(database).find((x) => x.is_baseline !== 1);
      const dengan = pembandingRow
        ? project({ dari: hariIni, sampai: addDays(hariIni, 45), skenario: pembandingRow.slug }, database)
        : null;
      const tagihan = tagihanMendekat({ hari: 30 }, database);
      const piutang = listReceivables({ onlyOpen: true }, database);
      const periode = periodReport({}, database);
      const topupBerikutnya = database
        .prepare(
          `SELECT id, plan_date, plan_amount_minor, status FROM topup_plan
            WHERE plan_date >= ? AND status = 'rencana' ORDER BY plan_date LIMIT 1`,
        )
        .get(hariIni);
      const tagihanTerdekat =
        tagihan.daftar.find((d) => d.memotong_saldo_saya && d.aktif_di_skenario) ??
        tagihan.daftar.find((d) => d.aktif_di_skenario) ??
        null;

      // Tagihan yang sudah lewat jatuh tempo dibawa ke hari ini oleh mesin proyeksi,
      // jadi carilah hari tempat ia benar-benar membebani saldo.
      const cukupUntukTagihan =
        tagihanTerdekat && tagihanTerdekat.nominal_minor !== null
          ? (() => {
              const tanggalEfektif =
                tagihanTerdekat.tanggal < hariIni ? hariIni : tagihanTerdekat.tanggal;
              const hari = tanpa.hari.find((h) => h.tanggal === tanggalEfektif);
              if (!hari) return null;
              return {
                cukup: hari.saldo_akhir_minor >= 0,
                saldo_pada_tanggal_minor: hari.saldo_akhir_minor,
                kekurangan_minor: Math.max(0, -hari.saldo_akhir_minor),
                tanggal_efektif: tanggalEfektif,
                terlambat: tagihanTerdekat.terlambat,
              };
            })()
          : null;

      return {
        hari_ini: hariIni,
        saldo,
        rekonsiliasi: reconciliationStatus(database),
        hari_ini_detail: tanpa.hari[0] ?? null,
        tagihan_terdekat: tagihanTerdekat,
        cukup_untuk_tagihan: cukupUntukTagihan,
        dana_tagihan_30_hari_minor: tagihan.dana_perlu_disiapkan_minor,
        tagihan_tanpa_nominal: tagihan.jumlah_tanpa_nominal,
        topup_berikutnya: topupBerikutnya ?? null,
        periode_berjalan: periode.berjalan,
        periode_tersedia: periode.tersedia,
        periode_alasan: periode.alasan ?? null,
        piutang: {
          total_sisa_minor: piutang.total_sisa_minor,
          teman_minor: piutang.total_sisa_teman_minor,
          company_minor: piutang.total_sisa_company_minor,
          jumlah_terlambat: piutang.jumlah_terlambat,
        },
        skenario: {
          dasar: {
            nama: tanpa.skenario.nama,
            saldo_terendah_minor: tanpa.ringkasan.saldo_terendah_minor,
            saldo_terendah_tanggal: tanpa.ringkasan.saldo_terendah_tanggal,
            tanggal_defisit: tanpa.ringkasan.tanggal_defisit,
            saldo_akhir_minor: tanpa.ringkasan.saldo_akhir_minor,
          },
          pembanding: dengan
            ? {
                nama: dengan.skenario.nama,
                saldo_terendah_minor: dengan.ringkasan.saldo_terendah_minor,
                saldo_terendah_tanggal: dengan.ringkasan.saldo_terendah_tanggal,
                tanggal_defisit: dengan.ringkasan.tanggal_defisit,
                saldo_akhir_minor: dengan.ringkasan.saldo_akhir_minor,
              }
            : null,
        },
        cadangan_minimal_minor: tanpa.ringkasan.cadangan_minimal_minor,
        perlu_tindakan: {
          keputusan_terbuka: countOpenDecisions(database),
          transaksi_belum_dikategorikan: (
            database
              .prepare(
                `SELECT COUNT(*) AS n FROM cash_event
                  WHERE status <> 'dibatalkan' AND (kind = 'belum_dikategorikan' OR status = 'perlu_verifikasi')`,
              )
              .get() as { n: number }
          ).n,
          transfer_menunggu_pasangan: (
            database
              .prepare(`SELECT COUNT(*) AS n FROM cash_event WHERE status = 'menunggu_pasangan'`)
              .get() as { n: number }
          ).n,
          asumsi_belum_terverifikasi: allCurrentAssumptions(hariIni, database).filter(
            (a) => a.certainty !== 'terverifikasi',
          ).length,
          layanan_perlu_verifikasi: (
            database
              .prepare(`SELECT COUNT(*) AS n FROM service WHERE status = 'perlu_verifikasi'`)
              .get() as { n: number }
          ).n,
          langganan_tertagih_setelah_dibatalkan: cancelledButCharged(database).length,
        },
        risiko: tanpa.risiko.slice(0, 12),
        peringatan: tanpa.peringatan,
      };
    }),
  );

  // -------------------------------------------------------------- arus harian
  r.get(
    '/arus-harian',
    bungkus((req) => {
      const q = z
        .object({
          dari: TANGGAL.optional(),
          sampai: TANGGAL.optional(),
          skenario: z.string().optional(),
          tanpa_reimburse: z.string().optional(),
        })
        .parse(req.query);
      return project(
        {
          dari: q.dari,
          sampai: q.sampai,
          skenario: q.skenario,
          tanpa_reimburse: q.tanpa_reimburse === '1',
        },
        db(),
      );
    }),
  );

  r.get(
    '/periode',
    bungkus((req) => {
      const q = z
        .object({ dari: TANGGAL.optional(), sampai: TANGGAL.optional(), skenario: z.string().optional() })
        .parse(req.query);
      return periodReport(q, db());
    }),
  );

  // --------------------------------------------------------------- transaksi
  r.get(
    '/transaksi',
    bungkus((req) => {
      const q = z
        .object({
          dari: TANGGAL.optional(),
          sampai: TANGGAL.optional(),
          rekening: z.coerce.number().optional(),
          kategori: z.coerce.number().optional(),
          merchant: z.coerce.number().optional(),
          proyek: z.string().optional(),
          jenis: z.string().optional(),
          status: z.string().optional(),
          penanggung: z.string().optional(),
          sumber: z.string().optional(),
          cari: z.string().optional(),
          batas: z.coerce.number().max(500).default(100),
          offset: z.coerce.number().default(0),
        })
        .parse(req.query);

      const where: string[] = [`ce.status <> 'dibatalkan'`];
      const params: unknown[] = [];
      if (q.dari) {
        where.push(`date(ce.occurred_at) >= ?`);
        params.push(q.dari);
      }
      if (q.sampai) {
        where.push(`date(ce.occurred_at) <= ?`);
        params.push(q.sampai);
      }
      if (q.rekening) {
        where.push(`ce.account_id = ?`);
        params.push(q.rekening);
      }
      if (q.kategori) {
        // Kategori dibaca dari potongan alokasi (sama seperti laporan), termasuk turunannya.
        const ids = categorySubtreeIds(q.kategori, db());
        where.push(
          `EXISTS (SELECT 1 FROM allocation a WHERE a.cash_event_id = ce.id
             AND COALESCE(a.category_id, ce.category_id) IN (${ids.map(() => '?').join(',')}))`,
        );
        params.push(...ids);
      }
      if (q.merchant) {
        where.push(`ce.merchant_id = ?`);
        params.push(q.merchant);
      }
      if (q.proyek) {
        where.push(`lower(ce.project) = lower(?)`);
        params.push(q.proyek);
      }
      if (q.jenis) {
        where.push(`ce.kind = ?`);
        params.push(q.jenis);
      }
      if (q.status) {
        where.push(`ce.status = ?`);
        params.push(q.status);
      }
      if (q.sumber) {
        where.push(`ce.source = ?`);
        params.push(q.sumber);
      }
      if (q.penanggung) {
        where.push(
          `EXISTS (SELECT 1 FROM allocation a WHERE a.cash_event_id = ce.id AND a.bearer_type = ?)`,
        );
        params.push(q.penanggung);
      }
      if (q.cari) {
        where.push(`(ce.merchant_raw LIKE ? OR ce.counterparty LIKE ? OR ce.note LIKE ? OR ce.reference_no LIKE ?)`);
        const like = `%${q.cari}%`;
        params.push(like, like, like, like);
      }

      const database = db();
      const sql = `
        SELECT ce.*, a.name AS rekening, c.name AS kategori, c.icon AS kategori_ikon, mc.name AS merchant_nama, s.name AS layanan,
               (SELECT COUNT(*) FROM cash_event_evidence cee WHERE cee.cash_event_id = ce.id) AS jumlah_bukti
          FROM cash_event ce
          LEFT JOIN account a ON a.id = ce.account_id
          LEFT JOIN category c ON c.id = ce.category_id
          LEFT JOIN service s ON s.id = ce.service_id
          LEFT JOIN merchant mc ON mc.id = ce.merchant_id
         WHERE ${where.join(' AND ')}
         ORDER BY ce.occurred_at DESC, ce.id DESC
         LIMIT ? OFFSET ?`;
      const rows = database.prepare(sql).all(...params, q.batas, q.offset);
      const total = (
        database
          .prepare(`SELECT COUNT(*) AS n FROM cash_event ce WHERE ${where.join(' AND ')}`)
          .get(...params) as { n: number }
      ).n;
      return { total, daftar: rows };
    }),
  );

  r.get(
    '/transaksi/:id',
    bungkus((req) => {
      const id = Number(req.params.id);
      const database = db();
      const ev = getCashEvent(id, database);
      if (!ev) throw new Error('Transaksi tidak ditemukan.');
      return {
        transaksi: ev,
        alokasi: allocationsOf(id, database),
        bukti: evidenceOf(id, database),
        riwayat: auditFor('cash_event', id, database),
        pasangan: ev.transfer_group_id
          ? database
              .prepare(`SELECT id, direction, amount_minor, account_id, occurred_at FROM cash_event WHERE transfer_group_id = ? AND id <> ?`)
              .all(ev.transfer_group_id, id)
          : [],
      };
    }),
  );

  r.post(
    '/transaksi',
    bungkus((req) => {
      const body = z
        .object({
          occurred_at: z.string(),
          direction: z.enum(['masuk', 'keluar']),
          amount_minor: z.number().int().positive(),
          account_id: z.number().int().nullable().optional(),
          is_cash: z.boolean().optional(),
          kind: z.string(),
          merchant_raw: z.string().nullable().optional(),
          counterparty: z.string().nullable().optional(),
          category_id: z.number().int().nullable().optional(),
          service_id: z.number().int().nullable().optional(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      return recordCashEvent(
        { ...body, kind: body.kind as never, source: 'manual', actor: 'web' },
        db(),
      );
    }),
  );

  r.patch(
    '/transaksi/:id',
    bungkus((req) => {
      const id = Number(req.params.id);
      const body = z
        .object({
          kind: z.string().optional(),
          category_id: z.number().int().nullable().optional(),
          service_id: z.number().int().nullable().optional(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      recategorize(id, body as never, 'web', db());
      return { ok: true };
    }),
  );

  r.post(
    '/transaksi/:id/tindakan',
    bungkus((req) => {
      const id = Number(req.params.id);
      const body = z
        .object({
          tindakan: z.enum([
            'bagi_biaya', 'reimburse_company', 'company_langsung', 'hadiah', 'talangan',
            'transfer_sendiri', 'setoran_tabungan', 'pelunasan_piutang',
          ]),
          bagian_saya_minor: z.number().int().nullable().optional(),
          jumlah_orang: z.number().int().nullable().optional(),
          orang: z.array(z.object({ nama: z.string(), nominal_minor: z.number().int() })).optional(),
          receivable_id: z.number().int().optional(),
          nama: z.string().optional(),
        })
        .parse(req.body);
      const database = db();
      switch (body.tindakan) {
        case 'bagi_biaya':
          return bagiBiaya(
            id,
            {
              bagian_saya_minor: body.bagian_saya_minor ?? null,
              jumlah_orang: body.jumlah_orang ?? null,
              orang: body.orang,
              actor: 'web',
            },
            database,
          );
        case 'reimburse_company':
          jadikanReimburseCompany(id, { actor: 'web' }, database);
          return { pesan: 'Dicatat sebagai klaim reimburse company.' };
        case 'company_langsung':
          jadikanCompanyLangsung(id, 'web', database);
          return { pesan: 'Dicatat sebagai biaya company yang dibayar langsung.' };
        case 'hadiah':
          return jadikanHadiah(id, 'web', database);
        case 'talangan':
          return jadikanTalangan(id, body.nama ?? null, 'web', database);
        case 'transfer_sendiri':
          return jadikanTransferSendiri(id, { ke_tabungan: false, actor: 'web' }, database);
        case 'setoran_tabungan':
          return jadikanTransferSendiri(id, { ke_tabungan: true, actor: 'web' }, database);
        case 'pelunasan_piutang':
          if (!body.receivable_id) throw new Error('receivable_id wajib untuk pelunasan piutang.');
          return jadikanPelunasanPiutang(id, body.receivable_id, 'web', database);
      }
    }),
  );

  // ------------------------------------------------------- tagihan & layanan
  r.get('/layanan', bungkus(() => listServices(db())));
  r.patch(
    '/layanan/:id',
    bungkus((req) => {
      const id = Number(req.params.id);
      const body = z
        .object({
          amount_minor: z.number().int().nullable().optional(),
          amount_certainty: z.enum(['terverifikasi', 'perkiraan', 'asumsi_sheet']).optional(),
          next_due_date: TANGGAL.nullable().optional(),
          due_date_certainty: z.enum(['terverifikasi', 'perkiraan', 'asumsi_sheet']).optional(),
          bearer: z.enum(['pribadi', 'company', 'belum_jelas']).optional(),
          paid_by: z.enum(['saya', 'company', 'belum_jelas']).optional(),
          billing_cycle: z.enum(['bulanan', 'tahunan', 'sesuai_pemakaian', 'sekali', 'belum_jelas']).optional(),
          status: z.string().optional(),
          cancelled_at: z.string().nullable().optional(),
          benefit_period_start: TANGGAL.nullable().optional(),
          benefit_period_end: TANGGAL.nullable().optional(),
          reserve_for_renewal_minor: z.number().int().nullable().optional(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      const database = db();
      const kolom = Object.keys(body);
      if (!kolom.length) return { ok: true };
      const set = kolom.map((k) => `${k} = ?`).join(', ');
      database
        .prepare(`UPDATE service SET ${set}, updated_at = ? WHERE id = ?`)
        .run(...kolom.map((k) => (body as Record<string, unknown>)[k]), nowIso(), id);
      rebuildObligations({}, database);
      return { ok: true };
    }),
  );

  r.get(
    '/tagihan',
    bungkus((req) => {
      const q = z.object({ dari: TANGGAL.optional(), sampai: TANGGAL.optional(), hari: z.coerce.number().optional() }).parse(req.query);
      const database = db();
      return {
        mendekat: tagihanMendekat({ hari: q.hari ?? 30 }, database),
        invoice: listInvoices({ from: q.dari, to: q.sampai }, database),
        kewajiban: listObligations({ from: q.dari ?? today(), to: q.sampai ?? addDays(today(), 90), status: 'rencana' }, database),
        peringatan_dibatalkan_tapi_tertagih: cancelledButCharged(database),
      };
    }),
  );

  r.post(
    '/tagihan/:id/status',
    bungkus((req) => {
      const id = Number(req.params.id);
      const body = z
        .object({ status: z.string(), occurred_at: z.string().optional(), note: z.string().optional() })
        .parse(req.body);
      const hasil = applyInvoiceStatus(
        {
          invoice_id: id,
          status: body.status as never,
          occurred_at: body.occurred_at ?? nowIso(),
          note: body.note ?? null,
          actor: 'web',
        },
        db(),
      );
      rebuildObligations({}, db());
      return hasil;
    }),
  );

  r.get('/layanan-belum-teridentifikasi', bungkus(() => unidentifiedServices({}, db())));

  // ------------------------------------------------------------- reimburse
  r.get('/reimburse', bungkus(() => listReceivables({ onlyOpen: false }, db())));
  r.post(
    '/reimburse/:id/klaim',
    bungkus((req) => {
      const body = z.object({ expected_on: TANGGAL.nullable().optional(), note: z.string().optional() }).parse(req.body ?? {});
      claimReceivable(Number(req.params.id), { ...body, actor: 'web' }, db());
      return { ok: true };
    }),
  );
  r.post(
    '/reimburse/:id/hapus',
    bungkus((req) => {
      const body = z.object({ alasan: z.string().min(3) }).parse(req.body);
      writeOffReceivable(Number(req.params.id), body.alasan, 'web', db());
      return { ok: true };
    }),
  );

  // -------------------------------------------------------------- tabungan
  r.get('/tabungan', bungkus(() => savingsReport({}, db())));

  // ------------------------------------------------------- anggaran & asumsi
  r.get(
    '/asumsi',
    bungkus(() => ({
      sekarang: allCurrentAssumptions(today(), db()),
      kunci_dikenal: [
        'anggaran_makan_harian', 'cadangan_minimal', 'topup_nominal', 'topup_interval_hari',
        'topup_mulai', 'periode_mulai', 'periode_panjang_hari', 'target_tabungan_bulanan',
        'reimburse_lag_hari', 'saldo_awal_sheet',
      ],
    })),
  );
  r.get('/asumsi/:key/riwayat', bungkus((req) => assumptionHistory(String(req.params.key), db())));
  r.post(
    '/asumsi',
    bungkus((req) => {
      const body = z
        .object({
          key: z.string().min(2),
          value: z.unknown(),
          effective_from: TANGGAL.optional(),
          certainty: z.enum(['terverifikasi', 'perkiraan', 'asumsi_sheet']).optional(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      const id = setAssumption(
        body.key,
        body.value,
        {
          effectiveFrom: body.effective_from,
          certainty: body.certainty ?? 'terverifikasi',
          source: 'manual',
          note: body.note ?? null,
          actor: 'web',
        },
        db(),
      );
      rebuildObligations({}, db());
      return { id };
    }),
  );

  // -------------------------------------------------------------- skenario
  r.get('/skenario', bungkus((req) => listScenarios(db(), { termasukTersembunyi: req.query['semua'] === '1' })));
  r.post(
    '/skenario',
    bungkus((req) => {
      const body = z
        .object({
          slug: z.string().min(2),
          name: z.string().min(2),
          description: z.string().nullable().optional(),
          enabledTags: z.array(z.string()).optional(),
          overrides: z.record(z.unknown()).optional(),
        })
        .parse(req.body);
      return { id: upsertScenario(body, db()) };
    }),
  );
  r.delete(
    '/skenario/:slug',
    bungkus((req) => {
      deleteScenario(String(req.params.slug), db());
      return { ok: true };
    }),
  );
  r.get(
    '/skenario/banding',
    bungkus((req) => {
      const q = z
        .object({ slugs: z.string().optional(), dari: TANGGAL.optional(), sampai: TANGGAL.optional() })
        .parse(req.query);
      const slugs = q.slugs ? q.slugs.split(',') : slugPerbandinganBawaan(db());
      return bandingkanSkenario(slugs, { dari: q.dari, sampai: q.sampai }, db());
    }),
  );

  r.post(
    '/simulasi',
    bungkus((req) => {
      const body = z
        .object({
          label: z.string().optional(),
          harga_minor: z.number().int().nullable(),
          tanggal: TANGGAL.optional(),
          account_id: z.number().int().nullable().optional(),
          jenis: z.enum(['pribadi', 'hadiah', 'talangan', 'company', 'bersama']),
          bagian_kembali_minor: z.number().int().nullable().optional(),
          bisa_ditunda: z.boolean().optional(),
          skenario: z.string().optional(),
        })
        .parse(req.body);
      return simulasiPembelian(body, db());
    }),
  );

  // ------------------------------------------------------------- keputusan
  r.get('/keputusan', bungkus(() => listDecisions({ limit: 100 }, db())));
  r.post(
    '/keputusan/:id',
    bungkus((req) => {
      const body = z.object({ optionId: z.string(), extra: z.record(z.unknown()).optional() }).parse(req.body);
      return applyDecision(Number(req.params.id), body.optionId, body.extra ?? {}, 'web', db());
    }),
  );

  // -------------------------------------------------------------- rekening
  r.get(
    '/rekening',
    bungkus(() => ({
      daftar: listAccounts(db(), false),
      saldo: balanceSummary(undefined, db()),
      rekonsiliasi: reconciliationStatus(db()),
    })),
  );
  r.post(
    '/rekening',
    bungkus((req) => {
      const body = z
        .object({
          name: z.string().min(2),
          bank: z.string().min(2),
          last4: z.string().regex(/^\d{4}$/).nullable().optional(),
          kind: z.enum(['giro', 'tabungan', 'ewallet', 'kartu', 'company', 'virtual']),
          is_mine: z.boolean().default(true),
          is_savings_target: z.boolean().default(false),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      const res = db()
        .prepare(
          `INSERT INTO account (name, bank, last4, kind, currency, is_mine, is_savings_target, verified, note, created_at)
           VALUES (?, ?, ?, ?, 'IDR', ?, ?, ?, ?, ?)`,
        )
        .run(
          body.name,
          body.bank,
          body.last4 ?? null,
          body.kind,
          body.is_mine ? 1 : 0,
          body.is_savings_target ? 1 : 0,
          body.last4 ? 1 : 0,
          body.note ?? null,
          nowIso(),
        );
      return { id: Number(res.lastInsertRowid) };
    }),
  );
  r.patch(
    '/rekening/:id',
    bungkus((req) => {
      const body = z
        .object({
          name: z.string().optional(),
          last4: z.string().regex(/^\d{4}$/).nullable().optional(),
          is_savings_target: z.boolean().optional(),
          verified: z.boolean().optional(),
          active: z.boolean().optional(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      const patch: Record<string, unknown> = { ...body };
      if (body.is_savings_target !== undefined) patch['is_savings_target'] = body.is_savings_target ? 1 : 0;
      if (body.verified !== undefined) patch['verified'] = body.verified ? 1 : 0;
      if (body.active !== undefined) patch['active'] = body.active ? 1 : 0;
      const kolom = Object.keys(patch);
      if (!kolom.length) return { ok: true };
      db()
        .prepare(`UPDATE account SET ${kolom.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...kolom.map((k) => patch[k]), Number(req.params.id));
      return { ok: true };
    }),
  );
  r.post(
    '/rekonsiliasi',
    bungkus((req) => {
      const body = z
        .object({
          account_id: z.number().int(),
          as_of: z.string(),
          statement_balance_minor: z.number().int(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      const id = recordReconciliation({ ...body, source: 'manual' }, db());
      return { id, pesan: `Saldo terkonfirmasi ${formatIDR(body.statement_balance_minor)} dicatat.` };
    }),
  );

  // -------------------------------------------------------------- belanja
  r.get(
    '/belanja',
    bungkus(() =>
      db()
        .prepare(
          `SELECT p.*, c.name AS kategori, pe.name AS pemilik
             FROM purchase p
             LEFT JOIN category c ON c.id = p.category_id
             LEFT JOIN person pe ON pe.id = p.owner_person_id
            ORDER BY COALESCE(p.occurred_on, p.wanted_on) DESC, p.id DESC LIMIT 200`,
        )
        .all(),
    ),
  );
  r.post(
    '/belanja',
    bungkus((req) => {
      const body = z
        .object({
          name: z.string().min(1),
          qty: z.number().positive().default(1),
          unit_price_minor: z.number().int().nullable().optional(),
          total_minor: z.number().int().nullable().optional(),
          price_unknown: z.boolean().default(false),
          planned: z.boolean().default(true),
          wanted_on: TANGGAL.nullable().optional(),
          category_id: z.number().int().nullable().optional(),
          final_bearer: z.enum(['saya', 'teman', 'company', 'bersama', 'belum_jelas']).default('saya'),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      const total =
        body.total_minor ??
        (body.unit_price_minor !== null && body.unit_price_minor !== undefined
          ? body.unit_price_minor * body.qty
          : null);
      const res = db()
        .prepare(
          `INSERT INTO purchase
            (name, qty, unit_price_minor, total_minor, price_unknown, currency, planned, wanted_on,
             category_id, final_bearer, payment_status, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'IDR', ?, ?, ?, ?, 'belum_dibayar', ?, ?, ?)`,
        )
        .run(
          body.name,
          body.qty,
          body.unit_price_minor ?? null,
          total,
          body.price_unknown || total === null ? 1 : 0,
          body.planned ? 1 : 0,
          body.wanted_on ?? null,
          body.category_id ?? null,
          body.final_bearer,
          body.note ?? null,
          nowIso(),
          nowIso(),
        );
      rebuildObligations({}, db());
      return { id: Number(res.lastInsertRowid) };
    }),
  );

  // ---------------------------------------------------------------- topup
  r.get(
    '/topup',
    bungkus((req) => {
      const q = z.object({ dari: TANGGAL.optional(), sampai: TANGGAL.optional() }).parse(req.query);
      return listTopups(q, db());
    }),
  );
  r.patch(
    '/topup/:id',
    bungkus((req) => {
      const body = z
        .object({
          status: z.enum(['rencana', 'diterima', 'sebagian', 'tidak_diterima', 'dibatalkan']),
          actual_amount_minor: z.number().int().nullable().optional(),
          actual_date: TANGGAL.nullable().optional(),
          note: z.string().nullable().optional(),
        })
        .parse(req.body);
      setTopupStatus(Number(req.params.id), body.status, { ...body, actor: 'web' }, db());
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------- kategori
  r.get('/orang', bungkus(() => db().prepare(`SELECT * FROM person ORDER BY kind, name`).all()));

  // --------------------------------------------------------------- laporan
  r.get(
    '/laporan/bulanan',
    bungkus((req) => {
      const q = z.object({ bulan: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
      return monthlyReport(q.bulan, db());
    }),
  );
  r.get(
    '/laporan/bulanan.csv',
    bungkus((req, res) => {
      const q = z.object({ bulan: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
      const bulan = q.bulan ?? today().slice(0, 7);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bunih-${bulan}.csv"`);
      res.send(monthlyReportCsv(bulan, db()));
    }),
  );
  r.get(
    '/ekspor/transaksi.csv',
    bungkus((req, res) => {
      const q = z.object({ dari: TANGGAL.optional(), sampai: TANGGAL.optional() }).parse(req.query);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bunih-transaksi.csv"`);
      res.send(transactionsCsv(q, db()));
    }),
  );
  r.get(
    '/ekspor/semua.json',
    bungkus((_req, res) => {
      const database = db();
      const tabel = [
        'account', 'person', 'category', 'assumption', 'evidence', 'cash_event', 'allocation',
        'cash_event_evidence', 'receivable', 'receivable_settlement', 'service', 'invoice',
        'invoice_evidence', 'invoice_status_event', 'obligation', 'topup_plan', 'purchase',
        'scenario', 'reconciliation', 'merchant_rule', 'pending_decision', 'notification_setting',
        'notification_log', 'import_run', 'import_item', 'audit_log',
      ];
      const dump: Record<string, unknown[]> = {};
      for (const t of tabel) dump[t] = database.prepare(`SELECT * FROM ${t}`).all();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bunih-ekspor-${today()}.json"`);
      res.send(JSON.stringify({ versi: 1, dibuat: nowIso(), data: dump }, null, 2));
    }),
  );

  // ------------------------------------------------------------------ audit
  r.get(
    '/audit',
    bungkus((req) => {
      const q = z.object({ entity: z.string(), id: z.coerce.number() }).parse(req.query);
      return auditFor(q.entity, q.id, db());
    }),
  );

  // ------------------------------------------------------------------ gmail
  r.get(
    '/gmail/status',
    bungkus(() => ({
      ...gmailStatus(db()),
      oauth_siap: oauthConfigured(),
      sinkronisasi: syncState(db()),
      kueri_bawaan: defaultQuery(),
      langkah: [
        'Buat OAuth Client ID (tipe Web application) di Google Cloud Console.',
        'Tambahkan redirect URI yang ditampilkan di bawah.',
        'Aktifkan Gmail API pada proyek yang sama.',
        'Isi GOOGLE_CLIENT_ID dan GOOGLE_CLIENT_SECRET di .env server, lalu mulai ulang.',
        'Klik "Sambungkan Gmail" dan setujui izin baca-saja.',
      ],
      catatan_keamanan:
        'Aplikasi ini hanya meminta izin membaca email (gmail.readonly). Kata sandi Gmail tidak ' +
        'pernah diminta. Akses Gmail dari percakapan AI lain tidak otomatis berlaku di sini.',
    })),
  );
  r.get(
    '/gmail/mulai',
    bungkus((_req, res) => {
      const state = crypto.randomBytes(16).toString('hex');
      stateOauth.set(state, Date.now());
      res.json({ url: authUrl(state) });
    }),
  );
  r.get(
    '/gmail/callback',
    bungkus(async (req, res) => {
      const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
      if (q.error) {
        res.status(400).send(`<p>Penyambungan dibatalkan: ${q.error}</p>`);
        return;
      }
      if (!q.code || !q.state || !stateOauth.has(q.state)) {
        res.status(400).send('<p>Permintaan tidak sah. Coba sambungkan lagi dari halaman Pengaturan.</p>');
        return;
      }
      stateOauth.delete(q.state);
      const email = await exchangeCode(q.code, db());
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        `<!doctype html><meta charset="utf-8"><title>Gmail tersambung</title>` +
          `<body style="font-family:system-ui;padding:24px;line-height:1.6">` +
          `<h1>Gmail tersambung</h1><p>Akun: <b>${email ?? 'tidak diketahui'}</b></p>` +
          `<p>Izin: baca saja (gmail.readonly).</p>` +
          `<p><a href="/pengaturan">Kembali ke Pengaturan</a></p></body>`,
      );
    }),
  );
  r.post(
    '/gmail/sinkron',
    bungkus(async (req) => {
      const body = z
        .object({ mode: z.enum(['historis', 'berkelanjutan']).default('berkelanjutan'), dari: TANGGAL.optional(), sampai: TANGGAL.optional(), query: z.string().optional() })
        .parse(req.body ?? {});
      const database = db();
      const hasil =
        body.mode === 'historis'
          ? await syncHistorical(
              { dari: body.dari ?? addDays(today(), -180), sampai: body.sampai, query: body.query },
              database,
            )
          : await syncIncremental({}, database);
      rebuildObligations({}, database);
      return hasil;
    }),
  );
  r.post(
    '/gmail/cabut',
    bungkus(async () => {
      await revokeGmail(db());
      return { ok: true, pesan: 'Akses Gmail dicabut dan token dihapus.' };
    }),
  );

  // --------------------------------------------------------------- telegram
  r.get(
    '/telegram/status',
    bungkus(() => ({
      mode: config.TELEGRAM_MODE,
      token_terpasang: Boolean(config.TELEGRAM_BOT_TOKEN),
      chat_id_terpasang: Boolean(config.TELEGRAM_ALLOWED_CHAT_ID),
      langkah: [
        'Buat bot lewat @BotFather, salin tokennya.',
        'Isi TELEGRAM_BOT_TOKEN di .env server, lalu mulai ulang.',
        'Kirim /mulai ke bot; bot akan membalas Chat ID kamu.',
        'Isi TELEGRAM_ALLOWED_CHAT_ID dengan nilai itu, lalu mulai ulang. Bot hanya menjawab akun itu.',
      ],
    })),
  );

  // ----------------------------------------------------------------- impor
  r.get('/impor/sheet/kolom', bungkus(() => FIELDS));
  r.post(
    '/impor/sheet/periksa',
    bungkus((req) => {
      const body = z.object({ tab: z.string(), csv: z.string().min(1) }).parse(req.body);
      return inspectSheetCsv(body.tab as SheetTab, body.csv);
    }),
  );
  r.post(
    '/impor/sheet',
    bungkus((req) => {
      const body = z
        .object({
          tab: z.string(),
          csv: z.string().min(1),
          mapping: z.record(z.number().nullable()).optional(),
          dryRun: z.boolean().default(false),
          label: z.string().optional(),
        })
        .parse(req.body);
      const hasil = importSheetTab(
        { tab: body.tab as SheetTab, csv: body.csv, mapping: body.mapping, dryRun: body.dryRun, label: body.label },
        db(),
      );
      if (!body.dryRun) rebuildObligations({}, db());
      return hasil;
    }),
  );
  r.post(
    '/impor/mutasi/periksa',
    bungkus((req) => {
      const body = z.object({ csv: z.string().optional(), pdf_teks: z.string().optional() }).parse(req.body);
      const csv = body.csv ?? (body.pdf_teks ? pdfTextToCsv(body.pdf_teks) : '');
      if (!csv) throw new Error('Kirim csv atau pdf_teks.');
      return { ...inspectBankCsv(csv), csv_hasil: body.pdf_teks ? csv : undefined };
    }),
  );
  r.post(
    '/impor/mutasi',
    bungkus((req) => {
      const body = z
        .object({
          account_id: z.number().int(),
          csv: z.string().optional(),
          pdf_teks: z.string().optional(),
          mapping: z.record(z.number().nullable()).optional(),
          dryRun: z.boolean().default(false),
          pakaiSaldoTerakhir: z.boolean().default(true),
        })
        .parse(req.body);
      const csv = body.csv ?? (body.pdf_teks ? pdfTextToCsv(body.pdf_teks) : '');
      if (!csv) throw new Error('Kirim csv atau pdf_teks.');
      return importBankCsv(
        {
          account_id: body.account_id,
          csv,
          mapping: body.mapping as never,
          dryRun: body.dryRun,
          pakaiSaldoTerakhir: body.pakaiSaldoTerakhir,
        },
        db(),
      );
    }),
  );
  r.get('/impor/riwayat', bungkus(() => importHistory(db())));
  r.get('/impor/riwayat/:id', bungkus((req) => importItems(Number(req.params.id), db())));

  // ---------------------------------------------------------- notifikasi
  r.get('/notifikasi', bungkus(() => listNotificationSettings(db())));
  r.patch(
    '/notifikasi/:type',
    bungkus((req) => {
      const body = z
        .object({ enabled: z.boolean().optional(), frequency: z.enum(['langsung', 'harian', 'mingguan', 'mati']).optional() })
        .parse(req.body);
      setNotificationSetting(String(req.params.type), body, db());
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------- pemeliharaan
  r.post(
    '/bangun-rencana',
    bungkus(() => rebuildObligations({}, db())),
  );
  r.get(
    '/ringkasan-bulan-vs-sheet',
    bungkus((req) => {
      const q = z.object({ bulan: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
      const bulan = q.bulan ?? today().slice(0, 7);
      const lap = monthlyReport(bulan, db());
      const proj = project(
        { dari: startOfMonth(`${bulan}-01`), sampai: endOfMonth(`${bulan}-01`) },
        db(),
      );
      return {
        bulan,
        aplikasi: {
          masuk_minor: lap.arus_kas.masuk_minor,
          keluar_minor: lap.arus_kas.keluar_minor,
          biaya_pribadi_neto_minor: lap.biaya_pribadi_neto_minor,
          saldo_akhir_proyeksi_minor: proj.ringkasan.saldo_akhir_minor,
        },
        cara_banding:
          'Ekspor CSV bulanan dari aplikasi, lalu tempelkan di samping tab RINGKASAN Sheet. ' +
          'Selisih yang wajar: Sheet memakai rencana, aplikasi memakai realisasi + rencana.',
      };
    }),
  );

  return r;
}
