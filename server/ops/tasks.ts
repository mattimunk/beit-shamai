/**
 * Automatic tasks. Each property's real state (answers, documents, tour shots, market data,
 * appraisal, full-appraisal workflow) is turned into the set of tasks it needs right now.
 * Reconciling is idempotent: a task exists once per (property, key); it closes itself when
 * its condition clears (a floor plan uploaded → its task is done, by "system"), and reopens
 * if the condition returns. A task an admin closed by hand (with a reason) stays closed.
 *
 * Owners: admin (operations), user (the applicant), appraiser (full appraisals), system.
 * Priority: 1 urgent · 2 high · 3 normal · 4 low.
 */
import type { Database } from "bun:sqlite";
import { normaliseCity } from "../../src/engine/address";
import { flags, isKnown, tourLayout } from "../../src/dossier/schema";
import { ownershipKinds, readiness, type Freshness, type MarketLevel, type Readiness } from "../../src/ops/readiness";
import { buildShotList, ensureCaptureTables } from "../capture";
import { CAPTURE_LINK_HOURS, ensureCaseTables, getCase, newCaptureLink, type CaseRecord } from "../cases";
import { normaliseTaxCity } from "../connectors/taxExport";
import { lastRun } from "../db";
import { enqueue, stepUrl, type ReminderItem } from "./mail";
import { ensureOpsTables, getSettings, logEvent, type OpsSettings } from "./store";

export type Party = "admin" | "user" | "appraiser" | "system";
export type TaskStatus = "open" | "done" | "dismissed";
export type Category = "review" | "market" | "documents" | "media" | "application" | "appraisal" | "full" | "communication";

export interface TaskRow {
  id: string; caseId: string; userId?: string; key: string; party: Party; category: Category; priority: number; status: TaskStatus;
  createdAt: string; updatedAt: string; dueAt?: string; doneAt?: string; doneBy?: string; resolution?: string; note?: string;
  snoozeUntil?: string; assignee?: string; data: any; remindersSent: number; lastReminderAt?: string; remindersPaused: boolean;
}

const toTask = (r: any): TaskRow => ({
  id: r.id, caseId: r.case_id ?? "", userId: r.user_id || undefined, key: r.key, party: r.party, category: r.category, priority: r.priority,
  status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, dueAt: r.due_at ?? undefined, doneAt: r.done_at ?? undefined,
  doneBy: r.done_by ?? undefined, resolution: r.resolution ?? undefined, note: r.note ?? undefined, snoozeUntil: r.snooze_until ?? undefined,
  assignee: r.assignee ?? undefined, data: r.data ? JSON.parse(r.data) : {}, remindersSent: r.reminders_sent ?? 0,
  lastReminderAt: r.last_reminder_at ?? undefined, remindersPaused: !!r.reminders_paused,
});

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

// ---- Market data --------------------------------------------------------------------------------

export interface CityMarket {
  city: string;
  /** When the source was last checked (a Tax Authority upload or a successful sync) – not the newest deal. */
  lastChecked?: string;
  checkedBy?: "tax_upload" | "sync";
  /** Date of the newest deal on file for the city. */
  latestDeal?: string;
  deals12m: number;
  dealsTotal: number;
  freshness: Freshness;
}

const cityKey = (c: string) => normaliseCity(normaliseTaxCity(c));

const cityMemo = new Map<string, { until: number; m: CityMarket }>();
/** Forget cached city figures (after an upload). */
export const resetMarketCache = () => cityMemo.clear();

export function cityMarket(db: Database, city: string, s: OpsSettings, now = Date.now()): CityMarket {
  const key = cityKey(city);
  const memoKey = `${key}|${s.freshDays}|${s.outdatedDays}`;
  const hit = cityMemo.get(memoKey);
  if (hit && hit.until > Date.now()) return hit.m;
  const m = computeCityMarket(db, city, key, s, now);
  cityMemo.set(memoKey, { until: Date.now() + 60_000, m });
  return m;
}

