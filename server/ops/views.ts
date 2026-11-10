/**
 * Read models for the admin area: the morning overview, the action centre queue, the
 * properties and users tables, the property workbench and the management reports.
 */
import type { Database } from "bun:sqlite";
import { adminEmails } from "../auth";
import { ensureCaseTables, getCase } from "../cases";
import { listAppraisals, getFull } from "./appraisal";
import { listMessages } from "./mail";
import { caseEvents, ensureOpsTables, getSettings, listNotes, recentEvents, userEvents } from "./store";
import { caseState, getTasks, nextReminderAt, type CaseState, type TaskRow } from "./tasks";

const DAY = 86_400_000;
const addressOf = (s: { address: { street?: string; number?: string; city?: string } }) =>
  [s.address.street, s.address.number].filter(Boolean).join(" ") + (s.address.city ? `, ${s.address.city}` : "");

export interface QueueTask extends TaskRow {
  address?: string; appNo?: string; ownerName?: string; ownerEmail?: string; city?: string; service?: string; caseAssignee?: string;
  ageDays: number; overdue: boolean; stale: boolean; effectivePriority: number; blocked?: string; waitingOnUser: boolean;
}

/** Open tasks with their property, effective priority (overdue tasks move up) and blocked state. */
export function queue(db: Database, now = Date.now()): { active: QueueTask[]; waiting: QueueTask[]; snoozed: number; doneToday: QueueTask[] } {
  ensureOpsTables(db);
  ensureCaseTables(db);
  const s = getSettings(db);
  const rows = (db.query(`SELECT t.*, c.subject AS c_subject, c.app_no AS c_app_no, c.service AS c_service, c.assignee AS c_assignee, c.status AS c_status, u.name AS u_name, u.email AS u_email
    FROM tasks t LEFT JOIN cases c ON c.id = t.case_id AND t.case_id != '' LEFT JOIN users u ON u.id = COALESCE(c.owner_id, NULLIF(t.user_id, ''))
    WHERE t.status = 'open' OR (t.done_at >= ?)`).all(new Date(now - DAY).toISOString()) as any[]);
  const out = { active: [] as QueueTask[], waiting: [] as QueueTask[], snoozed: 0, doneToday: [] as QueueTask[] };
  for (const r of rows) {
    const t: TaskRow = {
      id: r.id, caseId: r.case_id ?? "", userId: r.user_id || undefined, key: r.key, party: r.party, category: r.category, priority: r.priority, status: r.status,
      createdAt: r.created_at, updatedAt: r.updated_at, dueAt: r.due_at ?? undefined, doneAt: r.done_at ?? undefined, doneBy: r.done_by ?? undefined,
      resolution: r.resolution ?? undefined, note: r.note ?? undefined, snoozeUntil: r.snooze_until ?? undefined, assignee: r.assignee ?? undefined,
      data: r.data ? JSON.parse(r.data) : {}, remindersSent: r.reminders_sent ?? 0, lastReminderAt: r.last_reminder_at ?? undefined, remindersPaused: !!r.reminders_paused,
    };
    const subject = r.c_subject ? JSON.parse(r.c_subject) : null;
    const ageDays = Math.floor((now - Date.parse(t.createdAt)) / DAY);
    const overdue = !!t.dueAt && Date.parse(t.dueAt) < now;
    const stale = ageDays >= s.staleDays;
    const q: QueueTask = {
      ...t, address: subject ? addressOf(subject) : undefined, appNo: r.c_app_no ?? undefined, ownerName: r.u_name ?? undefined, ownerEmail: r.u_email ?? undefined,
      city: subject?.address?.city, service: r.c_service ?? undefined, caseAssignee: r.c_assignee ?? undefined,
      ageDays, overdue, stale, effectivePriority: Math.max(1, t.priority - (overdue && t.party !== "user" ? 1 : 0)),
      blocked: t.data?.blocked, waitingOnUser: t.party === "user",
    };
    if (t.status !== "open") { out.doneToday.push(q); continue; }
    if (t.snoozeUntil && Date.parse(t.snoozeUntil) > now) { out.snoozed++; continue; }
    (q.waitingOnUser ? out.waiting : out.active).push(q);
  }
  const order = (a: QueueTask, b: QueueTask) =>
    (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || a.effectivePriority - b.effectivePriority || b.ageDays - a.ageDays;
  out.active.sort(order);
  out.waiting.sort((a, b) => b.ageDays - a.ageDays);
  out.doneToday.sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  return out;
}

export function overview(db: Database, now = Date.now()) {
  ensureOpsTables(db);
  ensureCaseTables(db);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const n = (sql: string, ...a: any[]) => { try { return (db.query(sql).get(...a) as { n: number }).n ?? 0; } catch { return 0; } };
  const admins = adminEmails();
  const notAdmin = admins.length ? `WHERE email NOT IN (${admins.map(() => "?").join(",")})` : "";
  const and = admins.length ? "AND" : "WHERE";
  const q = queue(db, now);
  const openTask = (key: string) => n(`SELECT COUNT(DISTINCT case_id) AS n FROM tasks WHERE status = 'open' AND key = ?`, key);
  const stats = {
    users: n(`SELECT COUNT(*) AS n FROM users ${notAdmin}`, ...admins),
    usersToday: n(`SELECT COUNT(*) AS n FROM users ${notAdmin} ${and} created_at >= ?`, ...admins, today.toISOString()),
    usersWeek: n(`SELECT COUNT(*) AS n FROM users ${notAdmin} ${and} created_at >= ?`, ...admins, new Date(now - 7 * DAY).toISOString()),
    properties: n(`SELECT COUNT(*) AS n FROM cases`),
    drafts: n(`SELECT COUNT(*) AS n FROM cases WHERE status = 'draft'`),
    newSubmissions: n(`SELECT COUNT(*) AS n FROM cases WHERE status = 'submitted'`),
    attention: new Set(q.active.filter((t) => t.effectivePriority <= 2 && !t.blocked && t.caseId).map((t) => t.caseId)).size,
    awaitingMarket: openTask("tax_data"),
    awaitingDocs: n(`SELECT COUNT(DISTINCT case_id) AS n FROM tasks WHERE status = 'open' AND key LIKE 'doc:%'`),
    readyForPrelim: n(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND key = 'prelim_generate' AND json_extract(data, '$.blocked') IS NULL`),
    prelimAwaitingApproval: openTask("prelim_review"),
    prelimDelivered: n(`SELECT COUNT(DISTINCT case_id) AS n FROM appraisals WHERE status = 'sent'`),
    fullRequested: n(`SELECT COUNT(*) AS n FROM cases WHERE status = 'full_requested'`),
    fullInProgress: n(`SELECT COUNT(*) AS n FROM cases WHERE status = 'full_in_progress'`),
    completed: n(`SELECT COUNT(*) AS n FROM cases WHERE status = 'full_done'`),
    stale: new Set(q.active.filter((t) => t.stale && t.caseId).map((t) => t.caseId)).size,
    remindersDue: q.waiting.filter((t) => !t.remindersPaused).length,
    messagesNotSent: n(`SELECT COUNT(*) AS n FROM messages WHERE status IN ('not_sent', 'failed')`),
  };
  const newUsers = (db.query(`SELECT id, name, email, role, lang, created_at FROM users ${notAdmin} ${and} created_at >= ? ORDER BY created_at DESC LIMIT 20`)
    .all(...admins, new Date(now - 7 * DAY).toISOString()) as any[]).map((u) => ({
      id: u.id, name: u.name ?? undefined, email: u.email, role: u.role ?? undefined, lang: u.lang ?? "he", createdAt: u.created_at,
      cases: n(`SELECT COUNT(*) AS n FROM cases WHERE owner_id = ?`, u.id),
    }));
  const since = new Date(now - DAY).toISOString();
  const feed = recentEvents(db, ["full_requested", "user_registered", "prelim_generated", "message_failed", "task_reopened"], since, 30);
  return { stats, queue: q, newUsers, feed, staleDays: getSettings(db).staleDays, emailConfigured: !!(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY), at: new Date(now).toISOString() };
}

// ---- Properties ----------------------------------------------------------------------------------

export interface PropertyRow {
  id: string; appNo?: string; address: string; city?: string; owner?: { id: string; name?: string; email: string };
  type?: string; size?: number; createdAt: string; submittedAt?: string; updatedAt: string; statusAt?: string;
  service: "free" | "full"; status: string; completion: number; confidence: number; level: string;
  openAdmin: number; openUser: number; topTask?: string; assignee?: string; waitingDays: number; stale: boolean; market: string; taskKeys: string[];
}

export function propertyRows(db: Database, now = Date.now()): PropertyRow[] {
  ensureOpsTables(db);
  ensureCaseTables(db);
  const s = getSettings(db);
  const ids = (db.query(`SELECT id FROM cases ORDER BY COALESCE(submitted_at, updated_at) DESC LIMIT 2000`).all() as { id: string }[]).map((r) => r.id);
  const tasks = db.query(`SELECT case_id, key, party, priority FROM tasks WHERE status = 'open' AND case_id != '' ORDER BY priority`).all() as any[];
  const byCase = new Map<string, any[]>();
  for (const t of tasks) byCase.set(t.case_id, [...(byCase.get(t.case_id) ?? []), t]);
  const owners = new Map((db.query(`SELECT id, name, email FROM users`).all() as any[]).map((u) => [u.id, u]));
  return ids.map((id) => {
    const st = caseState(db, id, now)!;
    const c = st.c;
    const ts = byCase.get(id) ?? [];
    const o = c.ownerId ? owners.get(c.ownerId) : undefined;
    const since = c.statusAt ?? c.submittedAt ?? c.updatedAt;
    const waitingDays = Math.floor((now - Date.parse(since)) / DAY);
    const city = c.subject.address.city;
    const adminTs = ts.filter((t) => t.party !== "user");
    return {
      id, appNo: c.appNo, address: addressOf(c.subject), city: city || undefined, owner: o ? { id: o.id, name: o.name ?? undefined, email: o.email } : undefined,
      type: c.dossier?.location.type, size: typeof c.dossier?.size.interior === "number" ? c.dossier.size.interior : undefined,
      createdAt: c.createdAt, submittedAt: c.submittedAt, updatedAt: c.updatedAt, statusAt: c.statusAt, service: c.service, status: c.status,
      completion: st.readiness.completion, confidence: st.readiness.confidence, level: st.readiness.level,
      openAdmin: adminTs.length, openUser: ts.length - adminTs.length, topTask: adminTs[0]?.key ?? ts[0]?.key, assignee: c.assignee,
      waitingDays, stale: c.status !== "draft" && c.status !== "closed" && c.status !== "full_done" && waitingDays >= s.staleDays && adminTs.length > 0,
      market: st.market.city?.freshness ?? "none",
      taskKeys: ts.map((t) => t.key),
    };
  });
}

// ---- Workbench ------------------------------------------------------------------------------------

export type NextAction =
  | "start_review" | "upload_market" | "generate" | "approve" | "send" | "request_info"
  | "send_quote" | "confirm_payment" | "assign_appraiser" | "deliver" | "full_work" | "close" | "none";

export function nextAction(st: CaseState, open: TaskRow[]): NextAction {
  const has = (k: string) => open.some((t) => t.key === k);
  const full = open.find((t) => t.key === "full_next");
  if (st.c.status === "submitted") return "start_review";
  if (has("prelim_review")) return "approve";
  if (has("prelim_send")) return "send";
  if (full) {
    const step = full.data?.step as string;
    return step === "send_quote" ? "send_quote" : step === "confirm_payment" ? "confirm_payment" : step === "assign_appraiser" ? "assign_appraiser" : step === "deliver" ? "deliver" : "full_work";
  }
  if (has("tax_data")) return "upload_market";
  const gen = open.find((t) => t.key === "prelim_generate");
  if (gen && !gen.data?.blocked) return "generate";
  if (open.some((t) => t.party === "user")) return "request_info";
  if (st.c.status === "prelim_sent" || st.c.status === "full_done") return "close";
  return "none";
}

export function workbench(db: Database, caseId: string, now = Date.now()) {
  const st = caseState(db, caseId, now);
  if (!st) return null;
  const s = getSettings(db);
  const all = getTasks(db, { caseId });
  const open = all.filter((t) => t.status === "open");
  const owner = st.c.ownerId ? (db.query(`SELECT id, name, email, phone, role, lang, created_at, last_seen, reminders_opt_out FROM users WHERE id = ?`).get(st.c.ownerId) as any) : null;
  let request: any = null;
  try {
    const r = db.query(`SELECT id, status, created_at FROM requests WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`).get(caseId) as any;
    if (r) request = { id: r.id, status: r.status, createdAt: r.created_at, items: db.query(`SELECT id, city, kind, date_from AS "from", date_to AS "to", area_from AS areaFrom, area_to AS areaTo, status, note FROM plan_items WHERE request_id = ? ORDER BY date_from`).all(r.id) };
  } catch { /* none */ }
  let docs: any[] = [];
  try { docs = db.query(`SELECT id, kind, file_name AS fileName, mime, size, added_at AS addedAt FROM documents WHERE case_id = ? ORDER BY added_at`).all(caseId) as any[]; } catch { /* none */ }
  return {
    case: { ...st.c, address: addressOf(st.c.subject) },
    owner: owner ? { id: owner.id, name: owner.name ?? undefined, email: owner.email, phone: owner.phone ?? undefined, role: owner.role ?? undefined, lang: owner.lang ?? "he", createdAt: owner.created_at, lastSeen: owner.last_seen ?? undefined, remindersOptOut: !!owner.reminders_opt_out } : null,
    readiness: st.readiness,
    shots: st.shots,
    market: st.market,
    docs: docs.map((d) => ({ ...d, verified: st.verifiedDocIds.includes(d.id) })),
    tasks: all.map((t) => ({ ...t, nextReminderAt: nextReminderAt(t, s) })),
    appraisals: listAppraisals(db, caseId),
    full: getFull(db, caseId),
    messages: listMessages(db, { caseId }),
    notes: listNotes(db, { caseId }),
    events: caseEvents(db, caseId),
    request,
    nextAction: nextAction(st, open),
    settings: { reminderDays: s.reminderDays, staleDays: s.staleDays },
  };
}

// ---- Users -------------------------------------------------------------------------------------

export function userRows(db: Database) {
  ensureOpsTables(db);
  ensureCaseTables(db);
  const admins = new Set(adminEmails());
  const users = db.query(`SELECT * FROM users ORDER BY created_at DESC LIMIT 5000`).all() as any[];
  const cases = db.query(`SELECT owner_id, status FROM cases WHERE owner_id IS NOT NULL`).all() as any[];
  const byOwner = new Map<string, string[]>();
  for (const c of cases) byOwner.set(c.owner_id, [...(byOwner.get(c.owner_id) ?? []), c.status]);
  const msgs = db.query(`SELECT user_id, COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE user_id IS NOT NULL GROUP BY user_id`).all() as any[];
  const msgBy = new Map(msgs.map((m) => [m.user_id, m]));
  const welcome = new Map((db.query(`SELECT user_id, status FROM messages WHERE kind = 'welcome'`).all() as any[]).map((m) => [m.user_id, m.status]));
  const openUser = db.query(`SELECT COALESCE(NULLIF(t.user_id, ''), c.owner_id) AS uid, COUNT(*) AS n FROM tasks t LEFT JOIN cases c ON c.id = t.case_id WHERE t.status = 'open' AND t.party = 'user' GROUP BY uid`).all() as any[];
  const openBy = new Map(openUser.map((o) => [o.uid, o.n]));
  return users.map((u) => {
    const st = byOwner.get(u.id) ?? [];
    return {
      id: u.id, name: u.name ?? undefined, email: u.email, phone: u.phone ?? undefined, role: u.role ?? undefined, lang: u.lang ?? "he",
      createdAt: u.created_at, lastSeen: u.last_seen ?? u.last_login ?? undefined, isAdmin: admins.has(u.email),
      properties: st.length, submitted: st.filter((s) => s !== "draft").length, drafts: st.filter((s) => s === "draft").length,
      messages: msgBy.get(u.id)?.n ?? 0, lastMessageAt: msgBy.get(u.id)?.last ?? undefined, welcome: welcome.get(u.id) ?? "none",
      openRequests: openBy.get(u.id) ?? 0, remindersOptOut: !!u.reminders_opt_out,
    };
  });
}

export function userDetail(db: Database, userId: string) {
  const row = userRows(db).find((u) => u.id === userId);
  if (!row) return null;
  const caseIds = (db.query(`SELECT id FROM cases WHERE owner_id = ? ORDER BY updated_at DESC`).all(userId) as { id: string }[]).map((r) => r.id);
  const properties = caseIds.map((id) => {
    const c = getCase(db, id)!;
    return { id, appNo: c.appNo, address: addressOf(c.subject), status: c.status, service: c.service, updatedAt: c.updatedAt };
  });
  const tasks = (db.query(`SELECT * FROM tasks WHERE status = 'open' AND party = 'user' AND (user_id = ? OR case_id IN (${caseIds.map(() => "?").join(",") || "''"}))`).all(userId, ...caseIds) as any[])
    .map((t) => ({ id: t.id, key: t.key, caseId: t.case_id, createdAt: t.created_at, remindersSent: t.reminders_sent, paused: !!t.reminders_paused }));
  return { user: row, properties, tasks, messages: listMessages(db, { userId }), notes: listNotes(db, { userId }), events: userEvents(db, userId) };
}

// ---- Reports -----------------------------------------------------------------------------------

export function reports(db: Database, now = Date.now()) {
  ensureOpsTables(db);
  ensureCaseTables(db);
  const weeks = 12;
  const start = now - weeks * 7 * DAY;
  const bucket = (dates: string[]) => {
    const b = Array.from({ length: weeks }, () => 0);
    for (const d of dates) {
      const i = Math.floor((Date.parse(d) - start) / (7 * DAY));
      if (i >= 0 && i < weeks) b[i]!++;
    }
    return b;
  };
  const admins = adminEmails();
  const users = (db.query(`SELECT email, created_at FROM users`).all() as any[]).filter((u) => !admins.includes(u.email)).map((u) => u.created_at);
  const cases = db.query(`SELECT id, created_at, submitted_at, status FROM cases`).all() as any[];
  const firstEvent = (kind: string) => new Map((db.query(`SELECT case_id, MIN(at) AS at FROM events WHERE kind = ? AND case_id IS NOT NULL GROUP BY case_id`).all(kind) as any[]).map((r) => [r.case_id, r.at]));
  const sentAt = firstEvent("prelim_sent");
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const toPrelim = cases.filter((c) => c.submitted_at && sentAt.has(c.id)).map((c) => (Date.parse(sentAt.get(c.id)!) - Date.parse(c.submitted_at)) / DAY);
  const taxDone = db.query(`SELECT created_at, done_at FROM tasks WHERE key = 'tax_data' AND status = 'done' AND done_at IS NOT NULL`).all() as any[];
  const docTasks = db.query(`SELECT status, done_by FROM tasks WHERE key LIKE 'doc:%'`).all() as any[];
  const docUploaded = docTasks.filter((t) => t.status === "done" && t.done_by === "system").length;
  const fulls = db.query(`SELECT status, payment FROM full_requests`).all() as any[];
  const open = db.query(`SELECT category, party, COUNT(*) AS n FROM tasks WHERE status = 'open' GROUP BY category, party`).all() as any[];
  const reminders = (db.query(`SELECT COUNT(*) AS n FROM messages WHERE kind = 'reminder' AND status = 'sent'`).get() as any).n;
  const remindersNotSent = (db.query(`SELECT COUNT(*) AS n FROM messages WHERE kind = 'reminder' AND status IN ('not_sent', 'failed')`).get() as any).n;
  return {
    weekStarts: Array.from({ length: weeks }, (_, i) => new Date(start + i * 7 * DAY).toISOString().slice(0, 10)),
    newUsers: bucket(users),
    newProperties: bucket(cases.map((c) => c.created_at)),
    submittedShare: cases.length ? Math.round((cases.filter((c) => c.status !== "draft").length / cases.length) * 100) : 0,
    avgDaysToPrelim: avg(toPrelim),
    avgDaysTaxWait: avg(taxDone.map((t) => (Date.parse(t.done_at) - Date.parse(t.created_at)) / DAY)),
    remindersSent: reminders,
    remindersNotSent,
    docsRequested: docTasks.length,
    docsUploadedShare: docTasks.length ? Math.round((docUploaded / docTasks.length) * 100) : 0,
    fullEnquiries: fulls.length,
    fullPaid: fulls.filter((f) => f.payment === "paid").length,
    fullDelivered: fulls.filter((f) => f.status === "delivered").length,
    prelimDelivered: (db.query(`SELECT COUNT(*) AS n FROM appraisals WHERE status = 'sent'`).get() as any).n,
    openByCategory: open,
  };
}
