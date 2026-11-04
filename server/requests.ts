/**
 * Report requests and their Tax Authority search plans.
 *
 * A request opens with a preliminary report (data already in the library). The system writes
 * a search plan for the Tax Authority's "מידע נדל"ן" system: city, property type, sale-date
 * period and area band, split so each search should stay under the 150-result limit. Periods
 * already covered by earlier uploads are skipped, so the manual work shrinks as the library
 * grows. Someone with access runs each search and uploads the export; a truncated export is
 * split automatically into two narrower searches. When every search is done, the request
 * becomes final.
 */
import type { Database } from "bun:sqlite";
import type { Subject } from "../src/engine/types";
import { normaliseCity } from "../src/engine/address";
import { ensureTaxTables, importTaxExport, type TaxImportResult } from "./taxImport";
import { normaliseTaxCity, parseTaxExport } from "./connectors/taxExport";
import type { ParcelLayer } from "./connectors/parcels";

/**
 * Row notes are codes, shown in the user's language by the app:
 *   split | remaining | truncated:<total> | cut_upload | no_overlap | city:<file city>
 */
export type ItemStatus = "pending" | "done" | "covered" | "truncated" | "split";

export interface PlanItem {
  id: string;
  requestId: string;
  parentId?: string;
  city: string;
  kind: string;
  from: string; // ISO
  to: string; // ISO
  areaFrom: number;
  areaTo: number;
  status: ItemStatus;
  pullId?: string;
  note?: string;
}

export interface RequestRecord {
  id: string;
  createdAt: string;
  status: "preliminary" | "final";
  finalAt?: string;
  subject: Subject;
  items: PlanItem[];
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(d) + n * DAY);

