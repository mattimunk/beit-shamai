/**
 * Property files ("תיקי נכס"): one per property, holding its details. Documents, adverts,
 * visit films and orders hang off the same id. The id is a long random value and acts as the
 * key – whoever has it (the agent's browser, or a filming link sent to a buyer) can open it.
 * There are no user accounts yet.
 */
import type { Database } from "bun:sqlite";
import type { Subject } from "../src/engine/types";

export const CASE_ID = /^[A-Za-z0-9-]{16,64}$/;

/** Where a property file stands in the admin pipeline. */
export type CaseStatus = "draft" | "submitted" | "data" | "documents" | "review" | "done";
export const CASE_STATUSES: CaseStatus[] = ["draft", "submitted", "data", "documents", "review", "done"];

export interface CaseSummary {
  id: string; address: string; updatedAt: string; createdAt: string; shots: number;
  status: CaseStatus; submittedAt?: string; statusAt?: string;
  owner?: { id: string; email: string; name?: string; role?: string };
  request?: { id: string; status: string; done: number; total: number };
}
export interface CaseRecord { id: string; subject: Subject; createdAt: string; updatedAt: string; status: CaseStatus; ownerId?: string; submittedAt?: string }

export function ensureCaseTables(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, subject TEXT, created_at TEXT, updated_at TEXT)`);
  for (const col of ["owner_id TEXT", "status TEXT DEFAULT 'draft'", "submitted_at TEXT", "status_at TEXT"]) {
    try { db.exec(`ALTER TABLE cases ADD COLUMN ${col}`); } catch { /* already there */ }
  }
}

/** Create or update; a signed-in user saving a file that has no owner yet becomes its owner. */
export function saveCase(db: Database, id: string, subject: Subject, userId?: string): CaseRecord {
  ensureCaseTables(db);
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO cases (id, subject, created_at, updated_at, owner_id, status) VALUES (?, ?, ?, ?, ?, 'draft')
     ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, updated_at = excluded.updated_at,
       owner_id = COALESCE(cases.owner_id, excluded.owner_id)`,
  ).run(id, JSON.stringify(subject), now, now, userId ?? null);
  return getCase(db, id)!;
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
    ? { id: r.id, subject: JSON.parse(r.subject), createdAt: r.created_at, updatedAt: r.updated_at, status: r.status ?? "draft", ownerId: r.owner_id ?? undefined, submittedAt: r.submitted_at ?? undefined }
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
      status: (r.status ?? "draft") as CaseStatus, submittedAt: r.submitted_at ?? undefined, statusAt: r.status_at ?? undefined,
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
      const status: CaseStatus = r.status === "final" ? "review" : "submitted";
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
