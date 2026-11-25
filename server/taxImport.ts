/**
 * Import a Tax Authority "מידע נדל"ן" export into the deals library.
 * Each row is placed on the map by its block/parcel; rows that cannot be placed yet wait in
 * `unlocated_deals` and are retried when the parcel layer is configured (/api/jobs/relocate).
 */
import type { Database } from "bun:sqlite";
import type { Deal } from "../src/engine/types";
import { dropOverCopies, upsertDeals } from "./db";
import { parseTaxExport, type TaxCriteria, type TaxRow } from "./connectors/taxExport";
import { locateParcel, type ParcelLayer } from "./connectors/parcels";

export function ensureTaxTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tax_pulls (
      id TEXT PRIMARY KEY, city TEXT, kind TEXT, date_from TEXT, date_to TEXT, area_from REAL, area_to REAL,
      total INTEGER, rows INTEGER, truncated INTEGER, located INTEGER, unlocated INTEGER, item_id TEXT, at TEXT, criteria TEXT
    );
    CREATE TABLE IF NOT EXISTS unlocated_deals (id TEXT PRIMARY KEY, row TEXT, at TEXT);
  `);
  try { db.exec(`ALTER TABLE tax_pulls ADD COLUMN narrow TEXT`); } catch { /* already there */ }
  // Uploads from before the column: work it out from the stored search criteria.
  const old = db.query(`SELECT id, criteria FROM tax_pulls WHERE narrow IS NULL`).all() as { id: string; criteria: string | null }[];
  if (old.length) {
    const set = db.prepare(`UPDATE tax_pulls SET narrow = ? WHERE id = ?`);
    db.transaction(() => { for (const r of old) set.run(narrowOf(r.criteria ? JSON.parse(r.criteria) : {}), r.id); })();
  }
}

/**
 * Was the search narrower than a city-wide one: limited to a street, a block/parcel or a number
 * of rooms? Such an upload keeps its sales but never counts as covering a planned search, which
 * is city-wide (sales are placed on the map and filtered by distance afterwards).
 * Returns "" for a city-wide search, else the reasons ("street:נחום ליפשיץ,rooms").
 */
export function narrowOf(c: { street?: string; block?: string; roomsFrom?: number; roomsTo?: number; raw?: Record<string, string> }): string {
  const out: string[] = [];
  const has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim() !== "0";
  if (has(c.street)) out.push(`street:${String(c.street).trim()}`);
  if (has(c.block)) out.push(`block:${String(c.block).trim()}`);
  const helka = c.raw && Object.entries(c.raw).find(([k]) => /^חלקה/.test(k))?.[1];
  if (has(helka)) out.push(`parcel:${String(helka).trim()}`);
  if (has(c.roomsFrom) || has(c.roomsTo)) out.push("rooms");
  return out.join(",");
}

/**
 * One sale's id, shared by every source of Tax Authority rows (uploaded exports and Over), so the
 * same sale is stored once. Identical rows in one file are separate sales (e.g. 8 heirs each
 * selling 11.1% on the same day for the same amount): the 2nd, 3rd … get "#2", "#3" ….
 */
export function dealKey(r: { block: string; parcel: string; subParcel?: string; date: string; amount?: number }, occurrence = 1): string {
  return `tax-${r.block}-${r.parcel}-${r.subParcel ?? ""}-${r.date}-${r.amount}${occurrence > 1 ? `#${occurrence}` : ""}`;
}

/** Occurrence numbers (1, 2, …) for rows with the same key, in file order. */
export function occurrences<T>(rows: T[], keyOf: (r: T) => string): number[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const k = keyOf(r);
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n;
  });
}

const taxAmount = (row: TaxRow) => row.saleValue ?? row.declared;

export function rowToDeal(row: TaxRow, loc: { lat: number; lng: number; approx: boolean }, occurrence = 1): Deal {
  const year = Number(row.date.slice(0, 4));
  return {
    id: dealKey({ ...row, amount: taxAmount(row) }, occurrence),
    evidence: "completed_deal",
    source: loc.approx ? "tax_authority_export (block centre)" : "tax_authority_export",
    date: row.date,
    price: row.saleValue ?? row.declared ?? 0,
    location: { lat: loc.lat, lng: loc.lng },
    address: { city: row.city ?? "", street: "", number: "" },
    parcel: { block: row.block, parcel: row.parcel, subParcel: row.subParcel },
    area: row.area ?? 0,
    rooms: row.rooms ?? 0,
    yearBuilt: row.yearBuilt,
    newBuild: row.yearBuilt !== undefined && row.yearBuilt >= year - 1,
    offPlan: row.yearBuilt !== undefined && row.yearBuilt > year,
    fractionSold: row.fractionSold,
    kind: row.kind,
  };
}

export interface TaxImportResult {
  pullId: string;
  criteria: TaxCriteria;
  totalReported?: number;
  rows: number;
  truncated: boolean;
  stored: number;
  partial: number;
  offPlan: number;
  unlocated: number;
  approxLocated: number;
}

export async function importTaxExport(
  db: Database,
  text: string,
  parcelLayer: ParcelLayer | undefined,
  itemId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TaxImportResult> {
  ensureTaxTables(db);
  const exp = parseTaxExport(text);
  if (!exp.rows.length && exp.totalReported === undefined) throw new Error("not a Tax Authority export, or no rows found");
  const deals: Deal[] = [];
  let unlocated = 0, approx = 0;
  const insUnloc = db.prepare(`INSERT OR REPLACE INTO unlocated_deals (id, row, at) VALUES (?, ?, ?)`);
  const occ = occurrences(exp.rows, (r) => dealKey({ ...r, amount: taxAmount(r) }));
  for (const [i, row] of exp.rows.entries()) {
    let loc = null;
    try { loc = await locateParcel(db, parcelLayer, row.block, row.parcel, fetchImpl); } catch { loc = null; }
    if (!loc) {
      insUnloc.run(dealKey({ ...row, amount: taxAmount(row) }, occ[i]), JSON.stringify({ ...row, occurrence: occ[i] }), new Date().toISOString());
      unlocated++;
      continue;
    }
    if (loc.approx) approx++;
    deals.push(rowToDeal(row, loc, occ[i]));
  }
  upsertDeals(db, deals);
  dropOverCopies(db, deals); // an upload replaces Over's copies of the same sales
  const pullId = crypto.randomUUID();
  const c = exp.criteria;
  db.query(
    `INSERT INTO tax_pulls (id, city, kind, date_from, date_to, area_from, area_to, total, rows, truncated, located, unlocated, item_id, at, criteria, narrow)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(pullId, c.city ?? null, c.kind ?? null, c.from ?? null, c.to ?? null, c.areaFrom ?? null, c.areaTo ?? null,
    exp.totalReported ?? null, exp.rows.length, exp.truncated ? 1 : 0, deals.length, unlocated, itemId ?? null, new Date().toISOString(), JSON.stringify(c), narrowOf(c));
  return {
    pullId,
    criteria: c,
    totalReported: exp.totalReported,
    rows: exp.rows.length,
    truncated: exp.truncated,
    stored: deals.length,
    partial: exp.rows.filter((r) => (r.fractionSold ?? 1) < 0.999).length,
    offPlan: deals.filter((d) => d.offPlan).length,
    unlocated,
    approxLocated: approx,
  };
}

/** Retry placing deals that could not be located at import time. */
export async function relocateUnlocated(db: Database, layer: ParcelLayer | undefined, fetchImpl: typeof fetch = fetch) {
  ensureTaxTables(db);
  const rows = db.query(`SELECT id, row FROM unlocated_deals`).all() as { id: string; row: string }[];
  let placed = 0;
  for (const r of rows) {
    const row = JSON.parse(r.row) as TaxRow & { occurrence?: number };
    const loc = await locateParcel(db, layer, row.block, row.parcel, fetchImpl).catch(() => null);
    if (!loc) continue;
    const d = rowToDeal(row, loc, row.occurrence ?? 1);
    upsertDeals(db, [d]);
    dropOverCopies(db, [d]);
    db.query(`DELETE FROM unlocated_deals WHERE id = ?`).run(r.id);
    placed++;
  }
  return { waiting: rows.length - placed, placed };
}
