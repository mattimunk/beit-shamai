/**
 * The two service levels.
 *
 * Preliminary (free): generated from the existing valuation engine and saved as a snapshot
 * (range, comparables confidence, readiness, limitations, evidence). It needs an admin's
 * approval before the client sees it. With too little market evidence no figure is produced –
 * the engine returns no value and nothing is invented.
 *
 * Full (professional): its own workflow – purpose, quote, client acceptance, payment status,
 * licensed appraiser, a purpose-specific checklist, sign-off and delivery. Everything already in
 * the property file carries over; nothing is re-entered.
 */
import type { Database } from "bun:sqlite";
import type { DataProvider } from "../../src/data/provider";
import { valuate, type ValuationFacts } from "../../src/engine/valuation";
import { adminEmails } from "../auth";
import { caseListings } from "../caseAdverts";
import { getCase, setCaseStatus, type CaseRecord } from "../cases";
import { enqueue, stepUrl } from "./mail";
import { ensureOpsTables, getSettings, logEvent } from "./store";
import { caseState, syncCaseTasks } from "./tasks";

export interface AppraisalRow {
  id: string; caseId: string; kind: "preliminary"; status: "draft" | "approved" | "sent" | "superseded"; createdAt: string; createdBy?: string;
  low: number; point: number; high: number; confidence: string; readiness: number; comparables: number;
  limitations: string[]; evidence: { address: string; date: string; price: number; area: number; distanceM: number }[];
  approvedBy?: string; approvedAt?: string; sentAt?: string; note?: string;
}

const toAppraisal = (r: any): AppraisalRow => ({
  id: r.id, caseId: r.case_id, kind: r.kind, status: r.status, createdAt: r.created_at, createdBy: r.created_by ?? undefined,
  low: r.low, point: r.point, high: r.high, confidence: r.confidence, readiness: r.readiness ?? 0, comparables: r.comparables ?? 0,
  limitations: r.limitations ? JSON.parse(r.limitations) : [], evidence: r.evidence ? JSON.parse(r.evidence) : [],
  approvedBy: r.approved_by ?? undefined, approvedAt: r.approved_at ?? undefined, sentAt: r.sent_at ?? undefined, note: r.note ?? undefined,
});

export function listAppraisals(db: Database, caseId: string): AppraisalRow[] {
  ensureOpsTables(db);
  return (db.query(`SELECT * FROM appraisals WHERE case_id = ? ORDER BY created_at DESC`).all(caseId) as any[]).map(toAppraisal);
}
/** What the applicant may see: the latest preliminary that was sent to them. */
export function sentAppraisal(db: Database, caseId: string): AppraisalRow | null {
  ensureOpsTables(db);
  const r = db.query(`SELECT * FROM appraisals WHERE case_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`).get(caseId);
  return r ? toAppraisal(r) : null;
}

const addressOf = (c: CaseRecord) => {
  const a = c.subject.address;
  return [a.street, a.number].filter(Boolean).join(" ") + (a.city ? `, ${a.city}` : "");
};

export class InsufficientEvidence extends Error { constructor() { super("insufficient_evidence"); } }

