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

export type ItemStatus = "pending" | "done" | "covered" | "truncated";

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
  for (const p of buildPlan(subject, today)) {
    const cover = coveringPull(db, p);
    insertItem(db, { ...p, id: crypto.randomUUID(), requestId: id, status: cover ? "covered" : "pending", pullId: cover ?? undefined });
  }
  refreshStatus(db, id);
  return getRequest(db, id)!;
}

export function getRequest(db: Database, id: string): RequestRecord | null {
  ensureRequestTables(db);
  const r: any = db.query(`SELECT * FROM requests WHERE id = ?`).get(id);
  if (!r) return null;
  const items = (db.query(`SELECT * FROM plan_items WHERE request_id = ? ORDER BY date_to DESC, area_from`).all(id) as any[]).map(rowToItem);
  return { id: r.id, createdAt: r.created_at, status: r.status, finalAt: r.final_at ?? undefined, subject: JSON.parse(r.subject), items };
}

export function listRequests(db: Database, onlyOpen = true): RequestRecord[] {
  ensureRequestTables(db);
  const ids = db.query(`SELECT id FROM requests ${onlyOpen ? "WHERE status = 'preliminary'" : ""} ORDER BY created_at DESC LIMIT 200`).all() as { id: string }[];
  return ids.map((x) => getRequest(db, x.id)!).filter(Boolean);
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
  if (mismatch.length) {
    note = `file does not match this search: ${mismatch.join("; ")} – data was kept, search still open`;
  } else if (imp.truncated) {
    status = "truncated";
    note = `${imp.totalReported ?? "150+"} results exceed the 150 limit – split into two narrower searches`;
    for (const child of splitItem(item)) { insertItem(db, child); newItems.push(child); }
  } else {
    status = "done";
  }
  db.query(`UPDATE plan_items SET status = ?, pull_id = ?, note = ? WHERE id = ?`).run(status, imp.pullId, note ?? null, itemId);
  refreshStatus(db, requestId);
  return { import: imp, mismatch, item: { ...item, status, pullId: imp.pullId, note }, newItems, request: getRequest(db, requestId)! };
}
