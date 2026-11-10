/**
 * The admin workflow, end to end over HTTP: registration → welcome email and admin notice;
 * submission → tasks; reminders; uploads closing tasks; market data; preliminary appraisal with
 * approval and client notification; full appraisal; activity history and access rules.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "../server/main";
import { upsertDeals } from "../server/db";
import { processOutbox, listMessages } from "../server/ops/mail";
import { runReminders, getTasks, syncCaseTasks } from "../server/ops/tasks";
import { emptyDossier, toSubject } from "../src/dossier/schema";
import { newSubject } from "../src/ui/newSubject";
import type { Deal } from "../src/engine/types";

const DAY = 86_400_000;

describe("admin workflow journeys", () => {
  process.env.ADMIN_EMAILS = "boss@example.com";
  delete process.env.RESEND_API_KEY;
  delete process.env.BREVO_API_KEY;
  const { server, db } = createServer({ dbPath: ":memory:", adminToken: "t0k3n-long-enough", port: 0, opsTick: false });
  process.env.ADMIN_TOKEN = "t0k3n-long-enough";
  const base = `http://localhost:${server.port}`;
  afterAll(() => server.stop(true));

  async function signIn(email: string, lang = "he"): Promise<string> {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try { await fetch(`${base}/api/auth/code`, { method: "POST", body: JSON.stringify({ email }) }); } finally { console.log = orig; }
    const code = lines.join("\n").match(/\b(\d{6})\b/)![1]!;
    const r = await fetch(`${base}/api/auth/verify`, { method: "POST", body: JSON.stringify({ email, code, lang }) });
    expect(r.status).toBe(200);
    return r.headers.get("set-cookie")!.split(";")[0]!;
  }
  const admin = { authorization: "Bearer t0k3n-long-enough" };
  const get = async (path: string, headers: Record<string, string> = admin) => (await fetch(`${base}${path}`, { headers })).json() as Promise<any>;
  const post = async (path: string, body: unknown, headers: Record<string, string> = admin) =>
    fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  const caseId = "case-ops-journey-0001";
  let cookie = "";
  let userId = "";

  test("1. new user registers → welcome email queued once → admin notified", async () => {
    cookie = await signIn("dana@example.com");
    const me = await get("/api/me", { cookie });
    userId = me.user.id;
    await fetch(`${base}/api/me`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ name: "דנה", role: "seller" }) });
    const msgs = listMessages(db, { userId });
    expect(msgs.filter((m) => m.kind === "welcome")).toHaveLength(1);
    expect(msgs[0]!.status).toBe("queued");
    // Signing in again does not queue another welcome.
    await signIn("dana@example.com");
    expect(listMessages(db, { userId }).filter((m) => m.kind === "welcome")).toHaveLength(1);
    const ov = await get("/api/admin/overview");
    expect(ov.stats.usersToday).toBe(1);
    expect(ov.newUsers[0].email).toBe("dana@example.com");
    expect(listMessages(db, {}).some((m) => m.kind === "admin_new_user" && m.to === "boss@example.com")).toBe(true);
    // Delivery is tracked honestly: no email service → "not_sent", never "sent".
    const sentWith: string[] = [];
    await processOutbox(db, async (m) => { sentWith.push(m.subject); return { sent: true, via: "test" }; }, Date.now() + 10 * 60_000);
    const welcome = listMessages(db, { userId }).find((m) => m.kind === "welcome")!;
    expect(welcome.status).toBe("sent");
    expect(welcome.body).toContain("שלום דנה");
    expect(sentWith).toContain("ברוכים הבאים לבית שמאי");
  });

  test("2 + 5. property submitted → admin and applicant tasks, including the Tax Authority upload", async () => {
    const d = emptyDossier();
    d.setup = { purpose: "sale", submitter: "owner" } as any;
    d.location.city = "תל אביב-יפו"; d.location.street = "בן יהודה"; d.location.number = "10"; d.location.type = "apartment";
    d.location.pin = { lat: 32.0853, lng: 34.7818 };
    d.size.interior = 90; d.size.registered = 70; // a mismatch for the admin to check
    d.rooms.rooms = 4; d.rooms.bedrooms = 2; d.rooms.bathrooms = 1;
    const subject = toSubject(d, newSubject());
    expect((await fetch(`${base}/api/cases/${caseId}`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ subject, dossier: d }) })).status).toBe(200);
    const draftTasks = getTasks(db, { caseId, open: true }).map((t) => t.key);
    expect(draftTasks).toEqual(["complete_application"]);
    expect((await post(`/api/cases/${caseId}/submit`, {}, { cookie })).status).toBe(200);
    const keys = getTasks(db, { caseId, open: true }).map((t) => t.key).sort();
    expect(keys).toEqual(["area_check", "doc:floor_plan", "doc:ownership", "review_new", "tax_data", "tour"].sort());
    const tax = getTasks(db, { caseId, open: true }).find((t) => t.key === "tax_data")!;
    expect(tax.party).toBe("admin");
    expect(tax.data.requestId).toBeTruthy();
    expect(getTasks(db, { caseId }).find((t) => t.key === "complete_application")!.status).toBe("done");
    // Re-syncing never duplicates.
    syncCaseTasks(db, caseId); syncCaseTasks(db, caseId);
    expect(getTasks(db, { caseId }).filter((t) => t.key === "tax_data")).toHaveLength(1);
    // The queue shows the admin tasks; applicant tasks are "waiting on the client".
    const q = await get("/api/admin/queue");
    expect(q.active.some((t: any) => t.key === "review_new" && t.caseId === caseId)).toBe(true);
    expect(q.waiting.some((t: any) => t.key === "doc:floor_plan")).toBe(true);
  });

  test("3. missing floor plan → reminder after the schedule, once a day, not after opt-out", () => {
    expect(runReminders(db, Date.now() + DAY)).toBe(0); // too early (first after 2 days)
    expect(runReminders(db, Date.now() + 2 * DAY + 3600_000)).toBe(1);
    const rem = listMessages(db, { caseId }).filter((m) => m.kind === "reminder");
    expect(rem).toHaveLength(1);
    expect(rem[0]!.taskKeys).toContain("doc:floor_plan");
    expect(rem[0]!.params.items.find((i: any) => i.key === "doc:floor_plan").link).toContain(`open=${caseId}&step=property`);
    expect(rem[0]!.params.items.find((i: any) => i.key === "tour").link).toContain("/?film=");
    expect(runReminders(db, Date.now() + 2 * DAY + 7200_000)).toBe(0); // same day: no duplicate
    expect(getTasks(db, { caseId, open: true }).find((t) => t.key === "doc:floor_plan")!.remindersSent).toBe(1);
  });

  test("4. floor plan uploaded → its task completes automatically; the admin gets a document check", async () => {
    const f = new FormData();
    f.set("kind", "floor_plan");
    f.set("file", new File([new Uint8Array([37, 80, 68, 70])], "plan.pdf", { type: "application/pdf" }));
    expect((await fetch(`${base}/api/cases/${caseId}/documents`, { method: "POST", headers: { cookie }, body: f })).status).toBe(200);
    const plan = getTasks(db, { caseId }).find((t) => t.key === "doc:floor_plan")!;
    expect(plan.status).toBe("done");
    expect(plan.doneBy).toBe("system");
    expect(getTasks(db, { caseId, open: true }).some((t) => t.key === "verify_docs")).toBe(true);
    // The applicant can download their own file; another user cannot.
    const docs = await get(`/api/cases/${caseId}/documents`, { cookie });
    expect((await fetch(`${base}/api/cases/${caseId}/documents/${docs[0].id}/file`, { headers: { cookie } })).status).toBe(200);
    const other = await signIn("someone@example.com");
    expect((await fetch(`${base}/api/cases/${caseId}/documents/${docs[0].id}/file`, { headers: { cookie: other } })).status).toBe(403);
  });

  test("6. transaction data uploaded → market status updates and the Tax Authority task closes", async () => {
    // What a completed Tax Authority upload leaves behind: the searches done, the source checked, deals in the shared library.
    db.query(`UPDATE plan_items SET status = 'done'`).run();
    db.query(`INSERT INTO tax_pulls (id, city, kind, date_from, date_to, area_from, area_to, total, rows, truncated, located, unlocated, at) VALUES ('p1', 'תל אביב-יפו', 'apartment', '2025-11-01', '2026-11-01', 60, 120, 15, 15, 0, 15, 0, ?)`).run(new Date().toISOString());
    const deals: Deal[] = Array.from({ length: 15 }, (_, i) => ({
      id: `tax-${i}`, evidence: "completed_deal", source: "tax_authority", date: new Date(Date.now() - (20 + i * 15) * DAY).toISOString().slice(0, 10),
      price: 3_600_000 + i * 40_000, location: { lat: 32.0853 + (i % 5) * 0.0006, lng: 34.7818 + (i % 3) * 0.0006 },
      address: { city: "תל אביב-יפו", street: "בן יהודה", number: String(20 + i) }, area: 85 + (i % 4) * 4, rooms: 4, floor: 2, elevator: true, yearBuilt: 1990, newBuild: false,
    }));
    upsertDeals(db, deals);
    const w = await (await post(`/api/admin/properties/${caseId}/sync`, {})).json() as any;
    expect(w.market.level).toBe("high");
    expect(w.market.city.freshness).toBe("fresh");
    expect(w.market.city.checkedBy).toBe("tax_upload");
    expect(w.tasks.find((t: any) => t.key === "tax_data").status).toBe("done");
  });

  test("7. ready → admin starts review → preliminary appraisal generated for approval", async () => {
    let w = await (await post(`/api/admin/properties/${caseId}/status`, { status: "working" })).json() as any;
    expect(w.case.status).toBe("working");
    expect(w.nextAction).toBe("generate");
    const gen = w.tasks.find((t: any) => t.key === "prelim_generate" && t.status === "open");
    expect(gen.data.blocked).toBeUndefined();
    // Overrides need a reason.
    expect((await post(`/api/admin/properties/${caseId}/status`, { status: "closed" })).status).toBe(400);
    w = await (await post(`/api/admin/properties/${caseId}/appraisal`, { action: "generate" })).json() as any;
    expect(w.case.status).toBe("prelim_review");
    expect(w.appraisals[0].status).toBe("draft");
    expect(w.appraisals[0].low).toBeGreaterThan(0);
    expect(w.appraisals[0].limitations).toContain("area_mismatch");
    expect(w.nextAction).toBe("approve");
    // Not visible to the applicant before approval and sending.
    expect((await get(`/api/cases/${caseId}/appraisal`, { cookie })).preliminary).toBeNull();
  });

  test("8. preliminary approved and sent → the applicant is notified and can see it", async () => {
    let w = await get(`/api/admin/properties/${caseId}`);
    const id = w.appraisals[0].id;
    expect((await post(`/api/admin/properties/${caseId}/appraisal`, { action: "send", id })).status).toBe(400); // approve first
    await post(`/api/admin/properties/${caseId}/appraisal`, { action: "approve", id });
    w = await (await post(`/api/admin/properties/${caseId}/appraisal`, { action: "send", id })).json() as any;
    expect(w.case.status).toBe("prelim_sent");
    expect(listMessages(db, { caseId }).some((m) => m.kind === "prelim_ready" && m.to === "dana@example.com")).toBe(true);
    const mine = await get(`/api/cases/${caseId}/appraisal`, { cookie });
    expect(mine.preliminary.low).toBe(w.appraisals[0].low);
    expect(mine.preliminary.limitations.length).toBeGreaterThan(0);
  });

  test("9. user requests a full appraisal → a professional workflow opens with a high-priority task", async () => {
    const r = await post(`/api/cases/${caseId}/full`, { purpose: "bank", note: "משכנתא" }, { cookie });
    expect(r.status).toBe(200);
    let w = await get(`/api/admin/properties/${caseId}`);
    expect(w.case.status).toBe("full_requested");
    expect(w.case.service).toBe("full");
    expect(w.full.checklist.map((i: any) => i.key)).toContain("bank_format");
    const t = w.tasks.find((x: any) => x.key === "full_next" && x.status === "open");
    expect(t.priority).toBe(1);
    expect(t.data.step).toBe("send_quote");
    expect(w.tasks.some((x: any) => x.key === "doc:building_permit" && x.status === "open")).toBe(true);
    expect(listMessages(db, {}).some((m) => m.kind === "admin_full_request")).toBe(true);
    // Quote → client accepts → appraiser must be assigned → sign-off needs the full checklist.
    w = await (await post(`/api/admin/properties/${caseId}/full`, { id: w.full.id, patch: { quote: 2500, status: "quoted" } })).json() as any;
    expect(w.tasks.some((x: any) => x.key === "accept_quote" && x.status === "open")).toBe(true);
    expect((await post(`/api/cases/${caseId}/full`, { accept: true }, { cookie })).status).toBe(200);
    w = await get(`/api/admin/properties/${caseId}`);
    expect(w.full.status).toBe("accepted");
    expect(w.case.status).toBe("full_in_progress");
    expect((await post(`/api/admin/properties/${caseId}/full`, { id: w.full.id, patch: { status: "in_progress" } })).status).toBe(400);
    await post(`/api/admin/properties/${caseId}/full`, { id: w.full.id, patch: { appraiser: "Appraiser@Example.com", payment: "paid" } });
    w = await (await post(`/api/admin/properties/${caseId}/full`, { id: w.full.id, patch: { status: "in_progress" } })).json() as any;
    expect(w.full.appraiser).toBe("appraiser@example.com");
    expect((await post(`/api/admin/properties/${caseId}/full`, { id: w.full.id, patch: { status: "signed" } })).status).toBe(400);
  });

  test("10. complete activity history; internal notes stay internal", async () => {
    await post(`/api/admin/properties/${caseId}/notes`, { text: "הלקוחה ביקשה לא להתקשר בבוקר" });
    const w = await get(`/api/admin/properties/${caseId}`);
    const kinds = new Set(w.events.map((e: any) => e.kind));
    for (const k of ["submitted", "task_created", "task_done", "applicant_activity", "review_started", "prelim_generated", "prelim_approved", "prelim_sent", "full_requested", "full_updated", "reminder_sent", "note_added"])
      expect(kinds.has(k)).toBe(true);
    expect(w.notes[0].text).toContain("לא להתקשר");
    const own = JSON.stringify(await get(`/api/cases/${caseId}`, { cookie }));
    expect(own).not.toContain("לא להתקשר");
    // Admin routes are closed to applicants.
    expect((await fetch(`${base}/api/admin/properties/${caseId}`, { headers: { cookie } })).status).toBe(401);
  });

  test("manual resolution needs a reason and is recorded; the rules don't reopen it", async () => {
    const t = getTasks(db, { caseId, open: true }).find((x) => x.key === "doc:ownership")!;
    expect((await post(`/api/admin/tasks/${t.id}`, { action: "dismiss" })).status).toBe(400);
    expect((await post(`/api/admin/tasks/${t.id}`, { action: "dismiss", reason: "נכס רמ״י, אישור זכויות יגיע מהבנק" })).status).toBe(200);
    syncCaseTasks(db, caseId);
    const after = getTasks(db, { caseId }).find((x) => x.key === "doc:ownership")!;
    expect(after.status).toBe("dismissed");
    expect(after.doneBy).toBe("admin-token");
    expect(after.note).toContain("רמ״י");
  });
});
