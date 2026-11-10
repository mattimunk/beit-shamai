/**
 * Property files ("תיקי נכס"): one per property, holding its details. Documents, adverts,
 * visit films and orders hang off the same id. The id is a long random value and acts as the
 * key for files without an owner; owned files open only for their owner and admins.
 */
import type { Database } from "bun:sqlite";
import type { Subject } from "../src/engine/types";
import { applicationNumber, overallProgress, upgradeDossier, type Dossier } from "../src/dossier/schema";

export const CASE_ID = /^[A-Za-z0-9-]{16,64}$/;

/**
 * The property's overall stage. What is still missing (documents, market data, rooms…) is not
 * a stage: those are tasks (server/ops.ts), and a property can have several at once.
 */
export type CaseStatus =
  | "draft" | "submitted" | "working" | "prelim_review" | "prelim_sent"
  | "full_requested" | "full_in_progress" | "full_done" | "closed";
export const CASE_STATUSES: CaseStatus[] = ["draft", "submitted", "working", "prelim_review", "prelim_sent", "full_requested", "full_in_progress", "full_done", "closed"];

export interface CaseSummary {
  id: string; address: string; updatedAt: string; createdAt: string; shots: number;
  status: CaseStatus; submittedAt?: string; statusAt?: string; appNo?: string; progress?: number;
  service?: "free" | "full"; assignee?: string;
  owner?: { id: string; email: string; name?: string; role?: string };
  request?: { id: string; status: string; done: number; total: number };
}
export interface CaseRecord {
  id: string; subject: Subject; dossier?: Dossier; appNo?: string; createdAt: string; updatedAt: string; status: CaseStatus;
  ownerId?: string; submittedAt?: string; statusAt?: string; service: "free" | "full"; assignee?: string;
}

/** Next application number for this year (BS-26-00001, …). */
function nextAppNo(db: Database): string {
  const y = new Date().getFullYear();
  db.query(`INSERT INTO app_seq (year, n) VALUES (?, 1) ON CONFLICT(year) DO UPDATE SET n = n + 1`).run(y);
  return applicationNumber((db.query(`SELECT n FROM app_seq WHERE year = ?`).get(y) as { n: number }).n, y);
}

const ready = new WeakSet<Database>();
export function ensureCaseTables(db: Database) {
  if (ready.has(db)) return;
  ready.add(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, subject TEXT, created_at TEXT, updated_at TEXT)`);
  for (const col of ["owner_id TEXT", "status TEXT DEFAULT 'draft'", "submitted_at TEXT", "status_at TEXT", "dossier TEXT", "app_no TEXT", "service TEXT DEFAULT 'free'", "assignee TEXT"]) {
    try { db.exec(`ALTER TABLE cases ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  // Stages before the task system (missing items are tasks now, not stages).
  db.exec(`UPDATE cases SET status = 'working' WHERE status IN ('data', 'documents');
           UPDATE cases SET status = 'prelim_review' WHERE status = 'review';
           UPDATE cases SET status = 'prelim_sent' WHERE status = 'done';`);
  db.exec(`CREATE TABLE IF NOT EXISTS app_seq (year INTEGER PRIMARY KEY, n INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS capture_links (token TEXT PRIMARY KEY, case_id TEXT, created_at INTEGER, expires_at INTEGER, revoked INTEGER DEFAULT 0)`);
}

/** Create or update; a signed-in user saving a file that has no owner yet becomes its owner. */
export function saveCase(db: Database, id: string, subject: Subject, userId?: string, dossier?: Dossier): CaseRecord {
  ensureCaseTables(db);
  const now = new Date().toISOString();
  const exists = db.query(`SELECT app_no FROM cases WHERE id = ?`).get(id) as { app_no: string | null } | null;
  const appNo = exists?.app_no ?? nextAppNo(db);
  db.query(
    `INSERT INTO cases (id, subject, created_at, updated_at, owner_id, status, dossier, app_no) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
     ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, updated_at = excluded.updated_at,
       owner_id = COALESCE(cases.owner_id, excluded.owner_id), dossier = COALESCE(excluded.dossier, cases.dossier),
       app_no = COALESCE(cases.app_no, excluded.app_no)`,
  ).run(id, JSON.stringify(subject), now, now, userId ?? null, dossier ? JSON.stringify(dossier) : null, appNo);
  return getCase(db, id)!;
}

