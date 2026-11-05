/**
 * Property files ("תיקי נכס"): one per property, holding its details. Documents, adverts,
 * visit films and orders hang off the same id. The id is a long random value and acts as the
 * key – whoever has it (the agent's browser, or a filming link sent to a buyer) can open it.
 * There are no user accounts yet.
 */
import type { Database } from "bun:sqlite";
import type { Subject } from "../src/engine/types";

export const CASE_ID = /^[A-Za-z0-9-]{16,64}$/;

export interface CaseSummary { id: string; address: string; updatedAt: string; createdAt: string; shots: number }
export interface CaseRecord { id: string; subject: Subject; createdAt: string; updatedAt: string }

export function ensureCaseTables(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS cases (id TEXT PRIMARY KEY, subject TEXT, created_at TEXT, updated_at TEXT)`);
}

export function saveCase(db: Database, id: string, subject: Subject): CaseRecord {
  ensureCaseTables(db);
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO cases (id, subject, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, updated_at = excluded.updated_at`,
  ).run(id, JSON.stringify(subject), now, now);
  return getCase(db, id)!;
}

export function getCase(db: Database, id: string): CaseRecord | null {
  ensureCaseTables(db);
  const r = db.query(`SELECT * FROM cases WHERE id = ?`).get(id) as any;
  return r ? { id: r.id, subject: JSON.parse(r.subject), createdAt: r.created_at, updatedAt: r.updated_at } : null;
}

const addressOf = (s: Subject) => [s.address.street, s.address.number].filter(Boolean).join(" ") + (s.address.city ? `, ${s.address.city}` : "");

/** Summaries for the ids a browser knows about (its own list), newest first. */
export function caseSummaries(db: Database, ids: string[]): CaseSummary[] {
  ensureCaseTables(db);
  const ok = ids.filter((i) => CASE_ID.test(i)).slice(0, 200);
  if (!ok.length) return [];
  let shots = new Map<string, number>();
  try {
    shots = new Map((db.query(`SELECT case_id, COUNT(*) AS n FROM captures WHERE case_id IN (${ok.map(() => "?").join(",")}) GROUP BY case_id`).all(...ok) as any[]).map((r) => [r.case_id, r.n]));
  } catch { /* no captures table yet */ }
  return (db.query(`SELECT * FROM cases WHERE id IN (${ok.map(() => "?").join(",")}) ORDER BY updated_at DESC`).all(...ok) as any[]).map((r) => ({
    id: r.id, address: addressOf(JSON.parse(r.subject)), createdAt: r.created_at, updatedAt: r.updated_at, shots: shots.get(r.id) ?? 0,
  }));
}
