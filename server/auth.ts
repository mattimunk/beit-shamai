/**
 * Accounts without passwords: the user types an email, gets a 6-digit code, and is signed in.
 * Sign-up and sign-in are the same step; a profile (name, role…) is filled in on first sign-in.
 *
 * Sessions are random tokens in an HttpOnly cookie; only their hashes are stored. Codes are
 * stored hashed, expire after 10 minutes and allow 5 attempts; at most 5 codes an hour per
 * address. Admins are the addresses in ADMIN_EMAILS. Until email is configured, an admin can
 * sign in with the server's ADMIN_TOKEN as the code.
 */
import type { Database } from "bun:sqlite";
import { mailConfigured, sendMail, type Mailer } from "./mailer";

export type UserRole = "buyer" | "seller" | "agent" | "appraiser" | "attorney" | "mortgage_broker" | "other";
export const USER_ROLES: UserRole[] = ["buyer", "seller", "agent", "appraiser", "attorney", "mortgage_broker", "other"];

export interface User {
  id: string;
  email: string;
  name?: string;
  phone?: string;
  role?: UserRole;
  agency?: string;
  license?: string;
  marketingConsent: boolean;
  createdAt: string;
}

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const SESSION_COOKIE = "bs_session";

export function ensureAuthTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, phone TEXT, role TEXT, agency TEXT, license TEXT,
      marketing_consent INTEGER DEFAULT 0, consent_at TEXT, created_at TEXT, last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS login_codes (email TEXT, code_hash TEXT, expires_at INTEGER, attempts INTEGER DEFAULT 0, created_at INTEGER);
    CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes(email);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, created_at INTEGER, expires_at INTEGER);
  `);
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
export const normaliseEmail = (e: string) => e.trim().toLowerCase();
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "").split(",").map(normaliseEmail).filter(Boolean);
}
export const isAdminUser = (u: User | null) => !!u && adminEmails().includes(u.email);

function rowToUser(r: any): User {
  return {
    id: r.id, email: r.email, name: r.name ?? undefined, phone: r.phone ?? undefined, role: r.role ?? undefined,
    agency: r.agency ?? undefined, license: r.license ?? undefined, marketingConsent: !!r.marketing_consent, createdAt: r.created_at,
  };
}

export function getUser(db: Database, id: string): User | null {
  ensureAuthTables(db);
  const r = db.query(`SELECT * FROM users WHERE id = ?`).get(id);
  return r ? rowToUser(r) : null;
}

/** Send a sign-in code. Returns whether it went by email (false: written to the server log). */
export async function requestCode(db: Database, emailIn: string, lang: "he" | "en" = "he", mailer: Mailer = sendMail, now = Date.now()) {
  ensureAuthTables(db);
  const email = normaliseEmail(emailIn);
  if (!validEmail(email)) throw new Error("invalid email");
  const recent = (db.query(`SELECT COUNT(*) AS n FROM login_codes WHERE email = ? AND created_at > ?`).get(email, now - 3600_000) as { n: number }).n;
  if (recent >= 5) throw new Error("too many codes – try again in an hour");
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  const code = String(n).padStart(6, "0");
  db.query(`DELETE FROM login_codes WHERE expires_at < ?`).run(now);
  db.query(`INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)`).run(email, sha256(`${email}:${code}`), now + CODE_TTL_MS, now);
  const he = lang === "he";
  const res = await mailer({
    to: email,
    subject: he ? `קוד הכניסה שלך לבית שמאי: ${code}` : `Your Beit Shamai sign-in code: ${code}`,
    text: he
      ? `שלום,\n\nקוד הכניסה שלך הוא: ${code}\nהקוד תקף ל-10 דקות.\n\nאם לא ביקשת קוד, אפשר להתעלם מהודעה זו.\n\nבית שמאי`
      : `Hello,\n\nYour sign-in code is: ${code}\nIt is valid for 10 minutes.\n\nIf you did not ask for a code, you can ignore this message.\n\nBeit Shamai`,
  });
  return { emailed: res.sent };
}

/** Check a code; on success create the user if new and open a session. */
export function verifyCode(db: Database, emailIn: string, code: string, now = Date.now()): { token: string; user: User; isNew: boolean } {
  ensureAuthTables(db);
  const email = normaliseEmail(emailIn);
  const c = code.replace(/\D/g, "");
  // Bootstrap before email works: an admin address may use the server's admin token as the code.
  const adminToken = process.env.ADMIN_TOKEN;
  const viaToken = !mailConfigured() && !!adminToken && adminEmails().includes(email) && code.trim() === adminToken;
  if (!viaToken) {
    const rows = db.query(`SELECT rowid, code_hash, attempts FROM login_codes WHERE email = ? AND expires_at > ? ORDER BY created_at DESC`).all(email, now) as any[];
    if (!rows.length) throw new Error("code expired – ask for a new one");
    const hit = rows.find((r) => r.attempts < 5 && r.code_hash === sha256(`${email}:${c}`));
    if (!hit) {
      db.query(`UPDATE login_codes SET attempts = attempts + 1 WHERE email = ? AND expires_at > ?`).run(email, now);
      throw new Error("wrong code");
    }
    db.query(`DELETE FROM login_codes WHERE email = ?`).run(email);
  }
  let row = db.query(`SELECT * FROM users WHERE email = ?`).get(email) as any;
  const isNew = !row;
  if (!row) {
    const id = crypto.randomUUID();
    db.query(`INSERT INTO users (id, email, created_at, marketing_consent) VALUES (?, ?, ?, 0)`).run(id, email, new Date(now).toISOString());
    row = db.query(`SELECT * FROM users WHERE id = ?`).get(id);
  }
  db.query(`UPDATE users SET last_login = ? WHERE id = ?`).run(new Date(now).toISOString(), row.id);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  db.query(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(sha256(token), row.id, now, now + SESSION_TTL_MS);
  return { token, user: rowToUser(row), isNew: isNew || !row.role };
}

export function sessionUser(db: Database, req: Request, now = Date.now()): User | null {
  ensureAuthTables(db);
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})`));
  if (!m) return null;
  const s = db.query(`SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`).get(sha256(m[1]!)) as { user_id: string; expires_at: number } | null;
  if (!s || s.expires_at < now) return null;
  return getUser(db, s.user_id);
}

