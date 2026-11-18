/**
 * Over (over.org.il) as an early source of Tax Authority deals for a report request.
 *
 * Completeness rules (so no Over row is missed for a reason on our side):
 *  - Search by block (גוש), never by address: Over links addresses to parcels itself and many
 *    parcels have none. Every block with a parcel within the radius is pulled, plus the
 *    subject's own block.
 *  - Page through each block until a page comes back short; Over's "total" stops at 10,000.
 *  - Filter deal types here, not in the query, and count what is left out by type.
 *  - Keep sub-parcel 000 rows and part-sales.
 *
 * What only an upload can fix: Over is a snapshot (two months behind in Nov 2026), it misses
 * some rows, and it merges identical rows (8 heirs × 11.1% become one). So Over covers a
 * request's older months provisionally ("upload recommended"); the months after Over's last
 * sale for the city, less a safety margin, still need an upload before the report is final.
 */
import type { Database } from "bun:sqlite";
import type { Deal } from "../src/engine/types";
import { insertDealsIfAbsent } from "./db";
import { locateParcel, type ParcelLayer } from "./connectors/parcels";
import { ensureParcelPoints } from "./connectors/parcelsOpen";
import { OverSession, type OverFetch } from "./connectors/over";
import { dealKey, occurrences } from "./taxImport";
import { normaliseCity } from "../src/engine/address";
import { normaliseTaxCity } from "./connectors/taxExport";

/** Over's deal types that the Tax Authority's "דירת מגורים" search returns. */
export const RESIDENTIAL_NATURES = new Set([
  "דירה בבית קומות", "ד. מגורים", "דירת גן", "דירת גג",
  "קוטג' דו משפחתי", "קוטג' חד משפחתי", "קוטג' טורי", "בית בודד",
]);

export const OVER_SOURCE = "over.org.il";
const PAGE = 200;
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface OverRow {
  gush: string | number;
  helka: string | number;
  sub_parcel?: string | null;
  date: string;
  amount?: number | null;
  declared_amount?: number | null;
  nature?: string | null;
  area_sqm?: number | null;
  rooms?: number | null;
  year_built?: number | null;
  portion_fraction?: number | null;
  settlement?: string | null;
}

export interface OverPullDetail {
  datasetId?: string;
  scrapedAt?: string;
  lastDeal?: string; // newest sale in the whole register
  cityLastDeal?: string; // newest sale for the request's city
  through?: string; // Over counts as covering up to here (city last sale − margin)
  blocks: number[];
  blocksPulled: number;
  blocksCached: number;
  rows: number; // residential rows in the window, all blocks
  stored: number; // new deals added to the library
  excluded: Record<string, number>; // non-residential rows by deal type
  unlocated: number;
  error?: string;
}