function computeCityMarket(db: Database, city: string, key: string, s: OpsSettings, now: number): CityMarket {
  let lastTax: string | undefined;
  try {
    for (const p of db.query(`SELECT city, at FROM tax_pulls WHERE at IS NOT NULL`).all() as { city: string | null; at: string }[]) {
      if (p.city && cityKey(p.city) === key && (!lastTax || p.at > lastTax)) lastTax = p.at;
    }
  } catch { /* no uploads yet */ }
  let lastSync: string | undefined;
  try { lastSync = lastRun(db, "deals", city)?.started_at; } catch { /* no job table */ }
  const lastChecked = [lastTax, lastSync].filter(Boolean).sort().pop();
  let latestDeal: string | undefined;
  let deals12m = 0;
  let dealsTotal = 0;
  try {
    const since = iso(now - 365 * DAY).slice(0, 10);
    const names = (db.query(`SELECT DISTINCT city FROM deals`).all() as { city: string }[]).map((r) => r.city).filter((c) => c && cityKey(c) === key);
    if (names.length) {
      const ph = names.map(() => "?").join(",");
      const r = db.query(`SELECT MAX(date) AS latest, COUNT(*) AS n, SUM(CASE WHEN date >= ? THEN 1 ELSE 0 END) AS recent FROM deals WHERE city IN (${ph})`).get(since, ...names) as any;
      latestDeal = r?.latest ?? undefined;
      dealsTotal = r?.n ?? 0;
      deals12m = r?.recent ?? 0;
    }
  } catch { /* no deals table */ }
  const age = lastChecked ? (now - Date.parse(lastChecked)) / DAY : Infinity;
  const freshness: Freshness = !lastChecked ? (dealsTotal ? "outdated" : "none") : age <= s.freshDays ? "fresh" : age <= s.outdatedDays ? "review" : "outdated";
  return { city, lastChecked, checkedBy: lastChecked ? (lastChecked === lastTax ? "tax_upload" : "sync") : undefined, latestDeal, deals12m, dealsTotal, freshness };
}

export interface CaseMarket { city?: CityMarket; nearby: number; level: MarketLevel; pendingSearches: number; requestId?: string }

/** Deals stored once in the shared library that are near this property and recent enough. */
export function nearbyDeals(db: Database, lat: number, lng: number, radiusM: number, months: number, now = Date.now()): number {
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.cos((lat * Math.PI) / 180));
  const since = iso(now - months * 30.4 * DAY).slice(0, 10);
  try {
    const rows = db.query(`SELECT lat, lng FROM deals WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND date >= ?`)
      .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng, since) as { lat: number; lng: number }[];
    const R = 6_371_000;
    return rows.filter((r) => {
      const a = Math.sin(((r.lat - lat) * Math.PI) / 360) ** 2 + Math.cos((lat * Math.PI) / 180) * Math.cos((r.lat * Math.PI) / 180) * Math.sin(((r.lng - lng) * Math.PI) / 360) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a)) <= radiusM;
    }).length;
  } catch { return 0; }
}

export const levelFor = (n: number): MarketLevel => (n >= 12 ? "high" : n >= 6 ? "medium" : n >= 3 ? "low" : n > 0 ? "insufficient" : "none");

export function caseMarket(db: Database, c: CaseRecord, s: OpsSettings, now = Date.now()): CaseMarket {
  const city = c.subject.address.city?.trim();
  if (!city) return { nearby: 0, level: "none", pendingSearches: 0 };
  const nearby = nearbyDeals(db, c.subject.location.lat, c.subject.location.lng, s.marketRadiusM, s.marketMonths, now);
  let pendingSearches = 0;
  let requestId: string | undefined;
  try {
    const r = db.query(`SELECT id FROM requests WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`).get(c.id) as { id: string } | null;
    if (r) {
      requestId = r.id;
      pendingSearches = (db.query(`SELECT COUNT(*) AS n FROM plan_items WHERE request_id = ? AND status IN ('pending','truncated')`).get(r.id) as { n: number }).n;
    }
  } catch { /* no requests yet */ }
  return { city: cityMarket(db, city, s, now), nearby, level: levelFor(nearby), pendingSearches, requestId };
}

// ---- Gathering a property's state ------------------------------------------------------------------

