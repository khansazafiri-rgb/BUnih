import type { Database as DB } from 'better-sqlite3';
import { db } from '../db/index.js';
import { nowIso } from './time.js';
import { writeAudit } from './audit.js';

export class CategoryError extends Error {}

export type CategoryRow = {
  id: number;
  slug: string;
  name: string;
  group_name: string;
  is_routine: number;
  parent_id: number | null;
  active: number;
  sort_order: number;
  icon: string | null;
};

export type CategoryNode = CategoryRow & {
  jumlah_transaksi: number;
  anak: CategoryNode[];
};

function slugify(nama: string): string {
  return (
    nama
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'kategori'
  );
}

export function getCategory(id: number, database: DB = db()): CategoryRow | undefined {
  return database.prepare(`SELECT * FROM category WHERE id = ?`).get(id) as CategoryRow | undefined;
}

export function categoryBySlug(slug: string, database: DB = db()): CategoryRow | undefined {
  return database.prepare(`SELECT * FROM category WHERE slug = ?`).get(slug) as
    | CategoryRow
    | undefined;
}

/** Id kategori ini beserta seluruh turunannya. Dipakai anggaran dan analitik per kelompok. */
export function categorySubtreeIds(id: number, database: DB = db()): number[] {
  const semua = database.prepare(`SELECT id, parent_id FROM category`).all() as Array<{
    id: number;
    parent_id: number | null;
  }>;
  const anak = new Map<number, number[]>();
  for (const c of semua) {
    if (c.parent_id !== null) {
      const list = anak.get(c.parent_id) ?? [];
      list.push(c.id);
      anak.set(c.parent_id, list);
    }
  }
  const out: number[] = [];
  const antre = [id];
  const terlihat = new Set<number>();
  while (antre.length) {
    const cur = antre.shift()!;
    if (terlihat.has(cur)) continue;
    terlihat.add(cur);
    out.push(cur);
    for (const a of anak.get(cur) ?? []) antre.push(a);
  }
  return out;
}

/** Kategori induk teratas dari sebuah kategori (dirinya sendiri bila tidak punya induk). */
export function categoryRootId(id: number, peta: Map<number, CategoryRow>): number {
  let cur = peta.get(id);
  let guard = 0;
  while (cur && cur.parent_id !== null && guard < 10) {
    const induk = peta.get(cur.parent_id);
    if (!induk) break;
    cur = induk;
    guard += 1;
  }
  return cur?.id ?? id;
}