// ---- Filming links (QR / WhatsApp): temporary, revocable, one property, filming only ----------

export const CAPTURE_LINK_HOURS = 48;

/** A new filming link for a property; any earlier link for it stops working. */
export function newCaptureLink(db: Database, caseId: string, now = Date.now()): { token: string; expiresAt: number } {
  ensureCaseTables(db);
  db.query(`UPDATE capture_links SET revoked = 1 WHERE case_id = ?`).run(caseId);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
  const expiresAt = now + CAPTURE_LINK_HOURS * 3600_000;
  db.query(`INSERT INTO capture_links (token, case_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)`).run(token, caseId, now, expiresAt);
  return { token, expiresAt };
}

export function captureLinkCase(db: Database, token: string, now = Date.now()): string | null {
  ensureCaseTables(db);
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return null;
  const r = db.query(`SELECT case_id, expires_at, revoked FROM capture_links WHERE token = ?`).get(token) as { case_id: string; expires_at: number; revoked: number } | null;
  return r && !r.revoked && r.expires_at > now ? r.case_id : null;
}

export function revokeCaptureLinks(db: Database, caseId: string) {
  ensureCaseTables(db);
  db.query(`UPDATE capture_links SET revoked = 1 WHERE case_id = ?`).run(caseId);
}

export function setCaseStatus(db: Database, id: string, status: CaseStatus) {
  ensureCaseTables(db);
  if (!CASE_STATUSES.includes(status)) throw new Error("bad status");
  const now = new Date().toISOString();
  db.query(`UPDATE cases SET status = ?, status_at = ?, submitted_at = CASE WHEN ? = 'submitted' AND submitted_at IS NULL THEN ? ELSE submitted_at END WHERE id = ?`)
    .run(status, now, status, now, id);
}

export function getCase(db: Database, id: string): CaseRecord | null {
  ensureCaseTables(db);
  const r = db.query(`SELECT * FROM cases WHERE id = ?`).get(id) as any;
  return r
    ? {
        id: r.id, subject: JSON.parse(r.subject), dossier: r.dossier ? upgradeDossier(JSON.parse(r.dossier)) : undefined, appNo: r.app_no ?? undefined,
        createdAt: r.created_at, updatedAt: r.updated_at, status: r.status ?? "draft", ownerId: r.owner_id ?? undefined, submittedAt: r.submitted_at ?? undefined,
        statusAt: r.status_at ?? undefined, service: r.service === "full" ? "full" : "free", assignee: r.assignee ?? undefined,
      }
    : null;
}

const addressOf = (s: Subject) => [s.address.street, s.address.number].filter(Boolean).join(" ") + (s.address.city ? `, ${s.address.city}` : "");

function summarise(db: Database, rows: any[]): CaseSummary[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => "?").join(",");
  const count = (sql: string) => {
    try { return new Map((db.query(sql).all(...ids) as any[]).map((r) => [r.case_id, r.n])); } catch { return new Map(); }
  };
  const shots = count(`SELECT case_id, COUNT(*) AS n FROM captures WHERE case_id IN (${ph}) GROUP BY case_id`);
  let reqs = new Map<string, any>();
  try {
    reqs = new Map((db.query(
      `SELECT r.case_id, r.id, r.status,
         SUM(CASE WHEN p.status IN ('done','covered') THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN p.status IN ('done','covered','pending') THEN 1 ELSE 0 END) AS total
       FROM requests r LEFT JOIN plan_items p ON p.request_id = r.id
       WHERE r.case_id IN (${ph}) GROUP BY r.id ORDER BY r.created_at`,
    ).all(...ids) as any[]).map((r) => [r.case_id, { id: r.id, status: r.status, done: r.done ?? 0, total: r.total ?? 0 }]));
  } catch { /* no requests table yet */ }
  let users = new Map<string, any>();
  try {
    const owners = [...new Set(rows.map((r) => r.owner_id).filter(Boolean))];
    if (owners.length) users = new Map((db.query(`SELECT id, email, name, role FROM users WHERE id IN (${owners.map(() => "?").join(",")})`).all(...owners) as any[]).map((u) => [u.id, u]));
  } catch { /* no users table yet */ }
  return rows.map((r) => {
    const u = r.owner_id ? users.get(r.owner_id) : undefined;
    return {
      id: r.id, address: addressOf(JSON.parse(r.subject)), createdAt: r.created_at, updatedAt: r.updated_at, shots: shots.get(r.id) ?? 0,
      appNo: r.app_no ?? undefined,
      progress: r.dossier ? overallProgress(upgradeDossier(JSON.parse(r.dossier)), { done: 0, total: 0 }) : undefined,
      status: (r.status ?? "draft") as CaseStatus, submittedAt: r.submitted_at ?? undefined, statusAt: r.status_at ?? undefined,
      service: r.service === "full" ? "full" : "free", assignee: r.assignee ?? undefined,
      owner: u ? { id: u.id, email: u.email, name: u.name ?? undefined, role: u.role ?? undefined } : undefined,
      request: reqs.get(r.id),
    };
  });
}