export interface CaseState {
  c: CaseRecord;
  docs: { id: string; kind: string; addedAt: string }[];
  shots: { done: number; total: number; missing: number };
  market: CaseMarket;
  appraisal?: { id: string; status: string; createdAt: string };
  full?: { id: string; status: string; payment: string; appraiser?: string; checklist: { key: string; done: boolean }[]; quote?: number };
  readiness: Readiness;
  verifiedDocIds: string[];
}

export function caseState(db: Database, caseId: string, now = Date.now()): CaseState | null {
  ensureOpsTables(db);
  const c = getCase(db, caseId);
  if (!c) return null;
  const s = getSettings(db);
  let docs: CaseState["docs"] = [];
  try { docs = db.query(`SELECT id, kind, added_at AS addedAt FROM documents WHERE case_id = ? ORDER BY added_at`).all(caseId) as any[]; } catch { /* none */ }
  ensureCaptureTables(db);
  const layout = c.dossier ? tourLayout(c.dossier) : null;
  const ids = layout ? buildShotList(layout).map((x) => x.id) : [];
  const captured = new Set((db.query(`SELECT shot_id FROM captures WHERE case_id = ?`).all(caseId) as { shot_id: string }[]).map((r) => r.shot_id));
  const done = layout ? ids.filter((i) => captured.has(i)).length : captured.size;
  const total = layout ? ids.length : Math.max(captured.size, 0);
  const market = caseMarket(db, c, s, now);
  const ap = db.query(`SELECT id, status, created_at FROM appraisals WHERE case_id = ? AND kind = 'preliminary' AND status != 'superseded' ORDER BY created_at DESC LIMIT 1`).get(caseId) as any;
  const fr = db.query(`SELECT * FROM full_requests WHERE case_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1`).get(caseId) as any;
  const verifyTask = db.query(`SELECT data FROM tasks WHERE case_id = ? AND key = 'verify_docs'`).get(caseId) as { data: string | null } | null;
  const verifiedDocIds: string[] = verifyTask?.data ? JSON.parse(verifyTask.data).verified ?? [] : [];
  const a = c.subject.address;
  const r = readiness({
    dossier: c.dossier,
    hasAddress: !!(a.city && a.street),
    hasParcel: !!(c.dossier?.location.parcel || c.subject.parcel),
    docKinds: docs.map((d) => d.kind),
    shots: { done, total },
    market: { level: market.level, freshness: market.city?.freshness ?? "none" },
    docsVerified: docs.length > 0 && docs.every((d) => verifiedDocIds.includes(d.id)),
  });
  return {
    c, docs, shots: { done, total, missing: Math.max(0, total - done) }, market,
    appraisal: ap ? { id: ap.id, status: ap.status, createdAt: ap.created_at } : undefined,
    full: fr ? { id: fr.id, status: fr.status, payment: fr.payment ?? "none", appraiser: fr.appraiser ?? undefined, checklist: fr.checklist ? JSON.parse(fr.checklist) : [], quote: fr.quote_nis ?? undefined } : undefined,
    readiness: r,
    verifiedDocIds,
  };
}

// ---- Rules -------------------------------------------------------------------------------------

interface Want { key: string; party: Party; category: Category; priority: number; dueDays?: number; data?: any }

const ACTIVE = new Set(["submitted", "working", "prelim_review", "prelim_sent", "full_requested", "full_in_progress"]);
/** Tasks that only humans open and close (the rules never close them). */
const MANUAL = (key: string) => key === "user_responded" || key.startsWith("clarify:") || key.startsWith("custom:");
/** Tasks the rules may reopen after an admin closed them, when there is something new. */
const REOPENS = new Set(["verify_docs"]);