export function ensureOverDealTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS over_rows (id TEXT PRIMARY KEY, block INTEGER, date TEXT, json TEXT, dataset_id TEXT);
    CREATE INDEX IF NOT EXISTS over_rows_block ON over_rows(block, date);
    CREATE TABLE IF NOT EXISTS over_blocks (block INTEGER, dataset_id TEXT, date_from TEXT, rows INTEGER, excluded TEXT, at TEXT, PRIMARY KEY (block, dataset_id));
  `);
  for (const col of ["over_status TEXT", "over_through TEXT", "over_detail TEXT"]) {
    try { db.exec(`ALTER TABLE requests ADD COLUMN ${col}`); } catch { /* already there */ }
  }
}

/** Blocks with at least one parcel centre within radiusM of a point (national parcel layer). */
export function blocksNear(db: Database, lat: number, lng: number, radiusM: number): number[] {
  ensureParcelPoints(db);
  const dLat = radiusM / 111_320, dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const rows = db.query(`SELECT block, lat, lng FROM parcel_points WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`)
    .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng) as { block: number; lat: number; lng: number }[];
  const k = Math.cos((lat * Math.PI) / 180);
  const out = new Set<number>();
  for (const r of rows) if (Math.hypot((r.lat - lat) * 111_320, (r.lng - lng) * 111_320 * k) <= radiusM) out.add(r.block);
  return [...out].sort((a, b) => a - b);
}

const norm = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : String(Number(v)));
const subOf = (v: unknown) => {
  const s = norm(v);
  return s && s !== "0" && s !== "NaN" ? s : undefined;
};
const amountOf = (r: OverRow) => r.amount ?? r.declared_amount ?? undefined;
const keyOf = (r: OverRow) => dealKey({ block: norm(r.gush)!, parcel: norm(r.helka)!, subParcel: subOf(r.sub_parcel), date: r.date, amount: amountOf(r) ?? undefined });

export function overRowToDeal(r: OverRow, loc: { lat: number; lng: number; approx: boolean }, occurrence = 1): Deal {
  const year = Number(r.date.slice(0, 4));
  const yearBuilt = r.year_built ?? undefined;
  return {
    id: dealKey({ block: norm(r.gush)!, parcel: norm(r.helka)!, subParcel: subOf(r.sub_parcel), date: r.date, amount: amountOf(r) ?? undefined }, occurrence),
    evidence: "completed_deal",
    source: loc.approx ? `${OVER_SOURCE} (block centre)` : OVER_SOURCE,
    date: r.date,
    price: amountOf(r) ?? 0,
    location: { lat: loc.lat, lng: loc.lng },
    address: { city: r.settlement ? normaliseTaxCity(r.settlement) : "", street: "", number: "" },
    parcel: { block: norm(r.gush)!, parcel: norm(r.helka)!, subParcel: subOf(r.sub_parcel) },
    area: r.area_sqm ?? 0,
    rooms: r.rooms ?? 0,
    yearBuilt,
    newBuild: yearBuilt !== undefined && yearBuilt >= year - 1,
    offPlan: yearBuilt !== undefined && yearBuilt > year,
    fractionSold: r.portion_fraction ?? undefined,
    kind: r.nature ?? undefined,
  };
}

/** Every Over row of one block since a date, paging to the end. */
export async function pullBlock(s: Pick<OverSession, "call">, block: number, dateFrom: string): Promise<OverRow[]> {
  const out: OverRow[] = [];
  for (let offset = 0; offset < 50_000; offset += PAGE) {
    const page = await s.call<{ data?: OverRow[] }>("search_deals", { gush: block, date_from: dateFrom, sort: "date_asc", limit: PAGE, offset });
    const rows = page.data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error(`Over: block ${block} has more rows than expected`);
}

/** Newest sale Over holds for a city (names with the same resolved code are one city). */
export async function cityLastDeal(s: Pick<OverSession, "call">, city: string): Promise<string | undefined> {
  const want = normaliseCity(normaliseTaxCity(city));
  const res = await s.call<{ settlements?: { settlement: string; last_deal?: string; resolved_code?: number | null }[] }>("list_settlements", { query: city, limit: 50 });
  const list = res.settlements ?? [];
  const exact = list.filter((x) => normaliseCity(normaliseTaxCity(x.settlement)) === want);
  const codes = new Set(exact.map((x) => x.resolved_code).filter((c) => c !== null && c !== undefined));
  const same = list.filter((x) => exact.includes(x) || (x.resolved_code !== null && x.resolved_code !== undefined && codes.has(x.resolved_code)));
  return same.map((x) => x.last_deal).filter(Boolean).sort().pop();
}

export interface PullOptions {
  session?: Pick<OverSession, "call">;
  fetch?: OverFetch;
  parcelLayer?: ParcelLayer;
  radiusM?: number;
  months?: number;
  marginDays?: number;
  today?: string;
}

/**
 * Pull Over for one request: all blocks near the subject, the window the request's searches
 * cover. Stores the deals (never over an uploaded row) and the request's Over status.
 */
export async function pullOverForRequest(db: Database, requestId: string, opt: PullOptions = {}): Promise<OverPullDetail> {
  ensureOverDealTables(db);
  const r = db.query(`SELECT subject FROM requests WHERE id = ?`).get(requestId) as { subject: string } | null;
  if (!r) throw new Error("request not found");
  const subject = JSON.parse(r.subject);
  const radiusM = opt.radiusM ?? Number(process.env.OVER_RADIUS_M ?? 1000);
  const marginDays = opt.marginDays ?? Number(process.env.OVER_MARGIN_DAYS ?? 30);
  const today = opt.today ?? iso(Date.now());
  const months = opt.months ?? 12;
  const dateFrom = iso(Date.parse(today) - Math.round(months * 30.44) * DAY);
  const detail: OverPullDetail = { blocks: [], blocksPulled: 0, blocksCached: 0, rows: 0, stored: 0, excluded: {}, unlocated: 0 };
  const save = (status: string) =>
    db.query(`UPDATE requests SET over_status = ?, over_through = ?, over_detail = ? WHERE id = ?`).run(status, detail.through ?? null, JSON.stringify(detail), requestId);
  save("running");
  try {
    const loc = subject.location;
    const blocks = new Set<number>(loc ? blocksNear(db, loc.lat, loc.lng, radiusM) : []);
    if (subject.parcel?.block) blocks.add(Number(subject.parcel.block));
    detail.blocks = [...blocks].sort((a, b) => a - b);
    if (!detail.blocks.length) throw new Error("no blocks near the property: is the parcel layer loaded?");

    const s = opt.session ?? new OverSession(db, opt.fetch);
    const stats = await s.call<{ stats?: { dataset_id?: string; scraped_at?: string; last_deal?: string } }>("register_stats", {});
    detail.datasetId = stats.stats?.dataset_id;
    detail.scrapedAt = stats.stats?.scraped_at?.slice(0, 10);
    detail.lastDeal = stats.stats?.last_deal;
    detail.cityLastDeal = await cityLastDeal(s, subject.address.city).catch(() => undefined);
    const newest = [detail.cityLastDeal ?? detail.lastDeal, detail.scrapedAt].filter(Boolean).sort()[0];
    if (newest) detail.through = iso(Date.parse(newest) - marginDays * DAY);

    const ds = detail.datasetId ?? "unknown";
    const insRow = db.prepare(`INSERT OR REPLACE INTO over_rows (id, block, date, json, dataset_id) VALUES (?, ?, ?, ?, ?)`);
    for (const block of detail.blocks) {
      const cached = db.query(`SELECT date_from, excluded FROM over_blocks WHERE block = ? AND dataset_id = ?`).get(block, ds) as { date_from: string; excluded: string } | null;
      if (cached && cached.date_from <= dateFrom) {
        detail.blocksCached++;
        for (const [k, v] of Object.entries(JSON.parse(cached.excluded || "{}") as Record<string, number>)) detail.excluded[k] = (detail.excluded[k] ?? 0) + v;
        continue;
      }
      const rows = await pullBlock(s, block, dateFrom);
      detail.blocksPulled++;
      const excluded: Record<string, number> = {};
      const keep = rows.filter((x) => {
        if (x.nature && RESIDENTIAL_NATURES.has(x.nature)) return true;
        const k = x.nature || "(none)";
        excluded[k] = (excluded[k] ?? 0) + 1;
        return false;
      });
      const occ = occurrences(keep, keyOf);
      const deals: Deal[] = [];
      for (const [i, x] of keep.entries()) {
        const id = dealKey({ block: norm(x.gush)!, parcel: norm(x.helka)!, subParcel: subOf(x.sub_parcel), date: x.date, amount: amountOf(x) ?? undefined }, occ[i]);
        insRow.run(id, block, x.date, JSON.stringify(x), ds);
        const p = await locateParcel(db, opt.parcelLayer, norm(x.gush)!, norm(x.helka)!).catch(() => null);
        if (!p) { detail.unlocated++; continue; }
        deals.push(overRowToDeal(x, p, occ[i]));
      }
      detail.stored += insertDealsIfAbsent(db, deals);
      for (const [k, v] of Object.entries(excluded)) detail.excluded[k] = (detail.excluded[k] ?? 0) + v;
      db.query(`INSERT OR REPLACE INTO over_blocks (block, dataset_id, date_from, rows, excluded, at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(block, ds, dateFrom, keep.length, JSON.stringify(excluded), new Date().toISOString());
    }
    const ph = detail.blocks.map(() => "?").join(",");
    detail.rows = (db.query(`SELECT COUNT(*) AS n FROM over_rows WHERE block IN (${ph}) AND date >= ? AND dataset_id = ?`).get(...detail.blocks, dateFrom, ds) as { n: number }).n;
    save("done");
  } catch (e) {
    detail.error = (e as Error).message;
    detail.through = undefined; // nothing counts as covered by Over
    save("failed");
  }
  return detail;
}

