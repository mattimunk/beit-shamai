/**
 * Import a Tax Authority "מידע נדל"ן" export into the deals library.
 * Each row is placed on the map by its block/parcel; rows that cannot be placed yet wait in
 * `unlocated_deals` and are retried when the parcel layer is configured (/api/jobs/relocate).
 */
import type { Database } from "bun:sqlite";
import type { Deal } from "../src/engine/types";
import { upsertDeals } from "./db";
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
}

export function rowToDeal(row: TaxRow, loc: { lat: number; lng: number; approx: boolean }): Deal {
  const year = Number(row.date.slice(0, 4));
  return {
    id: `tax-${row.block}-${row.parcel}-${row.subParcel ?? ""}-${row.date}-${row.saleValue ?? row.declared}`,
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
  if (!exp.rows.length && !exp.totalReported) throw new Error("not a Tax Authority export, or no rows found");
  const deals: Deal[] = [];
  let unlocated = 0, approx = 0;
  const insUnloc = db.prepare(`INSERT OR REPLACE INTO unlocated_deals (id, row, at) VALUES (?, ?, ?)`);
  for (const row of exp.rows) {
    let loc = null;
    try { loc = await locateParcel(db, parcelLayer, row.block, row.parcel, fetchImpl); } catch { loc = null; }
    if (!loc) {
      insUnloc.run(`${row.block}-${row.parcel}-${row.subParcel ?? ""}-${row.date}-${row.saleValue}`, JSON.stringify(row), new Date().toISOString());
      unlocated++;
      continue;
    }
    if (loc.approx) approx++;
    deals.push(rowToDeal(row, loc));
  }
  upsertDeals(db, deals);
  const pullId = crypto.randomUUID();
  const c = exp.criteria;
  db.query(
    `INSERT INTO tax_pulls (id, city, kind, date_from, date_to, area_from, area_to, total, rows, truncated, located, unlocated, item_id, at, criteria)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(pullId, c.city ?? null, c.kind ?? null, c.from ?? null, c.to ?? null, c.areaFrom ?? null, c.areaTo ?? null,
    exp.totalReported ?? null, exp.rows.length, exp.truncated ? 1 : 0, deals.length, unlocated, itemId ?? null, new Date().toISOString(), JSON.stringify(c));
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
    const row = JSON.parse(r.row) as TaxRow;
    const loc = await locateParcel(db, layer, row.block, row.parcel, fetchImpl).catch(() => null);
    if (!loc) continue;
    upsertDeals(db, [rowToDeal(row, loc)]);
    db.query(`DELETE FROM unlocated_deals WHERE id = ?`).run(r.id);
    placed++;
  }
  return { waiting: rows.length - placed, placed };
}