export function wantedTasks(st: CaseState): Want[] {
  const { c } = st;
  const d = c.dossier;
  const out: Want[] = [];
  const full = !!st.full;
  const a = c.subject.address;
  const has = (k: string) => st.docs.some((x) => x.kind === k);

  if (c.status === "draft") {
    if (c.ownerId) out.push({ key: "complete_application", party: "user", category: "application", priority: 4, dueDays: 10, data: { progress: st.readiness.completion } });
    return out;
  }
  if (!ACTIVE.has(c.status)) return out;

  if (c.status === "submitted") out.push({ key: "review_new", party: "admin", category: "review", priority: 2, dueDays: 1 });
  if (!a.city || !a.street) out.push({ key: "address", party: "user", category: "application", priority: 2, dueDays: 3 });
  if (d && !isKnown(d.size.interior)) out.push({ key: "size", party: "user", category: "application", priority: 2, dueDays: 3 });

  // Market data: manual Tax Authority searches are a normal step of every property.
  const m = st.market;
  if (a.city) {
    const weak = m.level === "none" || m.level === "insufficient";
    const stale = m.city?.freshness === "outdated" || m.city?.freshness === "none";
    if (m.pendingSearches > 0 || weak || stale)
      out.push({ key: "tax_data", party: "admin", category: "market", priority: full ? 1 : 2, dueDays: 2,
        data: { pending: m.pendingSearches, nearby: m.nearby, level: m.level, freshness: m.city?.freshness, requestId: m.requestId } });
    else if (m.city?.freshness === "review")
      out.push({ key: "market_refresh", party: "admin", category: "market", priority: 4, dueDays: 14, data: { lastChecked: m.city.lastChecked } });
  }

  // Documents the applicant can upload.
  if (!has("floor_plan")) out.push({ key: "doc:floor_plan", party: "user", category: "documents", priority: 3, dueDays: 10 });
  if (!ownershipKinds(d).some(has)) out.push({ key: "doc:ownership", party: "user", category: "documents", priority: 3, dueDays: 10 });
  if (full && !has("building_permit") && !has("form4")) out.push({ key: "doc:building_permit", party: "user", category: "documents", priority: 2, dueDays: 7 });
  if (st.shots.total && st.shots.done < st.shots.total)
    out.push({ key: "tour", party: "user", category: "media", priority: st.shots.done === 0 ? 3 : 4, dueDays: 10, data: { missing: st.shots.missing, done: st.shots.done, total: st.shots.total } });

  // Admin checks.
  const unverified = st.docs.filter((x) => !st.verifiedDocIds.includes(x.id) && x.kind !== "advert_print");
  if (unverified.length) out.push({ key: "verify_docs", party: "admin", category: "documents", priority: 3, dueDays: 2, data: { verified: st.verifiedDocIds, pending: unverified.map((x) => x.kind) } });
  const fl = d ? flags(d) : [];
  const mismatch = fl.find((f) => f.kind === "area_registered" || f.kind === "area_arnona");
  if (mismatch) out.push({ key: "area_check", party: "admin", category: "review", priority: 2, dueDays: 2, data: mismatch });
  if (fl.some((f) => f.kind === "deviation_reported" || f.kind === "enforcement")) out.push({ key: "legal_check", party: "admin", category: "review", priority: 2, dueDays: 3 });
  if (st.shots.done >= Math.max(3, Math.ceil(st.shots.total / 2))) out.push({ key: "condition_review", party: "admin", category: "media", priority: 3, dueDays: 3, data: { done: st.shots.done } });

  // Preliminary appraisal.
  if (c.status === "working" && !st.appraisal) {
    const blocked = !a.city || !a.street ? "address" : m.level === "none" || m.level === "insufficient" ? "market" : undefined;
    out.push({ key: "prelim_generate", party: "admin", category: "appraisal", priority: 2, dueDays: 2, data: { blocked, confidence: st.readiness.confidence } });
  }
  if (st.appraisal?.status === "draft") out.push({ key: "prelim_review", party: "admin", category: "appraisal", priority: 1, dueDays: 1 });
  if (st.appraisal?.status === "approved") out.push({ key: "prelim_send", party: "admin", category: "appraisal", priority: 1, dueDays: 1 });

  // Full professional appraisal: one task that follows the workflow's next step.
  const f = st.full;
  if (f) {
    const next = (() => {
      if (f.status === "requested") return { step: "send_quote", party: "admin" as Party, priority: 1 };
      if (f.status === "quoted") return { step: "await_acceptance", party: "user" as Party, priority: 2 };
      if (f.status === "accepted" && f.payment !== "paid" && f.payment !== "waived") return { step: "confirm_payment", party: "admin" as Party, priority: 2 };
      if ((f.status === "accepted" || f.status === "in_progress") && !f.appraiser) return { step: "assign_appraiser", party: "admin" as Party, priority: 1 };
      if (f.status === "accepted") return { step: "start_work", party: "appraiser" as Party, priority: 2 };
      if (f.status === "in_progress") {
        const item = f.checklist.find((i) => !i.done);
        return { step: item ? `item:${item.key}` : "sign_off", party: "appraiser" as Party, priority: 2 };
      }
      if (f.status === "signed") return { step: "deliver", party: "admin" as Party, priority: 1 };
      return null;
    })();
    if (next) out.push({ key: next.party === "user" ? "accept_quote" : "full_next", party: next.party, category: "full", priority: next.priority, dueDays: next.party === "user" ? 7 : 2, data: { step: next.step, fullId: f.id } });
  }
  return out;
}