export interface CompareRow {
  id: string;
  date: string;
  price: number;
  parcel: string;
  rooms?: number;
  area?: number;
  fraction?: number;
  copies?: number; // merged: how many identical rows the upload has
}

export interface OverComparison {
  /** In an upload, dated within Over's coverage, but not in Over. */
  missing: CompareRow[];
  /** Identical rows the upload has several times and Over has once. */
  merged: CompareRow[];
  /** In an upload, dated after Over's newest sale for the city (expected to be missing). */
  newer: CompareRow[];
  /** Sales in both. */
  matched: number;
}

/**
 * Compare uploaded Tax Authority rows on the request's blocks and dates with Over's rows.
 * Only meaningful once something has been uploaded for those dates.
 */
export function compareWithOver(db: Database, requestId: string): OverComparison | null {
  ensureOverDealTables(db);
  const r = db.query(`SELECT over_detail FROM requests WHERE id = ?`).get(requestId) as { over_detail: string | null } | null;
  if (!r?.over_detail) return null;
  const d = JSON.parse(r.over_detail) as OverPullDetail;
  if (!d.blocks?.length) return null;
  const items = db.query(`SELECT MIN(date_from) AS a, MAX(date_to) AS b FROM plan_items WHERE request_id = ? AND status NOT IN ('split','truncated')`).get(requestId) as { a: string; b: string };
  const out: OverComparison = { missing: [], merged: [], newer: [], matched: 0 };
  const blocks = new Set(d.blocks.map(String));
  const overIds = new Set((db.query(`SELECT id FROM over_rows WHERE block IN (${d.blocks.map(() => "?").join(",")})`).all(...d.blocks) as { id: string }[]).map((x) => x.id));
  const taxRows = (db.query(`SELECT json FROM deals WHERE date BETWEEN ? AND ? AND id LIKE 'tax-%'`).all(items.a, items.b) as { json: string }[])
    .map((x) => JSON.parse(x.json) as Deal)
    .filter((x) => x.source.startsWith("tax_authority_export") && x.parcel && blocks.has(x.parcel.block));
  const row = (x: Deal): CompareRow => ({
    id: x.id, date: x.date, price: x.price, rooms: x.rooms || undefined, area: x.area || undefined, fraction: x.fractionSold,
    parcel: `${x.parcel!.block}/${x.parcel!.parcel}${x.parcel!.subParcel ? "/" + x.parcel!.subParcel : ""}`,
  });
  const lastOver = d.cityLastDeal ?? d.lastDeal ?? "9999";
  const copies = new Map<string, number>();
  for (const x of taxRows) {
    const base = x.id.replace(/#\d+$/, "");
    copies.set(base, (copies.get(base) ?? 0) + 1);
  }
  const mergedSeen = new Set<string>();
  for (const x of taxRows) {
    const base = x.id.replace(/#\d+$/, "");
    if (overIds.has(x.id)) { out.matched++; continue; }
    if (x.id !== base && overIds.has(base)) {
      if (!mergedSeen.has(base)) { mergedSeen.add(base); out.merged.push({ ...row(x), id: base, copies: copies.get(base) }); }
      continue;
    }
    (x.date > lastOver ? out.newer : out.missing).push(row(x));
  }
  for (const list of [out.missing, out.merged, out.newer]) list.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}