export function categoryMap(database: DB = db()): Map<number, CategoryRow> {
  const rows = database.prepare(`SELECT * FROM category`).all() as CategoryRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

export function listCategoryTree(
  opts: { termasukNonaktif?: boolean } = {},
  database: DB = db(),
): CategoryNode[] {
  const rows = database
    .prepare(
      `SELECT c.*, (
          SELECT COUNT(DISTINCT a.cash_event_id) FROM allocation a WHERE a.category_id = c.id
        ) AS jumlah_transaksi
         FROM category c
        ${opts.termasukNonaktif ? '' : 'WHERE c.active = 1'}
        ORDER BY c.sort_order, c.name`,
    )
    .all() as Array<CategoryRow & { jumlah_transaksi: number }>;

  const node = new Map<number, CategoryNode>();
  for (const r of rows) node.set(r.id, { ...r, anak: [] });
  const akar: CategoryNode[] = [];
  for (const n of node.values()) {
    const induk = n.parent_id !== null ? node.get(n.parent_id) : undefined;
    if (induk) induk.anak.push(n);
    else akar.push(n);
  }
  return akar;
}

/** Cegah lingkaran induk-anak: induk baru tidak boleh berada di dalam turunan kategori itu. */
function pastikanTanpaLingkaran(id: number, indukBaru: number | null, database: DB): void {
  if (indukBaru === null) return;
  if (indukBaru === id) throw new CategoryError('Kategori tidak bisa menjadi induk dirinya sendiri.');
  if (categorySubtreeIds(id, database).includes(indukBaru)) {
    throw new CategoryError('Induk yang dipilih berada di dalam turunan kategori ini.');
  }
}

export function createCategory(
  input: {
    name: string;
    parent_id?: number | null;
    group_name?: string;
    icon?: string | null;
    is_routine?: boolean;
  },
  actor = 'web',
  database: DB = db(),
): number {
  const nama = input.name.trim().replace(/\s+/g, ' ');
  if (nama.length < 2) throw new CategoryError('Nama kategori minimal 2 huruf.');
  const sama = database
    .prepare(`SELECT id FROM category WHERE lower(name) = lower(?) AND active = 1`)
    .get(nama);
  if (sama) throw new CategoryError('Sudah ada kategori aktif dengan nama itu.');

  let induk: CategoryRow | undefined;
  if (input.parent_id !== undefined && input.parent_id !== null) {
    induk = getCategory(input.parent_id, database);
    if (!induk) throw new CategoryError('Kategori induk tidak ditemukan.');
  }

  let slug = slugify(nama);
  let n = 2;
  while (database.prepare(`SELECT 1 FROM category WHERE slug = ?`).get(slug)) {
    slug = `${slugify(nama)}-${n}`;
    n += 1;
  }

  const maks = database
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM category`)
    .get() as { m: number };
  const res = database
    .prepare(
      `INSERT INTO category (slug, name, group_name, is_routine, parent_id, active, sort_order, icon, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      slug,
      nama,
      input.group_name ?? induk?.group_name ?? 'lainnya',
      input.is_routine ? 1 : 0,
      input.parent_id ?? null,
      maks.m + 1,
      input.icon ?? null,
      nowIso(),
    );
  const id = Number(res.lastInsertRowid);
  writeAudit({ entity: 'category', entity_id: id, action: 'buat', actor, after: { nama, slug } }, database);
  return id;
}

export function updateCategory(
  id: number,
  patch: {
    name?: string;
    parent_id?: number | null;
    group_name?: string;
    icon?: string | null;
    is_routine?: boolean;
    active?: boolean;
    sort_order?: number;
  },
  actor = 'web',
  database: DB = db(),
): void {
  const run = database.transaction(() => {
    const before = getCategory(id, database);
    if (!before) throw new CategoryError('Kategori tidak ditemukan.');

    if (patch.parent_id !== undefined) {
      pastikanTanpaLingkaran(id, patch.parent_id, database);
      if (patch.parent_id !== null && !getCategory(patch.parent_id, database)) {
        throw new CategoryError('Kategori induk tidak ditemukan.');
      }
    }
    if (patch.name !== undefined) {
      const nama = patch.name.trim().replace(/\s+/g, ' ');
      if (nama.length < 2) throw new CategoryError('Nama kategori minimal 2 huruf.');
      const sama = database
        .prepare(`SELECT id FROM category WHERE lower(name) = lower(?) AND active = 1 AND id <> ?`)
        .get(nama, id);
      if (sama) throw new CategoryError('Sudah ada kategori aktif dengan nama itu.');
      patch.name = nama;
    }

    const kolom: string[] = [];
    const nilai: unknown[] = [];
    const set = (k: string, v: unknown) => {
      kolom.push(`${k} = ?`);
      nilai.push(v);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.parent_id !== undefined) set('parent_id', patch.parent_id);
    if (patch.group_name !== undefined) set('group_name', patch.group_name);
    if (patch.icon !== undefined) set('icon', patch.icon);
    if (patch.is_routine !== undefined) set('is_routine', patch.is_routine ? 1 : 0);
    if (patch.active !== undefined) set('active', patch.active ? 1 : 0);
    if (patch.sort_order !== undefined) set('sort_order', patch.sort_order);
    if (!kolom.length) return;

    database.prepare(`UPDATE category SET ${kolom.join(', ')} WHERE id = ?`).run(...nilai, id);
    writeAudit(
      { entity: 'category', entity_id: id, action: 'ubah', actor, before, after: patch },
      database,
    );
  });
  run();
}

/**
 * Kategori tidak pernah dihapus: transaksi lama tetap menunjuk ke sana. Menonaktifkan hanya
 * menyembunyikannya dari pilihan baru. Anak-anaknya tetap aktif dan naik ke induk di atasnya.
 */
export function deactivateCategory(id: number, actor = 'web', database: DB = db()): void {
  const run = database.transaction(() => {
    const cat = getCategory(id, database);
    if (!cat) throw new CategoryError('Kategori tidak ditemukan.');
    database.prepare(`UPDATE category SET parent_id = ? WHERE parent_id = ?`).run(cat.parent_id, id);
    database.prepare(`UPDATE category SET active = 0 WHERE id = ?`).run(id);
    writeAudit({ entity: 'category', entity_id: id, action: 'nonaktif', actor, before: cat }, database);
  });
  run();
}