// ---- Reconcile -----------------------------------------------------------------------------------

export function getTasks(db: Database, q: { caseId?: string; userId?: string; open?: boolean }): TaskRow[] {
  ensureOpsTables(db);
  const where: string[] = [];
  const args: any[] = [];
  if (q.caseId !== undefined) { where.push("case_id = ?"); args.push(q.caseId); }
  if (q.userId !== undefined) { where.push("user_id = ?"); args.push(q.userId); }
  if (q.open) where.push("status = 'open'");
  return (db.query(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY priority, created_at`).all(...args) as any[]).map(toTask);
}

function upsertTask(db: Database, caseId: string, userId: string | null, w: Want, now: number): "created" | "reopened" | "updated" | "kept" {
  const ex = db.query(`SELECT * FROM tasks WHERE case_id = ? AND COALESCE(user_id, '') = ? AND key = ?`).get(caseId, userId ?? "", w.key) as any;
  const at = iso(now);
  const data = JSON.stringify(w.data ?? {});
  if (!ex) {
    db.query(`INSERT INTO tasks (id, case_id, user_id, key, party, category, priority, status, created_at, updated_at, due_at, data)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), caseId, userId ?? "", w.key, w.party, w.category, w.priority, at, at, w.dueDays ? iso(now + w.dueDays * DAY) : null, data);
    logEvent(db, { caseId: caseId || undefined, userId: userId ?? undefined, actor: "system", kind: "task_created", data: { key: w.key, party: w.party } }, at);
    return "created";
  }
  if (ex.status === "open") {
    if (ex.data !== data || ex.priority !== w.priority || ex.party !== w.party) {
      db.query(`UPDATE tasks SET data = ?, priority = ?, party = ?, updated_at = ? WHERE id = ?`).run(data, w.priority, w.party, at, ex.id);
      // A changed step of the full workflow is news for the queue.
      if (w.key === "full_next" && JSON.parse(ex.data ?? "{}").step !== w.data?.step) logEvent(db, { caseId, actor: "system", kind: "task_step", data: { key: w.key, step: w.data?.step } }, at);
      return "updated";
    }
    return "kept";
  }
  // Closed: reopen when the system closed it (the condition came back), or when it reopens on news.
  const byHuman = ex.done_by && ex.done_by !== "system" && ex.done_by !== "user";
  const isNews = REOPENS.has(w.key) && ex.data !== data;
  if (!byHuman || isNews) {
    db.query(`UPDATE tasks SET status = 'open', data = ?, priority = ?, party = ?, updated_at = ?, done_at = NULL, done_by = NULL, resolution = NULL,
              created_at = ?, due_at = ?, reminders_sent = 0, last_reminder_at = NULL WHERE id = ?`)
      .run(data, w.priority, w.party, at, at, w.dueDays ? iso(now + w.dueDays * DAY) : null, ex.id);
    logEvent(db, { caseId: caseId || undefined, userId: userId ?? undefined, actor: "system", kind: "task_reopened", data: { key: w.key } }, at);
    return "reopened";
  }
  return "kept";
}

