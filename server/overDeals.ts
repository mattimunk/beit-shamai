/**
 * Over (over.org.il) as the early source of completed sales for a report request.
 *
 * Two mirrors, one public REST API (no key, any use allowed; see connectors/over.ts):
 *  - GovMap's deals layer (/api/deals/govmap/search): the main source. It has street, house
 *    number, the floor (as a Hebrew word) and the building's point, one row per sale at the
 *    full price, and sales Over's Tax Authority copy lacks (block 30079, Jul–Sep 2026).
 *  - Over's Tax Authority copy (/api/deals/search): share sold and year built. It misses whole
 *    blocks in central Jerusalem (Over's data log, 13 Oct 2026), some rows (₪5M on 30079/213,
 *    3 Jun 2026), merges identical rows (heirs), and has not been refreshed since 19 Sep 2026.
 *
 * One sale = one parcel (with sub-parcel) on one date. Where both mirrors have it, the GovMap
 * row is stored, with year built from the Tax Authority copy. An uploaded export always wins
 * (db.dropOverCopies), except where it holds only part-sales of that sale.
 *
 * Completeness rules (so no row is missed for a reason on our side):
 *  - Search by block, never by address. Every block with a parcel within the radius, the
 *    subject's own block, and known-gap blocks (no mapped parcels) whose GovMap point is near.
 *  - Page each block to the end; Over's "total" stops at 10,000.
 *  - Filter deal types here and count what is left out.
 *
 * Coverage ("Covered by Over · upload recommended"): searches up to the newest GovMap sale for
 * the city, less OVER_MARGIN_DAYS, don't hold the report back, unless a nearby block is blind:
 * on the known-gap list with no rows in either mirror. Then nothing counts as covered.
 */
import type { Database } from "bun:sqlite";
import type { Deal } from "../src/engine/types";
import { parcelKeyOf } from "../src/engine/market";
import { dropOtherOverCopies, insertDealsIfAbsent, OVER_SOURCE, uploadHasSale, upsertDeals } from "./db";
import { locateParcel, type ParcelLayer } from "./connectors/parcels";
import { ensureParcelPoints } from "./connectors/parcelsOpen";
import { OverApi, type OverFetch } from "./connectors/over";
import { dealKey, occurrences } from "./taxImport";
import { normaliseTaxCity } from "./connectors/taxExport";

export { OVER_SOURCE };

/** Deal types that the Tax Authority's "דירת מגורים" search returns. ("מגורים" alone is land/rights.) */
export const RESIDENTIAL_NATURES = new Set([
  "דירה בבית קומות", "ד. מגורים", "דירת גן", "דירת גג",
  "קוטג' דו משפחתי", "קוטג' חד משפחתי", "קוטג' טורי", "בית בודד",
]);

const PAGE = 200;
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A row of Over's Tax Authority copy (/api/deals/search). */
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

/** A row of Over's GovMap copy (/api/deals/govmap/search). */
export interface GovmapRow {
  deal_id?: number | string | null;
  objectid?: number | null;
  deal_date: string;
  deal_amount?: number | null;
  settlement?: string | null;
  street?: string | null;
  house_num?: string | null;
  floor?: string | null;
  asset_area?: number | null;
  rooms?: number | null;
  property_type?: string | null;
  deal_nature?: string | null;
  gush: number | string;
  parcel: number | string;
  sub_parcel?: number | string | null;
  lon?: number | null;
  lat?: number | null;
}

type Source = "tax" | "govmap";

export interface OverPullDetail {
  taxNewest?: string; // newest sale for the city in the Tax Authority copy
  govmapNewest?: string; // newest sale for the city in the GovMap copy
  through?: string; // Over counts as covering up to here (newest − margin)
  blocks: number[];
  blocksPulled: number;
  blocksCached: number;
  rows: number; // residential sales in the window after merging the two mirrors
  govmapRows: number;
  taxRows: number;
  stored: number; // deals added or refreshed in the library
  excluded: Record<string, number>; // non-residential rows by deal type (both mirrors)
  unlocated: number;
  /** Known-gap blocks near the property with no rows in either mirror: nothing is covered. */
  blind: number[];
  /** Blocks where GovMap has residential sales and the Tax Authority copy has none. */
  taxMissing: number[];
  /** Blocks where the Tax Authority copy has residential sales and GovMap has none. */
  govmapMissing: number[];
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// Parsing

/** "30028,30033-30072" → set of blocks. */
export function parseBlockList(s: string): Set<number> {
  const out = new Set<number>();
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    for (let k = Math.min(a, b); k <= Math.max(a, b) && k - a < 10_000; k++) out.add(k);
  }
  return out;
}