export function ensureRequestTables(db: Database) {
  ensureTaxTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, created_at TEXT, status TEXT, final_at TEXT, subject TEXT);
    CREATE TABLE IF NOT EXISTS plan_items (
      id TEXT PRIMARY KEY, request_id TEXT, parent_id TEXT, city TEXT, kind TEXT, date_from TEXT, date_to TEXT,
      area_from REAL, area_to REAL, status TEXT, pull_id TEXT, note TEXT
    );
    CREATE INDEX IF NOT EXISTS plan_items_req ON plan_items(request_id);
  `);
}

/** Area band searched for a subject of area A (sqm): roughly −25% … +35%. */
export function areaBand(area: number): [number, number] {
  return [Math.max(20, Math.floor((area * 0.75) / 5) * 5), Math.ceil((area * 1.35) / 5) * 5];
}

/**
 * Is a search already covered by earlier complete (non-truncated) uploads for the same city?
 * Several uploads may cover it together: consecutive periods with a wide-enough area band, or
 * adjacent area bands over the whole period (that is how split searches come back).
 * The newest period counts as covered only by uploads that run to within a week of its end.
 */
export function coveringPull(db: Database, it: Pick<PlanItem, "city" | "from" | "to" | "areaFrom" | "areaTo">): string | null {
  ensureTaxTables(db);
  const city = normaliseCity(normaliseTaxCity(it.city));
  const pulls = (db.query(`SELECT id, city, date_from, date_to, area_from, area_to FROM tax_pulls WHERE truncated = 0`).all() as any[])
    .filter((p) => p.city && p.date_from && p.date_to && normaliseCity(normaliseTaxCity(p.city)) === city)
    .map((p) => ({ id: p.id as string, from: p.date_from as string, to: p.date_to as string, aFrom: p.area_from ?? 0, aTo: p.area_to ?? Infinity }));
  const recent = Date.parse(it.to) >= Date.now() - 2 * DAY;
  const needTo = recent ? addDays(it.to, -7) : it.to;

  const unionCovers = (spans: [number, number][], lo: number, hi: number, gap: number) => {
    spans.sort((a, b) => a[0] - b[0]);
    let reach = lo;
    for (const [a, b] of spans) {
      if (a > reach + gap) break;
      reach = Math.max(reach, b);
      if (reach >= hi) return true;
    }
    return reach >= hi;
  };
  // 1. Periods joined end to end, each with an area band at least as wide.
  const byArea = pulls.filter((p) => p.aFrom <= it.areaFrom && p.aTo >= it.areaTo);
  if (unionCovers(byArea.map((p) => [Date.parse(p.from), Date.parse(p.to)]), Date.parse(it.from), Date.parse(needTo), DAY))
    return byArea[0]?.id ?? null;
  // 2. Area bands joined side by side, each over the whole period.
  const byDate = pulls.filter((p) => p.from <= it.from && p.to >= needTo);
  if (unionCovers(byDate.map((p) => [p.aFrom, p.aTo]), it.areaFrom, it.areaTo, 1)) return byDate[0]?.id ?? null;
  return null;
}

interface PullSpan { id: string; from: number; to: number; aFrom: number; aTo: number }

/** Complete (not cut-off) uploads for a city, as day numbers. */
function cityPulls(db: Database, city: string): PullSpan[] {
  ensureTaxTables(db);
  const c = normaliseCity(normaliseTaxCity(city));
  return (db.query(`SELECT id, city, date_from, date_to, area_from, area_to FROM tax_pulls WHERE truncated = 0`).all() as any[])
    .filter((p) => p.city && p.date_from && p.date_to && normaliseCity(normaliseTaxCity(p.city)) === c)
    .map((p) => ({ id: p.id, from: Date.parse(p.date_from) / DAY, to: Date.parse(p.date_to) / DAY, aFrom: p.area_from ?? 0, aTo: p.area_to ?? Infinity }));
}

/**
 * Which days of a search are covered by complete uploads whose area band includes the
 * search's band. Days are inclusive; a 1-day hole between uploads counts as covered.
 * The newest search needs coverage only up to a week before its end (registrations lag).
 */
export function dateCoverage(it: Pick<PlanItem, "from" | "to" | "areaFrom" | "areaTo">, pulls: PullSpan[], todayDays = Date.now() / DAY) {
  const from = Date.parse(it.from) / DAY;
  let to = Date.parse(it.to) / DAY;
  if (to >= todayDays - 2) to -= 7;
  const spans = pulls
    .filter((p) => p.aFrom <= it.areaFrom && p.aTo >= it.areaTo && p.to >= from && p.from <= to)
    .map((p) => ({ id: p.id, a: Math.max(p.from, from), b: Math.min(p.to, to) }))
    .sort((x, y) => x.a - y.a);
  const covered: { a: number; b: number; id: string }[] = [];
  const gaps: { a: number; b: number }[] = [];
  let cursor = from;
  for (const s of spans) {
    if (s.a > cursor + 1) gaps.push({ a: cursor, b: s.a - 1 });
    if (s.b >= cursor) { covered.push({ a: Math.max(s.a, cursor), b: s.b, id: s.id }); cursor = s.b + 1; }
  }
  if (cursor <= to) gaps.push({ a: cursor, b: to });
  return { covered, gaps };
}

const dayIso = (d: number) => iso(Math.round(d) * DAY);

/**
 * Bring a request's open searches up to date with everything uploaded so far – whichever
 * row a file was uploaded to. A search fully covered becomes "covered"; one partly covered
 * is replaced by its covered pieces and new searches for the remaining dates.
 */
export function reconcileRequest(db: Database, requestId: string, todayDays = Date.now() / DAY) {
  // Notes from before they became codes (free text) are dropped on open searches.
  db.query(`UPDATE plan_items SET note = NULL WHERE request_id = ? AND status = 'pending' AND note LIKE '% %'`).run(requestId);
  const rows = (db.query(`SELECT * FROM plan_items WHERE request_id = ? AND status = 'pending'`).all(requestId) as any[]).map(rowToItem);
  for (const it of rows) {
    const pulls = cityPulls(db, it.city);
    const { covered, gaps } = dateCoverage(it, pulls, todayDays);
    if (!covered.length) {
      const byArea = coveringPull(db, it); // adjacent area bands over the whole period
      if (byArea) db.query(`UPDATE plan_items SET status = 'covered', pull_id = ? WHERE id = ?`).run(byArea, it.id);
      continue;
    }
    if (!gaps.length) {
      db.query(`UPDATE plan_items SET status = 'covered', pull_id = ?, note = NULL WHERE id = ?`).run(covered[0]!.id, it.id);
      continue;
    }
    const base = { requestId, parentId: it.id, city: it.city, kind: it.kind, areaFrom: it.areaFrom, areaTo: it.areaTo };
    for (const c of covered) insertItem(db, { ...base, id: crypto.randomUUID(), from: dayIso(c.a), to: dayIso(c.b), status: "covered", pullId: c.id });
    for (const g of gaps) insertItem(db, { ...base, id: crypto.randomUUID(), from: dayIso(g.a), to: dayIso(g.b), status: "pending", note: "remaining" });
    db.query(`UPDATE plan_items SET status = 'split', note = ? WHERE id = ?`).run("split", it.id);
  }
  refreshStatus(db, requestId);
}

/** Reconcile every open request (after an upload not tied to a search). */
export function reconcileAll(db: Database) {
  ensureRequestTables(db);
  for (const r of db.query(`SELECT id FROM requests WHERE status = 'preliminary'`).all() as { id: string }[]) reconcileRequest(db, r.id);
}

export function buildPlan(subject: Subject, today: string, months = 12, chunkMonths = 3): Omit<PlanItem, "id" | "requestId" | "status">[] {
  const area =
    subject.area.mode === "declared" ? subject.area.area : subject.area.levels.reduce((s, l) => s + l.internalArea, 0) * 1.1;
  const [areaFrom, areaTo] = areaBand(area);
  const items: Omit<PlanItem, "id" | "requestId" | "status">[] = [];
  let to = today;
  for (let m = 0; m < months; m += chunkMonths) {
    const d = new Date(to + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() - chunkMonths);
    const from = addDays(iso(d.getTime()), 1);
    items.push({ city: subject.address.city, kind: "דירת מגורים", from, to, areaFrom, areaTo });
    to = addDays(from, -1);
  }
  return items;
}

function rowToItem(r: any): PlanItem {
  return {
    id: r.id, requestId: r.request_id, parentId: r.parent_id ?? undefined, city: r.city, kind: r.kind,
    from: r.date_from, to: r.date_to, areaFrom: r.area_from, areaTo: r.area_to, status: r.status,
    pullId: r.pull_id ?? undefined, note: r.note ?? undefined,
  };
}

function insertItem(db: Database, it: PlanItem) {
  db.query(
    `INSERT INTO plan_items (id, request_id, parent_id, city, kind, date_from, date_to, area_from, area_to, status, pull_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(it.id, it.requestId, it.parentId ?? null, it.city, it.kind, it.from, it.to, it.areaFrom, it.areaTo, it.status, it.pullId ?? null, it.note ?? null);
}