/** Summaries for the ids a browser knows about (its own list), newest first. */
export function caseSummaries(db: Database, ids: string[]): CaseSummary[] {
  ensureCaseTables(db);
  const ok = ids.filter((i) => CASE_ID.test(i)).slice(0, 200);
  if (!ok.length) return [];
  return summarise(db, db.query(`SELECT * FROM cases WHERE id IN (${ok.map(() => "?").join(",")}) ORDER BY updated_at DESC`).all(...ok) as any[]);
}

/** A user's own property files, newest first. */
export function userCases(db: Database, userId: string): CaseSummary[] {
  ensureCaseTables(db);
  return summarise(db, db.query(`SELECT * FROM cases WHERE owner_id = ? ORDER BY updated_at DESC`).all(userId) as any[]);
}

/** Admin: every property file, optionally one status; submitted first, oldest submission first. */
export function allCases(db: Database, status?: CaseStatus): CaseSummary[] {
  ensureCaseTables(db);
  const rows = status
    ? db.query(`SELECT * FROM cases WHERE status = ? ORDER BY COALESCE(submitted_at, updated_at)`).all(status)
    : db.query(`SELECT * FROM cases ORDER BY CASE WHEN status = 'draft' THEN 1 ELSE 0 END, COALESCE(submitted_at, updated_at) DESC LIMIT 1000`).all();
  return summarise(db, rows as any[]);
}

/**
 * Before accounts existed, orders and property files had no owner (and the earliest orders had
 * no file at all). They were all made by the operator, so they are adopted by the admin who
 * opens "My properties": every order without a file gets one (one per address), and every
 * file without an owner is assigned. New files always have an owner, so this only touches the
 * old ones.
 */
export function adoptOrphans(db: Database, adminUserId: string): { filesCreated: number; filesAssigned: number } {
  ensureCaseTables(db);
  let filesCreated = 0;
  let orphans: any[] = [];
  try {
    orphans = db.query(`SELECT r.id, r.created_at, r.status, r.subject, r.case_id FROM requests r
      LEFT JOIN cases c ON c.id = r.case_id WHERE c.id IS NULL ORDER BY r.created_at`).all() as any[];
  } catch { /* no requests table yet */ }
  const byAddress = new Map<string, string>();
  for (const r of orphans) {
    const subject = JSON.parse(r.subject) as Subject;
    const key = addressOf(subject).replace(/\s+/g, " ").trim();
    let caseId = byAddress.get(key);
    if (!caseId) {
      caseId = r.case_id && CASE_ID.test(r.case_id) ? r.case_id : crypto.randomUUID();
      const status: CaseStatus = r.status === "final" ? "prelim_review" : "submitted";
      db.query(`INSERT OR IGNORE INTO cases (id, subject, created_at, updated_at, owner_id, status, submitted_at, status_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(caseId, r.subject, r.created_at, r.created_at, adminUserId, status, r.created_at, r.created_at);
      byAddress.set(key, caseId);
      filesCreated++;
    }
    db.query(`UPDATE requests SET case_id = ? WHERE id = ?`).run(caseId, r.id);
  }
  const assigned = db.query(`UPDATE cases SET owner_id = ? WHERE owner_id IS NULL`).run(adminUserId).changes;
  return { filesCreated, filesAssigned: assigned };
}
