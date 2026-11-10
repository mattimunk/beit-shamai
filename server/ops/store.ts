/**
 * Operations data: activity history, tasks, outgoing messages, internal notes, settings,
 * preliminary appraisals and full-appraisal workflows. All tables live in the same SQLite
 * database as the property files and users; nothing here duplicates them.
 */
import type { Database } from "bun:sqlite";

const ready = new WeakSet<Database>();

export function ensureOpsTables(db: Database) {
  if (ready.has(db)) return;
  ready.add(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, case_id TEXT, user_id TEXT, actor TEXT, kind TEXT NOT NULL, data TEXT
    );
    CREATE INDEX IF NOT EXISTS events_case ON events(case_id, at);
    CREATE INDEX IF NOT EXISTS events_user ON events(user_id, at);
    CREATE INDEX IF NOT EXISTS events_kind ON events(kind, at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '', key TEXT NOT NULL,
      party TEXT NOT NULL, category TEXT NOT NULL, priority INTEGER NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, due_at TEXT, done_at TEXT, done_by TEXT, resolution TEXT,
      note TEXT, snooze_until TEXT, assignee TEXT, data TEXT,
      reminders_sent INTEGER DEFAULT 0, last_reminder_at TEXT, reminders_paused INTEGER DEFAULT 0,
      UNIQUE(case_id, user_id, key)
    );
    CREATE INDEX IF NOT EXISTS tasks_open ON tasks(status, priority);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, user_id TEXT, case_id TEXT, kind TEXT NOT NULL, to_addr TEXT NOT NULL, lang TEXT,
      subject TEXT, body TEXT, params TEXT, status TEXT NOT NULL, attempts INTEGER DEFAULT 0, last_error TEXT, via TEXT,
      created_at TEXT NOT NULL, created_by TEXT, sent_at TEXT, next_attempt_at TEXT, dedupe TEXT UNIQUE, task_keys TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_due ON messages(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id, created_at);
    CREATE INDEX IF NOT EXISTS messages_case ON messages(case_id, created_at);

    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, user_id TEXT, case_id TEXT, author TEXT, text TEXT NOT NULL, at TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS appraisals (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT,
      low REAL, point REAL, high REAL, confidence TEXT, readiness INTEGER, comparables INTEGER, limitations TEXT, evidence TEXT,
      approved_by TEXT, approved_at TEXT, sent_at TEXT, note TEXT
    );
    CREATE INDEX IF NOT EXISTS appraisals_case ON appraisals(case_id, created_at);

    CREATE TABLE IF NOT EXISTS full_requests (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, requested_by TEXT,
      purpose TEXT, purpose_note TEXT, status TEXT NOT NULL, quote_nis REAL, payment TEXT DEFAULT 'none',
      appraiser TEXT, checklist TEXT, contact TEXT
    );
    CREATE INDEX IF NOT EXISTS full_case ON full_requests(case_id);
  `);
}

// ---- Settings -----------------------------------------------------------------------------------

export interface OpsSettings {
  /** Market data for a city counts as current for this many days after the source was last checked… */
  freshDays: number;
  /** …needs review until this many days, and is outdated after. */
  outdatedDays: number;
  /** Reminder n is sent this many days after the item was first requested. */
  reminderDays: number[];
  remindersOn: boolean;
  /** A property waiting longer than this many days is flagged as waiting too long. */
  staleDays: number;
  /** Comparable sales searched within this radius (m) for the market-evidence check. */
  marketRadiusM: number;
  /** …and this many months back. */
  marketMonths: number;
  /** Where links in emails point. */
  publicUrl: string;
}

export const DEFAULT_SETTINGS: OpsSettings = {
  freshDays: 30,
  outdatedDays: 90,
  reminderDays: [2, 5, 10],
  remindersOn: true,
  staleDays: 3,
  marketRadiusM: 700,
  marketMonths: 24,
  publicUrl: process.env.PUBLIC_URL ?? "https://beitsham.ai",
};

export function getSettings(db: Database): OpsSettings {
  ensureOpsTables(db);
  const rows = db.query(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  const out: any = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) { try { out[r.key] = JSON.parse(r.value); } catch { /* keep default */ } }
  return out as OpsSettings;
}

/** Validated update; unknown keys and out-of-range values are refused. */
export function saveSettings(db: Database, patch: Partial<OpsSettings>): OpsSettings {
  ensureOpsTables(db);
  const cur = getSettings(db);
  const next = { ...cur };
  const int = (v: unknown, lo: number, hi: number) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error("bad value");
    return n;
  };
  if (patch.freshDays !== undefined) next.freshDays = int(patch.freshDays, 1, 365);
  if (patch.outdatedDays !== undefined) next.outdatedDays = int(patch.outdatedDays, 2, 730);
  if (next.outdatedDays <= next.freshDays) throw new Error("outdated must be after fresh");
  if (patch.reminderDays !== undefined) {
    if (!Array.isArray(patch.reminderDays) || patch.reminderDays.length > 5) throw new Error("bad value");
    next.reminderDays = patch.reminderDays.map((d) => int(d, 1, 60)).sort((a, b) => a - b);
  }
  if (patch.remindersOn !== undefined) next.remindersOn = !!patch.remindersOn;
  if (patch.staleDays !== undefined) next.staleDays = int(patch.staleDays, 1, 60);
  if (patch.marketRadiusM !== undefined) next.marketRadiusM = int(patch.marketRadiusM, 200, 5000);
  if (patch.marketMonths !== undefined) next.marketMonths = int(patch.marketMonths, 3, 60);
  if (patch.publicUrl !== undefined) {
    if (!/^https?:\/\/[^\s/]+$/.test(patch.publicUrl)) throw new Error("bad value");
    next.publicUrl = patch.publicUrl;
  }
  const put = db.query(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(next)) put.run(k, JSON.stringify(v));
  return next;
}

// ---- Activity history -----------------------------------------------------------------------------

export interface EventRow { id: number; at: string; caseId?: string; userId?: string; actor?: string; kind: string; data?: any }

export function logEvent(db: Database, e: { caseId?: string; userId?: string; actor?: string; kind: string; data?: unknown }, at = new Date().toISOString()) {
  ensureOpsTables(db);
  db.query(`INSERT INTO events (at, case_id, user_id, actor, kind, data) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(at, e.caseId ?? null, e.userId ?? null, e.actor ?? null, e.kind, e.data === undefined ? null : JSON.stringify(e.data));
}