export function endSession(db: Database, req: Request) {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})`));
  if (m) db.query(`DELETE FROM sessions WHERE token_hash = ?`).run(sha256(m[1]!));
}

export function sessionCookie(token: string, req: Request, clear = false): string {
  const secure = (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";
  return `${SESSION_COOKIE}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

export interface ProfileInput { name?: string; phone?: string; role?: string; agency?: string; license?: string; marketingConsent?: boolean }

export function updateProfile(db: Database, userId: string, pIn: ProfileInput): User {
  let p = pIn;
  const cur = getUser(db, userId);
  if (!cur) throw new Error("no such user");
  const role = p.role !== undefined ? (USER_ROLES.includes(p.role as UserRole) ? p.role : null) : cur.role ?? null;
  const clip = (s: string | undefined, n: number) => (s === undefined ? undefined : s.trim().slice(0, n) || null);
  const consent = p.marketingConsent ?? cur.marketingConsent;
  if (p.phone !== undefined) {
    const ph = p.phone.replace(/[^\d+]/g, "");
    if (ph && !/^\+\d{7,16}$/.test(ph)) throw new Error("invalid phone");
    p = { ...p, phone: ph };
  }
  db.query(
    `UPDATE users SET name = COALESCE(?, name), phone = CASE WHEN ? THEN ? ELSE phone END, role = ?, agency = COALESCE(?, agency), license = COALESCE(?, license),
       marketing_consent = ?, consent_at = CASE WHEN ? != marketing_consent THEN ? ELSE consent_at END WHERE id = ?`,
  ).run(clip(p.name, 100) ?? null, p.phone !== undefined ? 1 : 0, p.phone || null, role, clip(p.agency, 100) ?? null, clip(p.license, 30) ?? null,
    consent ? 1 : 0, consent ? 1 : 0, new Date().toISOString(), userId);
  return getUser(db, userId)!;
}