/** Bring a property's tasks in line with its state. Returns the open tasks. */
export function syncCaseTasks(db: Database, caseId: string, now = Date.now()): TaskRow[] {
  const st = caseState(db, caseId, now);
  if (!st) return [];
  const wants = wantedTasks(st);
  const wantKeys = new Set(wants.map((w) => w.key));
  const tx = db.transaction(() => {
    for (const w of wants) upsertTask(db, caseId, null, w, now);
    const open = db.query(`SELECT id, key FROM tasks WHERE case_id = ? AND user_id = '' AND status = 'open'`).all(caseId) as { id: string; key: string }[];
    for (const t of open) {
      if (wantKeys.has(t.key) || MANUAL(t.key)) continue;
      db.query(`UPDATE tasks SET status = 'done', done_at = ?, done_by = 'system', resolution = 'auto', updated_at = ? WHERE id = ?`).run(iso(now), iso(now), t.id);
      logEvent(db, { caseId, actor: "system", kind: "task_done", data: { key: t.key, by: "system" } }, iso(now));
    }
  });
  tx();
  return getTasks(db, { caseId, open: true });
}

/** Account-level tasks (no property yet). */
export function syncUserTasks(db: Database, now = Date.now()) {
  ensureOpsTables(db);
  ensureCaseTables(db);
  let users: { id: string; created_at: string; n: number }[] = [];
  try {
    users = db.query(`SELECT u.id, u.created_at, (SELECT COUNT(*) FROM cases c WHERE c.owner_id = u.id) AS n FROM users u`).all() as any[];
  } catch { return; }
  const admins = new Set((process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
  for (const u of users) {
    const email = (db.query(`SELECT email FROM users WHERE id = ?`).get(u.id) as { email: string }).email;
    if (admins.has(email)) continue;
    const wants = u.n === 0 && now - Date.parse(u.created_at) > DAY;
    const ex = db.query(`SELECT id, status FROM tasks WHERE case_id = '' AND user_id = ? AND key = 'start_application'`).get(u.id) as any;
    if (wants) upsertTask(db, "", u.id, { key: "start_application", party: "user", category: "application", priority: 4, dueDays: 14 }, now);
    else if (ex?.status === "open") {
      db.query(`UPDATE tasks SET status = 'done', done_at = ?, done_by = 'system', resolution = 'auto', updated_at = ? WHERE id = ?`).run(iso(now), iso(now), ex.id);
    }
  }
}

export function syncAllTasks(db: Database, now = Date.now()) {
  ensureCaseTables(db);
  const ids = (db.query(`SELECT id FROM cases WHERE status != 'closed'`).all() as { id: string }[]).map((r) => r.id);
  for (const id of ids) syncCaseTasks(db, id, now);
  syncUserTasks(db, now);
  return ids.length;
}

// ---- Human actions on a task ---------------------------------------------------------------------

export type TaskAction = "done" | "dismiss" | "snooze" | "reopen" | "assign" | "pause" | "resume" | "note";

export function actOnTask(db: Database, id: string, action: TaskAction, actor: string, opts: { reason?: string; until?: string; assignee?: string; note?: string; resolution?: string } = {}, now = Date.now()): TaskRow {
  ensureOpsTables(db);
  const t = db.query(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
  if (!t) throw new Error("not found");
  const at = iso(now);
  const reason = opts.reason?.trim().slice(0, 500);
  switch (action) {
    case "done":
    case "dismiss": {
      if ((action === "dismiss" || t.party !== "admin") && !reason) throw new Error("reason required");
      let data = t.data;
      // Checking documents records which ones were checked; a new upload reopens the task.
      if (t.key === "verify_docs") {
        const docs = (db.query(`SELECT id FROM documents WHERE case_id = ?`).all(t.case_id) as { id: string }[]).map((r) => r.id);
        data = JSON.stringify({ ...(t.data ? JSON.parse(t.data) : {}), verified: docs, pending: [] });
      }
      db.query(`UPDATE tasks SET status = ?, done_at = ?, done_by = ?, resolution = ?, note = COALESCE(?, note), updated_at = ?, data = ? WHERE id = ?`)
        .run(action === "done" ? "done" : "dismissed", at, actor, opts.resolution ?? (action === "done" ? "resolved" : "not_applicable"), reason ?? null, at, data, id);
      break;
    }
    case "reopen":
      db.query(`UPDATE tasks SET status = 'open', done_at = NULL, done_by = NULL, resolution = NULL, updated_at = ? WHERE id = ?`).run(at, id);
      break;
    case "snooze": {
      const until = opts.until && !Number.isNaN(Date.parse(opts.until)) ? new Date(opts.until).toISOString() : iso(now + 3 * DAY);
      db.query(`UPDATE tasks SET snooze_until = ?, updated_at = ? WHERE id = ?`).run(until, at, id);
      break;
    }
    case "assign":
      db.query(`UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?`).run(opts.assignee?.trim().toLowerCase() || null, at, id);
      break;
    case "pause":
    case "resume":
      db.query(`UPDATE tasks SET reminders_paused = ?, updated_at = ? WHERE id = ?`).run(action === "pause" ? 1 : 0, at, id);
      break;
    case "note":
      db.query(`UPDATE tasks SET note = ?, updated_at = ? WHERE id = ?`).run(opts.note?.slice(0, 1000) ?? null, at, id);
      break;
  }
  logEvent(db, { caseId: t.case_id || undefined, userId: t.user_id || undefined, actor, kind: `task_${action}`, data: { key: t.key, reason, until: opts.until, assignee: opts.assignee } }, at);
  return toTask(db.query(`SELECT * FROM tasks WHERE id = ?`).get(id));
}

/** Open a human task (a clarification request, the applicant's reply…), once per key. */
export function openManualTask(db: Database, caseId: string, w: Want, actor: string, now = Date.now()) {
  ensureOpsTables(db);
  const r = upsertTask(db, caseId, null, w, now);
  if (r === "kept") {
    db.query(`UPDATE tasks SET status = 'open', done_at = NULL, done_by = NULL, resolution = NULL, data = ?, updated_at = ? WHERE case_id = ? AND user_id = '' AND key = ?`)
      .run(JSON.stringify(w.data ?? {}), iso(now), caseId, w.key);
  }
  logEvent(db, { caseId, actor, kind: "task_opened", data: { key: w.key } }, iso(now));
}

/**
 * The applicant did something (uploaded, filmed, edited). Open clarification requests count
 * as answered, and the admin gets a "client responded" task.
 */
export function onApplicantActivity(db: Database, caseId: string, what: string, userId?: string, now = Date.now()) {
  ensureOpsTables(db);
  const clar = db.query(`SELECT id, key FROM tasks WHERE case_id = ? AND key LIKE 'clarify:%' AND status = 'open'`).all(caseId) as { id: string; key: string }[];
  for (const t of clar) {
    db.query(`UPDATE tasks SET status = 'done', done_at = ?, done_by = 'user', resolution = 'responded', updated_at = ? WHERE id = ?`).run(iso(now), iso(now), t.id);
    logEvent(db, { caseId, userId, actor: "user", kind: "task_done", data: { key: t.key, by: "user" } }, iso(now));
  }
  if (clar.length) openManualTask(db, caseId, { key: "user_responded", party: "admin", category: "communication", priority: 1, dueDays: 1, data: { what } }, "system", now);
  // History: one entry per kind of activity per half hour.
  const last = db.query(`SELECT at FROM events WHERE case_id = ? AND kind = 'applicant_activity' AND json_extract(data, '$.what') = ? ORDER BY id DESC LIMIT 1`).get(caseId, what) as { at: string } | null;
  if (!last || now - Date.parse(last.at) > 30 * 60_000) logEvent(db, { caseId, userId, actor: "user", kind: "applicant_activity", data: { what } }, iso(now));
  syncCaseTasks(db, caseId, now);
}

// ---- Reminders ---------------------------------------------------------------------------------

const STEP_OF: Record<string, string> = {
  "doc:floor_plan": "property", "doc:ownership": "legal", "doc:building_permit": "legal", size: "property", address: "location", complete_application: "",
};

/** A filming link for reminders: reuse a valid one (so a phone mid-tour keeps working), else make one. */
function filmLink(db: Database, caseId: string, base: string, now: number): string {
  const r = db.query(`SELECT token FROM capture_links WHERE case_id = ? AND revoked = 0 AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`).get(caseId, now + 24 * 3600_000) as { token: string } | null;
  const token = r?.token ?? newCaptureLink(db, caseId, now).token;
  return `${base}/?film=${token}`;
}

export function linkFor(db: Database, t: { key: string; caseId: string }, c: CaseRecord | null, base: string, now = Date.now()): string {
  if (!t.caseId || !c) return base;
  if (t.key === "tour") return filmLink(db, t.caseId, base, now);
  const step = STEP_OF[t.key] ?? (t.key === "complete_application" ? c.dossier?.at ?? "setup" : "review");
  return stepUrl(base, t.caseId, step || c.dossier?.at || "setup");
}

/** Is a user task due for its next scheduled reminder? */
export function reminderDue(t: TaskRow, s: OpsSettings, now = Date.now()): boolean {
  if (t.status !== "open" || t.party !== "user" || t.remindersPaused) return false;
  if (t.snoozeUntil && Date.parse(t.snoozeUntil) > now) return false;
  const n = t.remindersSent;
  if (n >= s.reminderDays.length) return false;
  return now >= Date.parse(t.createdAt) + s.reminderDays[n]! * DAY;
}

/** Send due reminders: at most one email per property (or account) per day, listing what's due. */
export function runReminders(db: Database, now = Date.now()): number {
  ensureOpsTables(db);
  const s = getSettings(db);
  if (!s.remindersOn) return 0;
  const due = (db.query(`SELECT * FROM tasks WHERE status = 'open' AND party = 'user'`).all() as any[]).map(toTask).filter((t) => reminderDue(t, s, now));
  const groups = new Map<string, TaskRow[]>();
  for (const t of due) {
    const g = `${t.caseId}|${t.userId ?? ""}`;
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  let sent = 0;
  const day = iso(now).slice(0, 10);
  for (const [g, ts] of groups) {
    const [caseId, uid] = g.split("|") as [string, string];
    const c = caseId ? getCase(db, caseId) : null;
    if (caseId && (!c || c.status === "closed")) continue;
    const userId = c?.ownerId ?? (uid || undefined);
    if (!userId) continue;
    const u = db.query(`SELECT email, lang FROM users WHERE id = ?`).get(userId) as { email: string; lang: string | null } | null;
    if (!u) continue;
    const items: ReminderItem[] = ts.map((t) => ({ key: t.key, count: t.key === "tour" ? t.data?.missing : undefined, link: linkFor(db, t, c, s.publicUrl, now) }));
    const a = c?.subject.address;
    const m = enqueue(db, {
      userId, caseId: caseId || undefined, kind: "reminder", to: u.email, lang: u.lang === "en" ? "en" : "he",
      params: { address: a ? [a.street, a.number].filter(Boolean).join(" ") + (a.city ? `, ${a.city}` : "") : undefined, items },
      dedupe: `rem:${userId}:${caseId}:${day}`, taskKeys: ts.map((t) => t.key),
    }, now);
    if (!m) continue;
    for (const t of ts) db.query(`UPDATE tasks SET reminders_sent = reminders_sent + 1, last_reminder_at = ? WHERE id = ?`).run(iso(now), t.id);
    logEvent(db, { caseId: caseId || undefined, userId, actor: "system", kind: "reminder_sent", data: { keys: ts.map((t) => t.key), n: ts[0]!.remindersSent + 1, status: m.status } }, iso(now));
    sent++;
  }
  return sent;
}

/** Next reminder date of a user task (for the communications view), if any. */
export function nextReminderAt(t: TaskRow, s: OpsSettings): string | undefined {
  if (t.status !== "open" || t.party !== "user" || t.remindersPaused || t.remindersSent >= s.reminderDays.length) return undefined;
  return iso(Date.parse(t.createdAt) + s.reminderDays[t.remindersSent]! * DAY);
}

export { CAPTURE_LINK_HOURS };
