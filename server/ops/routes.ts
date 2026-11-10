/**
 * HTTP routes of the operations layer. Admin routes need an admin session (or the admin
 * token). Applicant routes only ever return the applicant's own data – never internal notes,
 * tasks' internal fields, or unsent appraisals.
 */
import type { Database } from "bun:sqlite";
import type { DataProvider } from "../../src/data/provider";
import { adminEmails, getUser, isAdminUser, sessionUser, type User } from "../auth";
import { getCase, setCaseStatus, CASE_STATUSES, type CaseStatus } from "../cases";
import { decidePreliminary, generatePreliminary, getFull, InsufficientEvidence, requestFull, sentAppraisal, updateFull } from "./appraisal";
import { enqueue, getMessage, processOutbox, renderMessage, retryMessage, stepUrl, unsubscribeKey } from "./mail";
import { addNote, ensureOpsTables, getSettings, logEvent, saveSettings } from "./store";
import { actOnTask, linkFor, openManualTask, resetMarketCache, runReminders, syncAllTasks, syncCaseTasks, type TaskAction } from "./tasks";
import { overview, propertyRows, queue, reports, userDetail, userRows, workbench } from "./views";

export interface OpsCtx {
  db: Database;
  provider: DataProvider;
  isAdmin: (req: Request) => boolean;
  canAccess: (caseId: string) => boolean;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const ID = "[A-Za-z0-9-]{16,64}";
const bad = (e: unknown) => json({ error: (e as Error).message }, 400);

export function actorOf(db: Database, req: Request): string {
  const u = sessionUser(db, req);
  return u && isAdminUser(u) ? u.email : "admin-token";
}

/** Welcome email and admin notice for a newly registered user (once). */
export function onUserRegistered(db: Database, u: User) {
  ensureOpsTables(db);
  logEvent(db, { userId: u.id, actor: "user", kind: "user_registered", data: { email: u.email, lang: u.lang } });
  // Sent a few minutes later so it can greet them by the name they enter in their profile.
  enqueue(db, { userId: u.id, kind: "welcome", to: u.email, lang: u.lang, dedupe: `welcome:${u.id}`, delayMs: 3 * 60_000 });
  for (const to of adminEmails()) {
    if (to === u.email) continue;
    enqueue(db, { kind: "admin_new_user", to, lang: "he", params: { email: u.email, lang: u.lang }, dedupe: `admin_new_user:${u.id}:${to}` });
  }
}

/** The periodic work: tasks, reminders, outbox. */
export async function opsTick(db: Database, now = Date.now()) {
  syncAllTasks(db, now);
  const reminders = runReminders(db, now);
  const mail = await processOutbox(db, undefined, now);
  return { reminders, ...mail };
}

export async function handleOps(req: Request, url: URL, ctx: OpsCtx): Promise<Response | null> {
  const { db } = ctx;
  const p = url.pathname;
  const m = (re: string) => p.match(new RegExp(`^${re}$`));

  // ---- Applicant -------------------------------------------------------------------------------
  if (p === "/api/unsubscribe" && req.method === "GET") {
    const u = url.searchParams.get("u") ?? "";
    const ok = !!u && url.searchParams.get("k") === unsubscribeKey(u) && !!getUser(db, u);
    if (ok) {
      db.query(`UPDATE users SET reminders_opt_out = 1 WHERE id = ?`).run(u);
      logEvent(db, { userId: u, actor: "user", kind: "reminders_opt_out" });
    }
    const msg = ok ? "הוסרתם מרשימת התזכורות. · You will no longer receive reminders." : "הקישור אינו תקין. · This link is not valid.";
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:Arial;padding:40px;text-align:center" dir="rtl"><p>${msg}</p><p><a href="/">בית שמאי · Beit Shamai</a></p>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  let r = m(`/api/cases/(${ID})/appraisal`);
  if (r && req.method === "GET") {
    if (!ctx.canAccess(r[1]!)) return json({ error: "no access to this property" }, 403);
    const a = sentAppraisal(db, r[1]!);
    const f = getFull(db, r[1]!);
    return json({
      preliminary: a ? { low: a.low, point: a.point, high: a.high, confidence: a.confidence, readiness: a.readiness, comparables: a.comparables, limitations: a.limitations, sentAt: a.sentAt } : null,
      full: f ? { status: f.status, purpose: f.purpose, quote: f.status === "quoted" || f.status === "accepted" ? f.quote : undefined, createdAt: f.createdAt } : null,
    });
  }
  r = m(`/api/cases/(${ID})/full`);
  if (r && req.method === "POST") {
    const u = sessionUser(db, req);
    if (!u) return json({ error: "not signed in" }, 401);
    const c = getCase(db, r[1]!);
    if (!c) return json({ error: "not found" }, 404);
    if (c.ownerId && c.ownerId !== u.id && !isAdminUser(u)) return json({ error: "not your property" }, 403);
    const b = (await req.json().catch(() => ({}))) as { purpose?: string; note?: string; accept?: boolean };
    try {
      if (b.accept) {
        const f = getFull(db, c.id);
        if (!f || f.status !== "quoted") return json({ error: "no quote to accept" }, 400);
        updateFull(db, f.id, { status: "accepted" }, u.email);
        return json({ full: getFull(db, c.id) });
      }
      return json({ full: requestFull(db, c.id, b, { id: u.id, label: u.email }) });
    } catch (e) { return bad(e); }
  }

  if (!p.startsWith("/api/admin/")) return null;
  if (!ctx.isAdmin(req)) return json({ error: "unauthorised" }, 401);
  const actor = actorOf(db, req);
  const body = async <T>() => (await req.json().catch(() => ({}))) as T;

  // ---- Admin: overview, queue, settings, reports ------------------------------------------------
  if (p === "/api/admin/overview" && req.method === "GET") return json(overview(db));
  if (p === "/api/admin/queue" && req.method === "GET") return json(queue(db));
  if (p === "/api/admin/settings") {
    if (req.method === "PUT") { try { return json(saveSettings(db, await body())); } catch (e) { return bad(e); } }
    return json({ ...getSettings(db), emailConfigured: !!(process.env.RESEND_API_KEY || process.env.BREVO_API_KEY), emailVia: process.env.RESEND_API_KEY ? "resend" : process.env.BREVO_API_KEY ? "brevo" : null, admins: adminEmails() });
  }
  if (p === "/api/admin/reports" && req.method === "GET") return json(reports(db));
  if (p === "/api/admin/tick" && req.method === "POST") return json(await opsTick(db));
  if (p === "/api/admin/messages/retry-unsent" && req.method === "POST") {
    const ids = (db.query(`SELECT id FROM messages WHERE status = 'not_sent'`).all() as { id: string }[]).map((x) => x.id);
    for (const id of ids) retryMessage(db, id, actor);
    processOutbox(db).catch(() => {});
    return json({ queued: ids.length });
  }
  r = m(`/api/admin/messages/(${ID})/retry`);
  if (r && req.method === "POST") {
    try { retryMessage(db, r[1]!, actor); processOutbox(db).catch(() => {}); return json(getMessage(db, r[1]!)); } catch (e) { return bad(e); }
  }

  // ---- Tasks -------------------------------------------------------------------------------------
  r = m(`/api/admin/tasks/(${ID})`);
  if (r && req.method === "POST") {
    const b = await body<{ action: TaskAction | "remind"; reason?: string; until?: string; assignee?: string; note?: string; resolution?: string; subject?: string; text?: string }>();
    try {
      if (b.action === "remind") return json(await remindNow(db, r[1]!, actor, b.subject, b.text));
      const t = actOnTask(db, r[1]!, b.action, actor, b);
      if (t.caseId) syncCaseTasks(db, t.caseId);
      return json(t);
    } catch (e) { return bad(e); }
  }
  r = m(`/api/admin/tasks/(${ID})/reminder`);
  if (r && req.method === "GET") {
    // The suggested text, for the admin to edit before sending.
    const t = db.query(`SELECT * FROM tasks WHERE id = ?`).get(r[1]!) as any;
    if (!t) return json({ error: "not found" }, 404);
    const c = t.case_id ? getCase(db, t.case_id) : null;
    const uid = c?.ownerId ?? (t.user_id || undefined);
    const u = uid ? getUser(db, uid) : null;
    if (!u) return json({ error: "no applicant to remind" }, 400);
    const base = getSettings(db).publicUrl;
    const link = linkFor(db, { key: t.key, caseId: t.case_id }, c, base);
    const a = c?.subject.address;
    const data = t.data ? JSON.parse(t.data) : {};
    const out = renderMessage("reminder", u.lang, { address: a ? [a.street, a.number].filter(Boolean).join(" ") + (a.city ? `, ${a.city}` : "") : undefined, items: [{ key: t.key, count: data.missing, link }] }, u.name, base, u.id);
    return json({ to: u.email, lang: u.lang, ...out });
  }

  // ---- Properties ----------------------------------------------------------------------------------
  if (p === "/api/admin/properties" && req.method === "GET") return json(propertyRows(db));
  r = m(`/api/admin/properties/(${ID})`);
  if (r && req.method === "GET") {
    syncCaseTasks(db, r[1]!);
    const w = workbench(db, r[1]!);
    return w ? json(w) : json({ error: "not found" }, 404);
  }
  r = m(`/api/admin/properties/(${ID})/(status|assign|appraisal|full|message|notes|market|sync)`);
  if (r && req.method === "POST") {
    const caseId = r[1]!;
    const c = getCase(db, caseId);
    if (!c) return json({ error: "not found" }, 404);
    try {
      switch (r[2]) {
        case "status": {
          const b = await body<{ status: CaseStatus; reason?: string }>();
          if (!CASE_STATUSES.includes(b.status)) return bad(new Error("bad status"));
          // "Start review" is the normal step; anything else is an override and needs a reason.
          const normal = c.status === "submitted" && b.status === "working";
          if (!normal && !b.reason?.trim()) return bad(new Error("reason required"));
          setCaseStatus(db, caseId, b.status);
          logEvent(db, { caseId, actor, kind: normal ? "review_started" : "status_override", data: { from: c.status, to: b.status, reason: b.reason?.trim() } });
          break;
        }
        case "assign": {
          const b = await body<{ assignee?: string }>();
          const who = b.assignee?.trim().toLowerCase() || null;
          db.query(`UPDATE cases SET assignee = ? WHERE id = ?`).run(who, caseId);
          logEvent(db, { caseId, actor, kind: "assigned", data: { assignee: who } });
          break;
        }
        case "appraisal": {
          const b = await body<{ action: "generate" | "approve" | "send" | "reject"; id?: string; note?: string }>();
          if (b.action === "generate") {
            try { await generatePreliminary(db, ctx.provider, caseId, actor); }
            catch (e) { if (e instanceof InsufficientEvidence) return json({ error: "insufficient_evidence" }, 422); throw e; }
          } else if (b.id) decidePreliminary(db, b.id, b.action, actor, b.note);
          else return bad(new Error("id required"));
          break;
        }
        case "full": {
          const b = await body<{ open?: { purpose?: string; note?: string }; id?: string; patch?: any }>();
          if (b.open) requestFull(db, caseId, b.open, { label: actor });
          else if (b.id && b.patch) updateFull(db, b.id, b.patch, actor);
          else return bad(new Error("nothing to do"));
          break;
        }
        case "message": {
          const b = await body<{ kind?: "clarify" | "custom"; subject?: string; text?: string; step?: string }>();
          if (!c.ownerId) return bad(new Error("this property has no applicant account"));
          const u = getUser(db, c.ownerId)!;
          if (!b.subject?.trim() || !b.text?.trim()) return bad(new Error("subject and text required"));
          const base = getSettings(db).publicUrl;
          const link = b.step ? stepUrl(base, caseId, b.step) : stepUrl(base, caseId, c.dossier?.at ?? "review");
          const msg = enqueue(db, { userId: u.id, caseId, kind: b.kind === "clarify" ? "clarify" : "custom", to: u.email, lang: u.lang,
            subject: b.subject.trim().slice(0, 200), body: `${b.text.trim().slice(0, 5000)}\n\n${link}`, createdBy: actor });
          if (msg && b.kind === "clarify") openManualTask(db, caseId, { key: `clarify:${msg.id.slice(0, 8)}`, party: "user", category: "communication", priority: 2, dueDays: 5, data: { subject: b.subject.trim().slice(0, 200), messageId: msg.id } }, actor);
          processOutbox(db).catch(() => {});
          break;
        }
        case "notes": {
          const b = await body<{ text?: string }>();
          addNote(db, { caseId, author: actor, text: b.text ?? "" });
          break;
        }
        case "market": {
          // A search that was done and found nothing useful is a result, not a missing task.
          const b = await body<{ reason?: string }>();
          const t = db.query(`SELECT id FROM tasks WHERE case_id = ? AND key = 'tax_data' AND status = 'open'`).get(caseId) as { id: string } | null;
          if (!t) return bad(new Error("no open market-data task"));
          actOnTask(db, t.id, "dismiss", actor, { reason: b.reason?.trim() || "searched – no useful results", resolution: "no_results" });
          logEvent(db, { caseId, actor, kind: "market_no_results", data: { reason: b.reason } });
          break;
        }
        case "sync":
          resetMarketCache();
          break;
      }
      syncCaseTasks(db, caseId);
      return json(workbench(db, caseId));
    } catch (e) { return bad(e); }
  }

  // ---- Users ----------------------------------------------------------------------------------------
  if (p === "/api/admin/users" && req.method === "GET") return json(userRows(db));
  r = m(`/api/admin/users/(${ID})`);
  if (r && req.method === "GET") {
    const d = userDetail(db, r[1]!);
    return d ? json(d) : json({ error: "not found" }, 404);
  }
  r = m(`/api/admin/users/(${ID})/(welcome|message|notes|reminders)`);
  if (r && req.method === "POST") {
    const u = getUser(db, r[1]!);
    if (!u) return json({ error: "not found" }, 404);
    try {
      if (r[2] === "welcome") {
        enqueue(db, { userId: u.id, kind: "welcome", to: u.email, lang: u.lang, createdBy: actor, dedupe: `welcome-manual:${u.id}:${Date.now()}` });
        processOutbox(db).catch(() => {});
      } else if (r[2] === "message") {
        const b = await body<{ subject?: string; text?: string; caseId?: string }>();
        if (!b.subject?.trim() || !b.text?.trim()) return bad(new Error("subject and text required"));
        enqueue(db, { userId: u.id, caseId: b.caseId, kind: "custom", to: u.email, lang: u.lang, subject: b.subject.trim().slice(0, 200), body: b.text.trim().slice(0, 5000), createdBy: actor });
        processOutbox(db).catch(() => {});
      } else if (r[2] === "notes") {
        const b = await body<{ text?: string }>();
        addNote(db, { userId: u.id, author: actor, text: b.text ?? "" });
      } else {
        const b = await body<{ optOut?: boolean }>();
        db.query(`UPDATE users SET reminders_opt_out = ? WHERE id = ?`).run(b.optOut ? 1 : 0, u.id);
        logEvent(db, { userId: u.id, actor, kind: b.optOut ? "reminders_opt_out" : "reminders_opt_in" });
      }
      return json(userDetail(db, u.id));
    } catch (e) { return bad(e); }
  }
  return json({ error: "not found" }, 404);
}

/** Send a reminder for one task now (optionally with the admin's edited text). */
async function remindNow(db: Database, taskId: string, actor: string, subject?: string, text?: string) {
  const t = db.query(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
  if (!t) throw new Error("not found");
  if (t.party !== "user") throw new Error("only applicant tasks have reminders");
  const c = t.case_id ? getCase(db, t.case_id) : null;
  const uid = c?.ownerId ?? (t.user_id || undefined);
  const u = uid ? getUser(db, uid) : null;
  if (!u) throw new Error("no applicant to remind");
  const base = getSettings(db).publicUrl;
  const link = linkFor(db, { key: t.key, caseId: t.case_id }, c, base);
  const a = c?.subject.address;
  const data = t.data ? JSON.parse(t.data) : {};
  const msg = enqueue(db, {
    userId: u.id, caseId: t.case_id || undefined, kind: "reminder", to: u.email, lang: u.lang, createdBy: actor,
    subject: subject?.trim() ? subject.trim().slice(0, 200) : undefined, body: text?.trim() ? text.trim().slice(0, 5000) : undefined,
    params: { address: a ? [a.street, a.number].filter(Boolean).join(" ") + (a.city ? `, ${a.city}` : "") : undefined, items: [{ key: t.key, count: data.missing, link }] },
    dedupe: `rem-manual:${taskId}:${t.reminders_sent}`, taskKeys: [t.key],
  });
  if (!msg) throw new Error("a reminder for this item was already sent – wait for the next one or send a personal message");
  db.query(`UPDATE tasks SET reminders_sent = reminders_sent + 1, last_reminder_at = ? WHERE id = ?`).run(new Date().toISOString(), taskId);
  logEvent(db, { caseId: t.case_id || undefined, userId: u.id, actor, kind: "reminder_sent", data: { keys: [t.key], manual: true, status: msg.status } });
  await processOutbox(db);
  return getMessage(db, msg.id);
}