/** Blocks Over's Tax Authority copy misses (Over's data log, 13 Oct 2026; central Jerusalem). */
export const KNOWN_GAP_BLOCKS = parseBlockList(process.env.OVER_GAP_BLOCKS ?? "30028,30033-30072,30074,30078,30081,30083,30086-30089,30109");

const UNITS: Record<string, number> = { "אחת": 1, "אחד": 1, "שתיים": 2, "שתים": 2, "שניים": 2, "שלוש": 3, "ארבע": 4, "חמש": 5, "שש": 6, "שבע": 7, "שמונה": 8, "תשע": 9 };
const ORDINALS: Record<string, number> = {
  "מרתף": -1, "קרקע": 0, "ראשונה": 1, "שניה": 2, "שנייה": 2, "שלישית": 3, "רביעית": 4, "חמישית": 5, "שישית": 6, "ששית": 6,
  "שביעית": 7, "שמינית": 8, "תשיעית": 9, "עשירית": 10,
};
const TENS: Record<string, number> = { "עשרים": 20, "שלושים": 30, "ארבעים": 40, "חמישים": 50 };

/**
 * GovMap's floor ("קרקע", "שלישית", "אחת עשרה", "עשרים ושתיים", "3", "קומה 4") → number.
 * Several floors (a duplex: "ראשונה, שניה") → the lowest. Anything else → undefined.
 */
export function floorFromGovmap(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const parts = v.replace(/קומה|קומת/g, " ").split(/[,/+]| ו?עד /).map((x) => x.trim()).filter(Boolean);
  const vals = parts.map(one).filter((x): x is number => x !== undefined);
  return vals.length ? Math.min(...vals) : undefined;

  function one(s: string): number | undefined {
    if (/^-?\d+$/.test(s)) return Number(s);
    const w = s.replace(/\s+/g, " ").trim();
    if (w in ORDINALS) return ORDINALS[w];
    let m = w.match(/^(\S+) עשרה?$/); // אחת עשרה … תשע עשרה
    if (m && m[1]! in UNITS) return 10 + UNITS[m[1]!]!;
    m = w.match(/^(\S+)(?: ו(\S+))?$/); // עשרים, עשרים ושתיים
    if (m && m[1]! in TENS) {
      if (!m[2]) return TENS[m[1]!];
      if (m[2] in UNITS) return TENS[m[1]!]! + UNITS[m[2]]!;
    }
    return undefined;
  }
}

const norm = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : String(Number(v)));
const subOf = (v: unknown) => {
  const s = norm(v);
  return s && s !== "0" && s !== "NaN" ? s : undefined;
};
const amountOf = (r: OverRow) => r.amount ?? r.declared_amount ?? undefined;
const taxKeyOf = (r: OverRow) => dealKey({ block: norm(r.gush)!, parcel: norm(r.helka)!, subParcel: subOf(r.sub_parcel), date: r.date, amount: amountOf(r) ?? undefined });
/** One sale across sources: parcel with sub-parcel, and date (no amount; the sources disagree on it). */
export const saleKey = (block: unknown, parcel: unknown, sub: unknown, date: string) =>
  `${parcelKeyOf({ block: norm(block)!, parcel: norm(parcel)!, subParcel: subOf(sub) })}@${date}`;