const toEvent = (r: any): EventRow => ({
  id: r.id, at: r.at, caseId: r.case_id ?? undefined, userId: r.user_id ?? undefined, actor: r.actor ?? undefined, kind: r.kind,
  data: r.data ? JSON.parse(r.data) : undefined,
});

export function caseEvents(db: Database, caseId: string, limit = 300): EventRow[] {
  ensureOpsTables(db);
  return (db.query(`SELECT * FROM events WHERE case_id = ? ORDER BY id DESC LIMIT ?`).all(caseId, limit) as any[]).map(toEvent);
}
export function userEvents(db: Database, userId: string, limit = 200): EventRow[] {
  ensureOpsTables(db);
  return (db.query(`SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, limit) as any[]).map(toEvent);
}
export function recentEvents(db: Database, kinds: string[], sinceIso: string, limit = 50): EventRow[] {
  ensureOpsTables(db);
  return (db.query(`SELECT * FROM events WHERE kind IN (${kinds.map(() => "?").join(",")}) AND at >= ? ORDER BY id DESC LIMIT ?`)
    .all(...kinds, sinceIso, limit) as any[]).map(toEvent);
}

// ---- Internal notes (admins only; never returned by any applicant route) --------------------------

export interface Note { id: string; userId?: string; caseId?: string; author: string; text: string; at: string }

export function addNote(db: Database, n: { userId?: string; caseId?: string; author: string; text: string }): Note {
  ensureOpsTables(db);
  const text = n.text.trim().slice(0, 4000);
  if (!text) throw new Error("empty note");
  const note: Note = { id: crypto.randomUUID(), userId: n.userId, caseId: n.caseId, author: n.author, text, at: new Date().toISOString() };
  db.query(`INSERT INTO notes (id, user_id, case_id, author, text, at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(note.id, note.userId ?? null, note.caseId ?? null, note.author, note.text, note.at);
  logEvent(db, { caseId: n.caseId, userId: n.userId, actor: n.author, kind: "note_added" });
  return note;
}

export function listNotes(db: Database, q: { userId?: string; caseId?: string }): Note[] {
  ensureOpsTables(db);
  const rows = q.caseId
    ? db.query(`SELECT * FROM notes WHERE case_id = ? ORDER BY at DESC`).all(q.caseId)
    : db.query(`SELECT * FROM notes WHERE user_id = ? ORDER BY at DESC`).all(q.userId ?? "");
  return (rows as any[]).map((r) => ({ id: r.id, userId: r.user_id ?? undefined, caseId: r.case_id ?? undefined, author: r.author, text: r.text, at: r.at }));
}