export function createRequest(db: Database, subject: Subject, today = iso(Date.now())): RequestRecord {
  ensureRequestTables(db);
  const id = crypto.randomUUID();
  db.query(`INSERT INTO requests (id, created_at, status, subject) VALUES (?, ?, 'preliminary', ?)`).run(id, new Date().toISOString(), JSON.stringify(subject));
  // Where 3-month searches have hit the 150 limit before (busy cities), plan monthly ones.
  const city = normaliseCity(normaliseTaxCity(subject.address.city));
  const busy = (db.query(`SELECT city FROM tax_pulls WHERE truncated = 1`).all() as { city: string | null }[])
    .some((p) => p.city && normaliseCity(normaliseTaxCity(p.city)) === city);
  for (const p of buildPlan(subject, today, 12, busy ? 1 : 3)) {
    insertItem(db, { ...p, id: crypto.randomUUID(), requestId: id, status: "pending" });
  }
  reconcileRequest(db, id, Date.parse(today) / DAY);
  return getRequest(db, id)!;
}

export function getRequest(db: Database, id: string, reconcile = false): RequestRecord | null {
  ensureRequestTables(db);
  if (reconcile) reconcileRequest(db, id);
  const r: any = db.query(`SELECT * FROM requests WHERE id = ?`).get(id);
  if (!r) return null;
  const items = (db.query(`SELECT * FROM plan_items WHERE request_id = ? ORDER BY date_to DESC, area_from`).all(id) as any[]).map(rowToItem);
  return { id: r.id, createdAt: r.created_at, status: r.status, finalAt: r.final_at ?? undefined, subject: JSON.parse(r.subject), items };
}

export function listRequests(db: Database, onlyOpen = true): RequestRecord[] {
  ensureRequestTables(db);
  const ids = db.query(`SELECT id FROM requests ${onlyOpen ? "WHERE status = 'preliminary'" : ""} ORDER BY created_at DESC LIMIT 200`).all() as { id: string }[];
  return ids.map((x) => getRequest(db, x.id, onlyOpen)!).filter(Boolean);
}

function refreshStatus(db: Database, id: string) {
  const open = db.query(`SELECT COUNT(*) AS n FROM plan_items WHERE request_id = ? AND status IN ('pending')`).get(id) as { n: number };
  if (open.n === 0) {
    db.query(`UPDATE requests SET status = 'final', final_at = COALESCE(final_at, ?) WHERE id = ?`).run(new Date().toISOString(), id);
  }
}