const govDate = (r: GovmapRow) => (r.deal_date ?? "").slice(0, 10);
const validDate = (d: string, today: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= "1990-01-01" && d <= today;
const inIsrael = (lat?: number | null, lng?: number | null) => typeof lat === "number" && typeof lng === "number" && lat > 29 && lat < 34 && lng > 34 && lng < 36.5;

// ---------------------------------------------------------------------------------------------
// Rows → deals

export function overRowToDeal(r: OverRow, loc: { lat: number; lng: number; approx: boolean }, occurrence = 1): Deal {
  const year = Number(r.date.slice(0, 4));
  const yearBuilt = r.year_built ?? undefined;
  return {
    id: dealKey({ block: norm(r.gush)!, parcel: norm(r.helka)!, subParcel: subOf(r.sub_parcel), date: r.date, amount: amountOf(r) ?? undefined }, occurrence),
    evidence: "completed_deal",
    source: loc.approx ? `${OVER_SOURCE} (Tax Authority, block centre)` : `${OVER_SOURCE} (Tax Authority)`,
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

/** A GovMap row, with year built (and gaps in area/rooms) from the Tax Authority copy of the same sale. */
export function govmapRowToDeal(r: GovmapRow, loc: { lat: number; lng: number; approx: boolean }, tax?: OverRow): Deal {
  const date = govDate(r);
  const year = Number(date.slice(0, 4));
  const yearBuilt = tax?.year_built ?? undefined;
  const id = r.deal_id ?? r.objectid ?? `${norm(r.gush)}-${norm(r.parcel)}-${subOf(r.sub_parcel) ?? ""}-${date}-${r.deal_amount}`;
  return {
    id: `gm-${id}`,
    evidence: "completed_deal",
    source: loc.approx ? `${OVER_SOURCE} (GovMap, block centre)` : `${OVER_SOURCE} (GovMap)`,
    date,
    price: r.deal_amount ?? 0,
    location: { lat: loc.lat, lng: loc.lng },
    address: { city: r.settlement ? normaliseTaxCity(r.settlement) : "", street: r.street ?? "", number: r.house_num ?? "" },
    parcel: { block: norm(r.gush)!, parcel: norm(r.parcel)!, subParcel: subOf(r.sub_parcel) },
    area: r.asset_area ?? tax?.area_sqm ?? 0,
    rooms: r.rooms ?? tax?.rooms ?? 0,
    floor: floorFromGovmap(r.floor),
    yearBuilt,
    newBuild: yearBuilt !== undefined && yearBuilt >= year - 1,
    offPlan: yearBuilt !== undefined && yearBuilt > year,
    kind: r.deal_nature ?? undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Tables

export function ensureOverDealTables(db: Database) {
  db.exec(`
    DROP TABLE IF EXISTS over_auth; DROP TABLE IF EXISTS over_signin;
    DROP TABLE IF EXISTS over_rows; DROP TABLE IF EXISTS over_blocks;
    CREATE TABLE IF NOT EXISTS over_sales (source TEXT, id TEXT, block INTEGER, date TEXT, sale_key TEXT, residential INTEGER, json TEXT, PRIMARY KEY (source, id));
    CREATE INDEX IF NOT EXISTS over_sales_block ON over_sales(block, date);
    CREATE TABLE IF NOT EXISTS over_block_pulls (source TEXT, block INTEGER, date_from TEXT, fetched TEXT, rows INTEGER, excluded TEXT, PRIMARY KEY (source, block));
    CREATE TABLE IF NOT EXISTS over_block_points (block INTEGER PRIMARY KEY, lat REAL, lng REAL, at TEXT);
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
  const out = new Set<number>();
  for (const r of rows) if (metres(lat, lng, r.lat, r.lng) <= radiusM) out.add(r.block);
  return [...out].sort((a, b) => a - b);
}

function metres(lat1: number, lng1: number, lat2: number, lng2: number) {
  const k = Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot((lat2 - lat1) * 111_320, (lng2 - lng1) * 111_320 * k);
}

// ---------------------------------------------------------------------------------------------
// Calls

type Api = Pick<OverApi, "get">;

async function pageBlock<T>(api: Api, path: string, block: number, dateFrom: string, today: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 50_000; offset += PAGE) {
    const page = await api.get<{ data?: T[] }>(path, { gush: block, date_from: dateFrom, date_to: today, sort: "date_asc", limit: PAGE, offset });
    const rows = page.data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error(`Over: block ${block} has more rows than expected`);
}

/** Every Tax Authority copy row of one block in a date window, paging to the end. */
export const pullTaxBlock = (api: Api, block: number, dateFrom: string, today: string) => pageBlock<OverRow>(api, "/deals/search", block, dateFrom, today);
/** Every GovMap row of one block in a date window, paging to the end. */
export const pullGovmapBlock = (api: Api, block: number, dateFrom: string, today: string) => pageBlock<GovmapRow>(api, "/deals/govmap/search", block, dateFrom, today);

/**
 * Newest sale each mirror holds for a city (to today: GovMap has dates up to 2048 as published).
 * Over filters by the city name as published, so the name and its Tax Authority form are tried.
 */
export async function cityNewest(api: Api, city: string, today: string): Promise<{ tax?: string; govmap?: string }> {
  const names = [...new Set([city, normaliseTaxCity(city)].filter(Boolean))];
  let tax: string | undefined, govmap: string | undefined;
  for (const name of names) {
    const p = { settlement: name, sort: "date_desc", limit: 1, date_to: today };
    const t = await api.get<{ data?: OverRow[] }>("/deals/search", p).then((r) => r.data?.[0]?.date).catch(() => undefined);
    const g = await api.get<{ data?: GovmapRow[] }>("/deals/govmap/search", p).then((r) => r.data?.[0] && govDate(r.data[0])).catch(() => undefined);
    if (t && (!tax || t > tax)) tax = t;
    if (g && (!govmap || g > govmap)) govmap = g;
  }
  return { tax, govmap };
}

/**
 * Known-gap blocks have no mapped parcels, so blocksNear can't see them. Their place comes from
 * one GovMap row (cached for good; blocks don't move). Returns those within reach of the point.
 */
export async function gapBlocksNear(db: Database, api: Api, lat: number, lng: number, radiusM: number, known = KNOWN_GAP_BLOCKS): Promise<number[]> {
  const get = db.prepare(`SELECT lat, lng FROM over_block_points WHERE block = ?`);
  const put = db.prepare(`INSERT OR REPLACE INTO over_block_points (block, lat, lng, at) VALUES (?, ?, ?, ?)`);
  const out: number[] = [];
  for (const block of known) {
    let p = get.get(block) as { lat: number | null; lng: number | null } | null;
    if (!p) {
      let r: GovmapRow | undefined;
      try {
        r = (await api.get<{ data?: GovmapRow[] }>("/deals/govmap/search", { gush: block, limit: 1 })).data?.[0];
      } catch {
        continue; // a failed call is not "no sales": ask again next time
      }
      p = r && inIsrael(r.lat, r.lon) ? { lat: r.lat!, lng: r.lon! } : { lat: null, lng: null };
      put.run(block, p.lat, p.lng, new Date().toISOString());
    }
    // A block spans a few hundred metres; its one point may sit at the far edge.
    if (p.lat !== null && p.lng !== null && metres(lat, lng, p.lat, p.lng) <= radiusM + 300) out.push(block);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The pull

export interface PullOptions {
  api?: Api;
  fetch?: OverFetch;
  parcelLayer?: ParcelLayer;
  radiusM?: number;
  months?: number;
  marginDays?: number;
  cacheDays?: number;
  today?: string;
  gapBlocks?: Set<number>;
}

/**
 * Pull Over for one request: both mirrors, every block near the subject, the window the
 * request's searches cover. Stores one deal per sale (never over an uploaded row) and the
 * request's Over status.
 */
export async function pullOverForRequest(db: Database, requestId: string, opt: PullOptions = {}): Promise<OverPullDetail> {
  ensureOverDealTables(db);
  const r = db.query(`SELECT subject FROM requests WHERE id = ?`).get(requestId) as { subject: string } | null;
  if (!r) throw new Error("request not found");
  const subject = JSON.parse(r.subject);
  const radiusM = opt.radiusM ?? Number(process.env.OVER_RADIUS_M ?? 1000);
  const marginDays = opt.marginDays ?? Number(process.env.OVER_MARGIN_DAYS ?? 30);
  const cacheDays = opt.cacheDays ?? Number(process.env.OVER_CACHE_DAYS ?? 7);
  const today = opt.today ?? iso(Date.now());
  const months = opt.months ?? 12;
  const dateFrom = iso(Date.parse(today) - Math.round(months * 30.44) * DAY);
  const detail: OverPullDetail = {
    blocks: [], blocksPulled: 0, blocksCached: 0, rows: 0, govmapRows: 0, taxRows: 0, stored: 0, excluded: {}, unlocated: 0,
    blind: [], taxMissing: [], govmapMissing: [],
  };
  const save = (status: string) =>
    db.query(`UPDATE requests SET over_status = ?, over_through = ?, over_detail = ? WHERE id = ?`).run(status, detail.through ?? null, JSON.stringify(detail), requestId);
  save("running");
  try {
    const api = opt.api ?? new OverApi(opt.fetch);
    const loc = subject.location as { lat: number; lng: number } | undefined;
    const blocks = new Set<number>(loc ? blocksNear(db, loc.lat, loc.lng, radiusM) : []);
    if (subject.parcel?.block) blocks.add(Number(subject.parcel.block));
    const gapNear = loc ? await gapBlocksNear(db, api, loc.lat, loc.lng, radiusM, opt.gapBlocks ?? KNOWN_GAP_BLOCKS) : [];
    for (const b of gapNear) blocks.add(b);
    detail.blocks = [...blocks].sort((a, b) => a - b);
    if (!detail.blocks.length) throw new Error("no blocks near the property: is the parcel layer loaded?");

    const newest = await cityNewest(api, subject.address.city, today);
    detail.taxNewest = newest.tax;
    detail.govmapNewest = newest.govmap;

    const cachedFrom = db.prepare(`SELECT date_from, fetched, excluded FROM over_block_pulls WHERE source = ? AND block = ?`);
    const fresh = (p: { date_from: string; fetched: string } | null) =>
      !!p && p.date_from <= dateFrom && Date.parse(today) - Date.parse(p.fetched) <= cacheDays * DAY;
    const clear = db.prepare(`DELETE FROM over_sales WHERE source = ? AND block = ?`);
    const ins = db.prepare(`INSERT OR REPLACE INTO over_sales (source, id, block, date, sale_key, residential, json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const mark = db.prepare(`INSERT OR REPLACE INTO over_block_pulls (source, block, date_from, fetched, rows, excluded) VALUES (?, ?, ?, ?, ?, ?)`);
    const addExcluded = (e: Record<string, number>) => { for (const [k, v] of Object.entries(e)) detail.excluded[k] = (detail.excluded[k] ?? 0) + v; };

    for (const block of detail.blocks) {
      const pulled: Source[] = [];
      for (const source of ["govmap", "tax"] as Source[]) {
        const c = cachedFrom.get(source, block) as { date_from: string; fetched: string; excluded: string } | null;
        if (fresh(c)) { addExcluded(JSON.parse(c!.excluded || "{}")); continue; }
        const excluded: Record<string, number> = {};
        let kept = 0;
        db.transaction(() => clear.run(source, block))();
        if (source === "govmap") {
          const rows = (await pullGovmapBlock(api, block, dateFrom, today)).filter((x) => validDate(govDate(x), today));
          db.transaction(() => {
            for (const x of rows) {
              const res = !!x.deal_nature && RESIDENTIAL_NATURES.has(x.deal_nature);
              if (!res) { const k = x.deal_nature || "(none)"; excluded[k] = (excluded[k] ?? 0) + 1; }
              else kept++;
              ins.run("govmap", `gm-${x.deal_id ?? x.objectid ?? crypto.randomUUID()}`, block, govDate(x), saleKey(x.gush, x.parcel, x.sub_parcel, govDate(x)), res ? 1 : 0, JSON.stringify(x));
            }
          })();
        } else {
          const rows = await pullTaxBlock(api, block, dateFrom, today);
          const occ = occurrences(rows, taxKeyOf);
          db.transaction(() => {
            for (const [i, x] of rows.entries()) {
              const res = !!x.nature && RESIDENTIAL_NATURES.has(x.nature);
              if (!res) { const k = x.nature || "(none)"; excluded[k] = (excluded[k] ?? 0) + 1; }
              else kept++;
              const id = dealKey({ block: norm(x.gush)!, parcel: norm(x.helka)!, subParcel: subOf(x.sub_parcel), date: x.date, amount: amountOf(x) ?? undefined }, occ[i]);
              ins.run("tax", id, block, x.date, saleKey(x.gush, x.helka, x.sub_parcel, x.date), res ? 1 : 0, JSON.stringify(x));
            }
          })();
        }
        mark.run(source, block, dateFrom, today, kept, JSON.stringify(excluded));
        addExcluded(excluded);
        pulled.push(source);
      }
      if (pulled.length) {
        detail.blocksPulled++;
        await storeBlock(db, block, dateFrom, opt.parcelLayer, detail);
      } else detail.blocksCached++;
    }

    // Counts and gaps, per block, residential, in the window.
    const counts = db.query(`SELECT block, source, COUNT(*) AS n FROM over_sales WHERE residential = 1 AND date >= ? AND block IN (${detail.blocks.map(() => "?").join(",")}) GROUP BY block, source`)
      .all(dateFrom, ...detail.blocks) as { block: number; source: Source; n: number }[];
    const per = new Map<number, { tax: number; govmap: number }>();
    for (const c of counts) {
      const e = per.get(c.block) ?? { tax: 0, govmap: 0 };
      e[c.source] = c.n;
      per.set(c.block, e);
    }
    const gaps = opt.gapBlocks ?? KNOWN_GAP_BLOCKS;
    for (const b of detail.blocks) {
      const e = per.get(b) ?? { tax: 0, govmap: 0 };
      detail.taxRows += e.tax;
      detail.govmapRows += e.govmap;
      if (gaps.has(b) && !e.tax && !e.govmap) detail.blind.push(b);
      if (e.govmap && !e.tax) detail.taxMissing.push(b);
      if (e.tax && !e.govmap) detail.govmapMissing.push(b);
    }
    detail.rows = (db.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT sale_key FROM over_sales WHERE residential = 1 AND date >= ?1 AND source = 'govmap' AND block IN (${detail.blocks.join(",")})
         UNION ALL
         SELECT t.id FROM over_sales t WHERE t.residential = 1 AND t.date >= ?1 AND t.source = 'tax' AND t.block IN (${detail.blocks.join(",")})
           AND NOT EXISTS (SELECT 1 FROM over_sales g WHERE g.source = 'govmap' AND g.residential = 1 AND g.sale_key = t.sale_key))`,
    ).get(dateFrom) as { n: number }).n;

    const basis = detail.govmapNewest ?? detail.taxNewest;
    if (basis && !detail.blind.length) detail.through = iso(Math.min(Date.parse(basis), Date.parse(today)) - marginDays * DAY);
    save("done");
  } catch (e) {
    detail.error = (e as Error).message;
    detail.through = undefined; // nothing counts as covered by Over
    save("failed");
  }
  return detail;
}

/** Put one block's sales in the library: GovMap row where there is one, else the Tax Authority copy. */
async function storeBlock(db: Database, block: number, dateFrom: string, layer: ParcelLayer | undefined, detail: OverPullDetail) {
  const rows = db.query(`SELECT source, id, sale_key, json FROM over_sales WHERE block = ? AND residential = 1 AND date >= ?`).all(block, dateFrom) as
    { source: Source; id: string; sale_key: string; json: string }[];
  const taxBySale = new Map<string, { id: string; row: OverRow }[]>();
  const govBySale = new Map<string, GovmapRow[]>();
  for (const x of rows) {
    if (x.source === "tax") {
      const l = taxBySale.get(x.sale_key) ?? [];
      l.push({ id: x.id, row: JSON.parse(x.json) });
      taxBySale.set(x.sale_key, l);
    } else {
      const l = govBySale.get(x.sale_key) ?? [];
      l.push(JSON.parse(x.json));
      govBySale.set(x.sale_key, l);
    }
  }
  const place = async (gush: unknown, helka: unknown) => locateParcel(db, layer, norm(gush)!, norm(helka)!).catch(() => null);

  for (const [key, list] of govBySale) {
    const tax = taxBySale.get(key)?.[0]?.row;
    const deals: Deal[] = [];
    for (const g of list) {
      const loc = inIsrael(g.lat, g.lon) ? { lat: g.lat!, lng: g.lon!, approx: false } : await place(g.gush, g.parcel);
      if (!loc) { detail.unlocated++; continue; }
      deals.push(govmapRowToDeal(g, loc, tax));
    }
    if (!deals.length) continue;
    const pk = parcelKeyOf(deals[0]!.parcel!);
    if (uploadHasSale(db, pk, deals[0]!.date)) continue;
    upsertDeals(db, deals);
    dropOtherOverCopies(db, pk, deals[0]!.date, deals.map((d) => d.id));
    detail.stored += deals.length;
  }
  for (const [key, list] of taxBySale) {
    if (govBySale.has(key)) continue;
    const loc = await place(list[0]!.row.gush, list[0]!.row.helka);
    if (!loc) { detail.unlocated += list.length; continue; }
    const deals = list.map((t) => {
      const occ = Number(t.id.match(/#(\d+)$/)?.[1] ?? 1);
      return overRowToDeal(t.row, loc, occ);
    });
    const pk = parcelKeyOf(deals[0]!.parcel!);
    if (uploadHasSale(db, pk, deals[0]!.date)) continue;
    detail.stored += insertDealsIfAbsent(db, deals);
  }
}

// ---------------------------------------------------------------------------------------------
// Checking uploads against Over

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
  /** In an upload, dated within Over's coverage, in neither mirror. */
  missing: CompareRow[];
  /** In an upload and in GovMap, but not in Over's Tax Authority copy. */
  missingTaxCopy: CompareRow[];
  /** Identical rows the upload has several times and Over's Tax Authority copy has once. */
  merged: CompareRow[];
  /** In an upload, dated after the newest sale Over holds for the city (expected to be missing). */
  newer: CompareRow[];
  /** Sales in an upload and in at least one mirror. */
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
  const out: OverComparison = { missing: [], missingTaxCopy: [], merged: [], newer: [], matched: 0 };
  const blocks = new Set(d.blocks.map(String));
  const ph = d.blocks.map(() => "?").join(",");
  const taxIds = new Set((db.query(`SELECT id FROM over_sales WHERE source = 'tax' AND block IN (${ph})`).all(...d.blocks) as { id: string }[]).map((x) => x.id));
  const govKeys = new Set((db.query(`SELECT sale_key FROM over_sales WHERE source = 'govmap' AND block IN (${ph})`).all(...d.blocks) as { sale_key: string }[]).map((x) => x.sale_key));
  const uploads = (db.query(`SELECT json FROM deals WHERE date BETWEEN ? AND ? AND id LIKE 'tax-%'`).all(items.a, items.b) as { json: string }[])
    .map((x) => JSON.parse(x.json) as Deal)
    .filter((x) => x.source.startsWith("tax_authority_export") && x.parcel && blocks.has(x.parcel.block));
  const row = (x: Deal): CompareRow => ({
    id: x.id, date: x.date, price: x.price, rooms: x.rooms || undefined, area: x.area || undefined, fraction: x.fractionSold,
    parcel: `${x.parcel!.block}/${x.parcel!.parcel}${x.parcel!.subParcel ? "/" + x.parcel!.subParcel : ""}`,
  });
  const lastOver = [d.govmapNewest, d.taxNewest].filter(Boolean).sort().pop() ?? "9999";
  const copies = new Map<string, number>();
  for (const x of uploads) {
    const base = x.id.replace(/#\d+$/, "");
    copies.set(base, (copies.get(base) ?? 0) + 1);
  }
  const mergedSeen = new Set<string>();
  for (const x of uploads) {
    const base = x.id.replace(/#\d+$/, "");
    const inTax = taxIds.has(x.id);
    const inGov = govKeys.has(saleKey(x.parcel!.block, x.parcel!.parcel, x.parcel!.subParcel, x.date));
    if (!inTax && x.id !== base && taxIds.has(base)) {
      if (!mergedSeen.has(base)) { mergedSeen.add(base); out.merged.push({ ...row(x), id: base, copies: copies.get(base) }); }
      continue;
    }
    if (inTax || inGov) {
      out.matched++;
      if (!inTax && x.id === base && x.date <= (d.taxNewest ?? "9999")) out.missingTaxCopy.push(row(x));
      continue;
    }
    (x.date > lastOver ? out.newer : out.missing).push(row(x));
  }
  for (const list of [out.missing, out.missingTaxCopy, out.merged, out.newer]) list.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}