export async function generatePreliminary(db: Database, provider: DataProvider, caseId: string, actor: string, now = new Date()): Promise<AppraisalRow> {
  ensureOpsTables(db);
  const st = caseState(db, caseId, now.getTime());
  if (!st) throw new Error("not found");
  const c = st.c;
  if (!c.subject.address.city || !c.subject.address.street) throw new Error("address required");
  const facts: ValuationFacts = { caseListings: caseListings(db, caseId, c.subject.address.city) };
  const v = await valuate(c.subject, provider, now.toISOString().slice(0, 10), facts);
  if (!v.value) {
    logEvent(db, { caseId, actor, kind: "prelim_insufficient", data: { comparables: v.comparables.used.length } });
    throw new InsufficientEvidence();
  }
  const id = crypto.randomUUID();
  const limitations = [...st.readiness.limitations, ...v.warnings.map((w) => `warning:${w.key}`)];
  const evidence = v.comparables.used.slice(0, 12).map((x) => ({
    address: [x.deal.address.street, x.deal.address.number].filter(Boolean).join(" "), date: x.deal.date, price: x.deal.price, area: x.deal.area, distanceM: Math.round(x.distanceM),
  }));
  db.transaction(() => {
    db.query(`UPDATE appraisals SET status = 'superseded' WHERE case_id = ? AND status IN ('draft', 'approved')`).run(caseId);
    db.query(`INSERT INTO appraisals (id, case_id, kind, status, created_at, created_by, low, point, high, confidence, readiness, comparables, limitations, evidence)
              VALUES (?, ?, 'preliminary', 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, caseId, now.toISOString(), actor, v.value!.low, v.value!.point, v.value!.high, v.comparables.confidence, st.readiness.confidence,
        v.comparables.used.length, JSON.stringify(limitations), JSON.stringify(evidence));
  })();
  if (c.status === "submitted" || c.status === "working") setCaseStatus(db, caseId, "prelim_review");
  logEvent(db, { caseId, actor, kind: "prelim_generated", data: { id, low: v.value.low, high: v.value.high, confidence: v.comparables.confidence } });
  syncCaseTasks(db, caseId);
  return listAppraisals(db, caseId).find((a) => a.id === id)!;
}

export function decidePreliminary(db: Database, id: string, action: "approve" | "send" | "reject", actor: string, note?: string): AppraisalRow {
  ensureOpsTables(db);
  const r = db.query(`SELECT * FROM appraisals WHERE id = ?`).get(id) as any;
  if (!r) throw new Error("not found");
  const a = toAppraisal(r);
  const at = new Date().toISOString();
  const c = getCase(db, a.caseId);
  if (!c) throw new Error("not found");
  if (action === "approve") {
    if (a.status !== "draft") throw new Error("only a draft can be approved");
    db.query(`UPDATE appraisals SET status = 'approved', approved_by = ?, approved_at = ?, note = COALESCE(?, note) WHERE id = ?`).run(actor, at, note ?? null, id);
  } else if (action === "send") {
    if (a.status !== "approved") throw new Error("approve before sending");
    db.query(`UPDATE appraisals SET status = 'sent', sent_at = ? WHERE id = ?`).run(at, id);
    if (!c.status.startsWith("full_")) setCaseStatus(db, c.id, "prelim_sent");
    const owner = c.ownerId ? (db.query(`SELECT id, email, lang FROM users WHERE id = ?`).get(c.ownerId) as any) : null;
    if (owner) {
      const base = getSettings(db).publicUrl;
      enqueue(db, { userId: owner.id, caseId: c.id, kind: "prelim_ready", to: owner.email, lang: owner.lang === "en" ? "en" : "he",
        params: { address: addressOf(c), link: stepUrl(base, c.id, "result") }, dedupe: `prelim_ready:${id}`, createdBy: actor });
    }
  } else {
    if (a.status === "sent") throw new Error("already sent");
    db.query(`UPDATE appraisals SET status = 'superseded', note = ? WHERE id = ?`).run(note ?? "rejected", id);
    if (c.status === "prelim_review") setCaseStatus(db, c.id, "working");
  }
  logEvent(db, { caseId: a.caseId, actor, kind: `prelim_${action === "reject" ? "rejected" : action === "approve" ? "approved" : "sent"}`, data: { id, note } });
  syncCaseTasks(db, a.caseId);
  return toAppraisal(db.query(`SELECT * FROM appraisals WHERE id = ?`).get(id));
}

// ---- Full professional appraisal -----------------------------------------------------------------

export type FullPurpose = "bank" | "sale" | "purchase" | "tax" | "litigation" | "inheritance" | "other";
export const FULL_PURPOSES: FullPurpose[] = ["bank", "sale", "purchase", "tax", "litigation", "inheritance", "other"];
export type FullStatus = "requested" | "quoted" | "accepted" | "in_progress" | "signed" | "delivered" | "cancelled";
export const PAYMENTS = ["none", "pending", "paid", "waived"] as const;

/** What each purpose needs. The appraiser can add or remove items. */
export function checklistFor(p: FullPurpose): { key: string; done: boolean }[] {
  const base = ["verify_ownership", "verify_permit", "verify_area", "inspection", "comparables_review", "report_draft", "sign_off"];
  const extra: Record<FullPurpose, string[]> = {
    bank: ["bank_format"], sale: [], purchase: [], tax: ["value_date"], litigation: ["court_format", "conflict_check"], inheritance: ["value_date"], other: [],
  };
  const all = [...base.slice(0, 5), ...extra[p], ...base.slice(5)];
  return all.map((key) => ({ key, done: false }));
}

export interface FullRow {
  id: string; caseId: string; createdAt: string; updatedAt: string; requestedBy?: string; purpose: FullPurpose; purposeNote?: string;
  status: FullStatus; quote?: number; payment: (typeof PAYMENTS)[number]; appraiser?: string; checklist: { key: string; done: boolean; by?: string; at?: string }[];
}
const toFull = (r: any): FullRow => ({
  id: r.id, caseId: r.case_id, createdAt: r.created_at, updatedAt: r.updated_at, requestedBy: r.requested_by ?? undefined, purpose: r.purpose,
  purposeNote: r.purpose_note ?? undefined, status: r.status, quote: r.quote_nis ?? undefined, payment: r.payment ?? "none",
  appraiser: r.appraiser ?? undefined, checklist: r.checklist ? JSON.parse(r.checklist) : [],
});

export function getFull(db: Database, caseId: string): FullRow | null {
  ensureOpsTables(db);
  const r = db.query(`SELECT * FROM full_requests WHERE case_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1`).get(caseId);
  return r ? toFull(r) : null;
}

const STATUS_OF: Record<FullStatus, CaseRecord["status"] | null> = {
  requested: "full_requested", quoted: "full_requested", accepted: "full_in_progress", in_progress: "full_in_progress", signed: "full_in_progress", delivered: "full_done", cancelled: null,
};

/** Open a full appraisal for a property (from the intake, after the preliminary, or by an admin). Once. */
export function requestFull(db: Database, caseId: string, input: { purpose?: string; note?: string }, actor: { id?: string; label: string }): FullRow {
  ensureOpsTables(db);
  const existing = getFull(db, caseId);
  if (existing) return existing;
  const c = getCase(db, caseId);
  if (!c) throw new Error("not found");
  const purpose = (FULL_PURPOSES.includes(input.purpose as FullPurpose) ? input.purpose : "other") as FullPurpose;
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.query(`INSERT INTO full_requests (id, case_id, created_at, updated_at, requested_by, purpose, purpose_note, status, payment, checklist) VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', 'none', ?)`)
    .run(id, caseId, at, at, actor.id ?? actor.label, purpose, input.note?.slice(0, 1000) ?? null, JSON.stringify(checklistFor(purpose)));
  db.query(`UPDATE cases SET service = 'full' WHERE id = ?`).run(caseId);
  if (c.status === "draft") setCaseStatus(db, caseId, "submitted");
  setCaseStatus(db, caseId, "full_requested");
  logEvent(db, { caseId, userId: actor.id, actor: actor.label, kind: "full_requested", data: { id, purpose } });
  const owner = c.ownerId ? (db.query(`SELECT id, email, name, phone, lang FROM users WHERE id = ?`).get(c.ownerId) as any) : null;
  if (owner) {
    db.query(`UPDATE full_requests SET contact = ? WHERE id = ?`).run(JSON.stringify({ name: owner.name, email: owner.email, phone: owner.phone }), id);
    enqueue(db, { userId: owner.id, caseId, kind: "full_received", to: owner.email, lang: owner.lang === "en" ? "en" : "he", params: { address: addressOf(c), purpose }, dedupe: `full_received:${id}` });
  }
  for (const to of adminEmails()) {
    enqueue(db, { caseId, kind: "admin_full_request", to, lang: "he", params: { address: addressOf(c), purpose, client: owner ? `${owner.name ?? ""} <${owner.email}>` : "" }, dedupe: `admin_full:${id}:${to}` });
  }
  syncCaseTasks(db, caseId);
  return getFull(db, caseId)!;
}

export interface FullPatch { status?: FullStatus; quote?: number; payment?: string; appraiser?: string; item?: { key: string; done: boolean }; addItem?: string; purpose?: string }

export function updateFull(db: Database, id: string, p: FullPatch, actor: string): FullRow {
  ensureOpsTables(db);
  const r = db.query(`SELECT * FROM full_requests WHERE id = ?`).get(id);
  if (!r) throw new Error("not found");
  const f = toFull(r);
  const at = new Date().toISOString();
  const next = { ...f };
  if (p.purpose && FULL_PURPOSES.includes(p.purpose as FullPurpose) && p.purpose !== f.purpose) {
    next.purpose = p.purpose as FullPurpose;
    const done = new Map(f.checklist.map((i) => [i.key, i]));
    next.checklist = checklistFor(next.purpose).map((i) => done.get(i.key) ?? i);
  }
  if (p.quote !== undefined) {
    const q = Math.round(Number(p.quote));
    if (!Number.isFinite(q) || q <= 0 || q > 1_000_000) throw new Error("bad quote");
    next.quote = q;
  }
  if (p.payment !== undefined) {
    if (!(PAYMENTS as readonly string[]).includes(p.payment)) throw new Error("bad payment");
    next.payment = p.payment as FullRow["payment"];
  }
  if (p.appraiser !== undefined) next.appraiser = p.appraiser.trim().toLowerCase() || undefined;
  if (p.item) next.checklist = f.checklist.map((i) => (i.key === p.item!.key ? { ...i, done: p.item!.done, by: actor, at } : i));
  if (p.addItem) {
    const key = p.addItem.trim().slice(0, 60);
    if (key && !next.checklist.some((i) => i.key === key)) next.checklist = [...next.checklist.slice(0, -1), { key, done: false }, ...next.checklist.slice(-1)];
  }
  if (p.status && p.status !== f.status) {
    const allowed: Record<FullStatus, FullStatus[]> = {
      requested: ["quoted", "accepted", "cancelled"], quoted: ["accepted", "requested", "cancelled"], accepted: ["in_progress", "cancelled"],
      in_progress: ["signed", "cancelled"], signed: ["delivered", "in_progress"], delivered: [], cancelled: [],
    };
    if (!allowed[f.status].includes(p.status)) throw new Error(`cannot go from ${f.status} to ${p.status}`);
    if (p.status === "quoted" && !next.quote) throw new Error("set the quote first");
    if (p.status === "in_progress" && !next.appraiser) throw new Error("assign a licensed appraiser first");
    // Professional sign-off: every checklist item, including the appraiser's sign-off, must be done.
    if (p.status === "signed" && next.checklist.some((i) => !i.done)) throw new Error("checklist incomplete");
    next.status = p.status;
  }
  db.query(`UPDATE full_requests SET status = ?, quote_nis = ?, payment = ?, appraiser = ?, checklist = ?, purpose = ?, updated_at = ? WHERE id = ?`)
    .run(next.status, next.quote ?? null, next.payment, next.appraiser ?? null, JSON.stringify(next.checklist), next.purpose, at, id);
  const c = getCase(db, f.caseId);
  if (next.status !== f.status) {
    const cs = STATUS_OF[next.status];
    if (cs) setCaseStatus(db, f.caseId, cs);
    if (next.status === "cancelled" && c) { db.query(`UPDATE cases SET service = 'free' WHERE id = ?`).run(f.caseId); setCaseStatus(db, f.caseId, sentAppraisal(db, f.caseId) ? "prelim_sent" : "working"); }
    if (next.status === "quoted" && c?.ownerId) {
      const owner = db.query(`SELECT id, email, lang FROM users WHERE id = ?`).get(c.ownerId) as any;
      if (owner) enqueue(db, { userId: owner.id, caseId: c.id, kind: "full_quote", to: owner.email, lang: owner.lang === "en" ? "en" : "he",
        params: { address: addressOf(c), quote: next.quote, link: stepUrl(getSettings(db).publicUrl, c.id, "result") }, dedupe: `full_quote:${id}:${next.quote}`, createdBy: actor });
    }
  }
  logEvent(db, { caseId: f.caseId, actor, kind: "full_updated", data: { id, ...p } });
  syncCaseTasks(db, f.caseId);
  return toFull(db.query(`SELECT * FROM full_requests WHERE id = ?`).get(id));
}