/** Check that an uploaded export matches the search it was uploaded for. */
export function criteriaMismatch(item: PlanItem, text: string): string[] {
  const c = parseTaxExport(text).criteria;
  const out: string[] = [];
  if (c.city && normaliseCity(normaliseTaxCity(c.city)) !== normaliseCity(normaliseTaxCity(item.city))) out.push(`city ${c.city} ≠ ${item.city}`);
  if (c.from && c.from > addDays(item.from, 3)) out.push(`starts ${c.from}, search needs ${item.from}`);
  if (c.to && c.to < addDays(item.to, -3)) out.push(`ends ${c.to}, search needs ${item.to}`);
  if (c.areaFrom !== undefined && c.areaFrom > item.areaFrom + 1) out.push(`area from ${c.areaFrom} > ${item.areaFrom}`);
  if (c.areaTo !== undefined && c.areaTo < item.areaTo - 1) out.push(`area to ${c.areaTo} < ${item.areaTo}`);
  return out;
}

/** Split a truncated search in two: by period while longer than a month, then by area. */
export function splitItem(it: PlanItem): [PlanItem, PlanItem] {
  const days = (Date.parse(it.to) - Date.parse(it.from)) / DAY;
  const base = { requestId: it.requestId, parentId: it.id, city: it.city, kind: it.kind, status: "pending" as const };
  if (days > 31) {
    const mid = iso(Date.parse(it.from) + Math.floor(days / 2) * DAY);
    return [
      { ...base, id: crypto.randomUUID(), from: it.from, to: mid, areaFrom: it.areaFrom, areaTo: it.areaTo },
      { ...base, id: crypto.randomUUID(), from: addDays(mid, 1), to: it.to, areaFrom: it.areaFrom, areaTo: it.areaTo },
    ];
  }
  const midA = Math.round((it.areaFrom + it.areaTo) / 2);
  return [
    { ...base, id: crypto.randomUUID(), from: it.from, to: it.to, areaFrom: it.areaFrom, areaTo: midA },
    { ...base, id: crypto.randomUUID(), from: it.from, to: it.to, areaFrom: midA + 1, areaTo: it.areaTo },
  ];
}

export interface UploadOutcome {
  import: TaxImportResult;
  mismatch: string[];
  item: PlanItem;
  newItems: PlanItem[];
  request: RequestRecord;
}

export async function uploadToItem(
  db: Database,
  requestId: string,
  itemId: string,
  text: string,
  parcelLayer: ParcelLayer | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadOutcome> {
  ensureRequestTables(db);
  const row: any = db.query(`SELECT * FROM plan_items WHERE id = ? AND request_id = ?`).get(itemId, requestId);
  if (!row) throw new Error("search not found");
  const item = rowToItem(row);
  const mismatch = criteriaMismatch(item, text);
  const imp = await importTaxExport(db, text, parcelLayer, itemId, fetchImpl);
  const newItems: PlanItem[] = [];
  let status: ItemStatus = item.status;
  let note: string | undefined;
  const cityWrong = mismatch.some((m) => m.startsWith("city"));
  if (cityWrong) {
    note = `city:${parseTaxExport(text).criteria.city ?? ""}`;
  } else if (imp.truncated && !mismatch.length && item.status === "pending") {
    // This very search hit the limit: split it in two narrower ones.
    status = "truncated";
    note = `truncated:${imp.totalReported ?? ""}`;
    for (const child of splitItem(item)) { insertItem(db, child); newItems.push(child); }
  } else if (imp.truncated) {
    note = "cut_upload";
  }
  db.query(`UPDATE plan_items SET status = ?, pull_id = COALESCE(pull_id, ?), note = ? WHERE id = ?`).run(status, imp.pullId, note ?? null, itemId);
  reconcileRequest(db, requestId);
  let after = rowToItem(db.query(`SELECT * FROM plan_items WHERE id = ?`).get(itemId));
  if (after.status === "covered" && after.pullId === imp.pullId) {
    db.query(`UPDATE plan_items SET status = 'done' WHERE id = ?`).run(itemId);
    after = { ...after, status: "done" };
  }
  if (after.status === "pending" && !after.note && !imp.truncated) {
    db.query(`UPDATE plan_items SET note = ? WHERE id = ?`).run("no_overlap", itemId);
    after.note = "no_overlap";
  }
  status = after.status;
  note = after.note;
  return { import: imp, mismatch, item: { ...item, status, pullId: imp.pullId, note }, newItems, request: getRequest(db, requestId)! };
}
