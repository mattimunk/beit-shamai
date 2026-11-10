/**
 * Outgoing messages: an outbox with delivery tracking. Every email is a row first, then sent
 * by the outbox worker with retries (5 min, 30 min, 2 h, 12 h). A message with a `dedupe`
 * key is created at most once (the welcome email, each day's reminder for a property…).
 *
 * Statuses: queued → sent | failed (after retries) | not_sent (no email service configured –
 * nothing was delivered; it can be sent again once one is) | suppressed (the user opted out
 * of reminders) | cancelled.
 */
import type { Database } from "bun:sqlite";
import { sendMail, textToHtml, type Mailer } from "../mailer";
import { ensureOpsTables, getSettings, logEvent } from "./store";

export type MessageKind =
  | "welcome" | "reminder" | "prelim_ready" | "clarify" | "custom" | "full_received" | "full_quote"
  | "admin_new_user" | "admin_full_request";
export type MessageStatus = "queued" | "sent" | "failed" | "not_sent" | "suppressed" | "cancelled";

export interface MessageRow {
  id: string; userId?: string; caseId?: string; kind: MessageKind; to: string; lang: "he" | "en";
  subject?: string; body?: string; params?: any; status: MessageStatus; attempts: number; lastError?: string; via?: string;
  createdAt: string; createdBy?: string; sentAt?: string; nextAttemptAt?: string; dedupe?: string; taskKeys: string[];
}

const toMsg = (r: any): MessageRow => ({
  id: r.id, userId: r.user_id ?? undefined, caseId: r.case_id ?? undefined, kind: r.kind, to: r.to_addr, lang: r.lang === "en" ? "en" : "he",
  subject: r.subject ?? undefined, body: r.body ?? undefined, params: r.params ? JSON.parse(r.params) : undefined, status: r.status,
  attempts: r.attempts ?? 0, lastError: r.last_error ?? undefined, via: r.via ?? undefined, createdAt: r.created_at, createdBy: r.created_by ?? undefined,
  sentAt: r.sent_at ?? undefined, nextAttemptAt: r.next_attempt_at ?? undefined, dedupe: r.dedupe ?? undefined,
  taskKeys: r.task_keys ? JSON.parse(r.task_keys) : [],
});

const BACKOFF_MIN = [5, 30, 120, 720];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

// ---- Links -------------------------------------------------------------------------------------

const secret = () => process.env.LINK_SECRET ?? process.env.ADMIN_TOKEN ?? "beit-shamai-dev";
const hmac = (s: string) => new Bun.CryptoHasher("sha256", secret()).update(s).digest("hex").slice(0, 32);
export const unsubscribeKey = (userId: string) => hmac(`unsub:${userId}`);
export const unsubscribeUrl = (base: string, userId: string) => `${base}/api/unsubscribe?u=${encodeURIComponent(userId)}&k=${unsubscribeKey(userId)}`;
/** Opens the property in the applicant's account (after signing in) at the right step. */
export const stepUrl = (base: string, caseId: string, step: string) => `${base}/?open=${encodeURIComponent(caseId)}&step=${encodeURIComponent(step)}`;

// ---- Templates -------------------------------------------------------------------------------

export interface ReminderItem { key: string; count?: number; link: string }

const BRAND = { he: "בית שמאי", en: "Beit Shamai" };

const ITEM_TEXT: Record<"he" | "en", Record<string, (n?: number) => string>> = {
  he: {
    "doc:floor_plan": () => "תכנית דירה",
    "doc:ownership": () => "מסמך בעלות (נסח טאבו או אישור זכויות)",
    "doc:building_permit": () => "היתר בנייה",
    tour: (n) => (n ? `צילום של ${n} חדרים שעדיין חסרים` : "צילום החדרים"),
    size: () => "שטח הדירה",
    address: () => "כתובת הנכס",
    complete_application: () => "השלמת פרטי הנכס",
    start_application: () => "הוספת הנכס הראשון שלכם",
    full_docs: () => "המסמכים הדרושים להערכה המלאה",
    accept_quote: () => "אישור הצעת המחיר להערכה המלאה",
  },
  en: {
    "doc:floor_plan": () => "the floor plan",
    "doc:ownership": () => "an ownership document (Tabu extract or rights confirmation)",
    "doc:building_permit": () => "the building permit",
    tour: (n) => (n ? `filming the ${n} rooms still missing` : "filming the rooms"),
    size: () => "the apartment's area",
    address: () => "the property's address",
    complete_application: () => "completing the property details",
    start_application: () => "adding your first property",
    full_docs: () => "the documents needed for the full appraisal",
    accept_quote: () => "accepting the quote for the full appraisal",
  },
};

const WHY: Record<"he" | "en", Record<string, string>> = {
  he: {
    "doc:floor_plan": "תכנית הדירה מסייעת לנו להבין טוב יותר את חלוקת השטחים ולבדוק את התאמתם למסמכים הקיימים.",
    "doc:ownership": "מסמך הבעלות מאפשר לנו לאמת את הזכויות בנכס.",
    tour: "צילום קצר של החדרים שעדיין חסרים יעזור לנו להתרשם טוב יותר ממצב הנכס ולשפר את איכות הערכת השווי.",
  },
  en: {
    "doc:floor_plan": "The floor plan helps us understand the layout and check it against the other documents.",
    "doc:ownership": "The ownership document lets us verify the rights in the property.",
    tour: "A short film of the remaining rooms helps us judge the property's condition and improves the estimate.",
  },
};

export function renderMessage(kind: MessageKind, lang: "he" | "en", p: any, name: string | undefined, base: string, userId?: string): { subject: string; text: string } {
  const he = lang === "he";
  const hi = he ? `שלום${name ? ` ${name}` : ""},` : `Hello${name ? ` ${name}` : ""},`;
  const sign = he ? `\n\nבברכה,\nצוות ${BRAND.he}` : `\n\nBest regards,\nThe ${BRAND.en} team`;
  const unsub = userId ? (he ? `\n\nלהפסקת תזכורות: ${unsubscribeUrl(base, userId)}` : `\n\nStop reminders: ${unsubscribeUrl(base, userId)}`) : "";
  switch (kind) {
    case "welcome":
      return he
        ? { subject: `ברוכים הבאים ל${BRAND.he}`, text: `${hi}\n\nברוכים הבאים!\n\nשמחים שהצטרפתם אלינו.\n\nהמערכת שלנו מאפשרת לכם לקבל הערכת שווי ראשונית לנכס שלכם בצורה פשוטה ודיגיטלית, ללא צורך בתיאומים או בניירת מיותרת.\n\nככל שתשלימו יותר פרטים ותעלו מסמכים, נוכל להעניק לכם הערכה מדויקת ומבוססת יותר.\n\nתוכלו לחזור בכל שלב ולהמשיך מהמקום שבו הפסקתם:\n${base}${sign}` }
        : { subject: `Welcome to ${BRAND.en}`, text: `${hi}\n\nWelcome aboard!\n\nWe're glad you joined us.\n\nOur platform gives you a preliminary valuation of your property simply and digitally – no appointments, no unnecessary paperwork.\n\nThe more details and documents you add, the more accurate and better-founded the estimate we can give you.\n\nYou can come back at any time and continue where you left off:\n${base}${sign}` };
    case "reminder": {
      const items: ReminderItem[] = p.items ?? [];
      const T = ITEM_TEXT[lang];
      const one = items.length === 1 ? items[0]! : null;
      const subject = he
        ? one?.key === "tour" ? "נשמח להכיר גם את שאר החדרים" : one?.key === "start_application" ? "נשמח לעזור לכם להתחיל" : "עוד פרט קטן שיעזור לנו לדייק בהערכת הנכס"
        : one?.key === "tour" ? "We'd love to see the remaining rooms" : one?.key === "start_application" ? "Ready when you are" : "One small detail to sharpen your property's estimate";
      const where = p.address ? (he ? `ב${p.address}` : `at ${p.address}`) : "";
      if (one) {
        const why = WHY[lang][one.key];
        const body = he
          ? one.key === "tour"
            ? `${hi}\n\nתודה על הפרטים שכבר שלחתם!\n\n${why}\n\nאפשר להמשיך בצילום ישירות מהטלפון, בדיוק מהמקום שבו הפסקתם:\n${one.link}`
            : `${hi}\n\nאנחנו מתקדמים עם הערכת הנכס שלכם ${where}.\n\nשמנו לב שעדיין חסר: ${T[one.key]?.(one.count) ?? one.key}.${why ? `\n\n${why}` : ""}\n\nאפשר להשלים בקלות דרך הקישור הבא:\n${one.link}\n\nאין לכם את זה כרגע? אין בעיה – אפשר לעדכן אותנו ולהמשיך עם הנתונים הקיימים, בכפוף למגבלות ההערכה.`
          : one.key === "tour"
            ? `${hi}\n\nThank you for the details you've already sent!\n\n${why}\n\nYou can continue filming on your phone, right where you left off:\n${one.link}`
            : `${hi}\n\nWe're moving ahead with the valuation of your property ${where}.\n\nWe noticed one thing is still missing: ${T[one.key]?.(one.count) ?? one.key}.${why ? `\n\n${why}` : ""}\n\nYou can add it easily here:\n${one.link}\n\nDon't have it right now? No problem – let us know and we'll continue with what we have, subject to the estimate's limitations.`;
        return { subject, text: body + sign + unsub };
      }
      const list = items.map((i) => `• ${T[i.key]?.(i.count) ?? i.key}: ${i.link}`).join("\n");
      return {
        subject,
        text: (he
          ? `${hi}\n\nאנחנו מתקדמים עם הערכת הנכס שלכם ${where}.\n\nכמה פרטים יעזרו לנו לדייק:\n${list}\n\nאין לכם חלק מהם כרגע? אפשר להמשיך עם הנתונים הקיימים, בכפוף למגבלות ההערכה.`
          : `${hi}\n\nWe're moving ahead with the valuation of your property ${where}.\n\nA few details would help us be more accurate:\n${list}\n\nMissing some of them? We can continue with what we have, subject to the estimate's limitations.`) + sign + unsub,
      };
    }
    case "prelim_ready":
      return he
        ? { subject: "הערכת השווי הראשונית לנכס שלכם מוכנה", text: `${hi}\n\nהערכת השווי הראשונית לנכס ${p.address ?? ""} מוכנה ומחכה לכם:\n${p.link}\n\nזוהי הערכה ראשונית, שאינה כוללת בהכרח ביקור בנכס ואינה מחליפה שומה של שמאי מקרקעין מוסמך. אם תרצו, אפשר להזמין הערכה מלאה מאותו מקום.${sign}` }
        : { subject: "Your preliminary valuation is ready", text: `${hi}\n\nThe preliminary valuation of ${p.address ?? "your property"} is ready:\n${p.link}\n\nIt is a preliminary estimate, not necessarily based on a site visit, and not a substitute for a formal valuation by a licensed appraiser. You can order a full appraisal from the same page.${sign}` };
    case "full_received":
      return he
        ? { subject: "קיבלנו את בקשתכם להערכה מלאה", text: `${hi}\n\nקיבלנו את בקשתכם לשומה מלאה עבור ${p.address ?? "הנכס"}.\n\nנחזור אליכם בקרוב עם הצעה ופרטים על מה שנדרש. כל הפרטים והמסמכים שכבר מסרתם עוברים אוטומטית – אין צורך למלא שוב.${sign}` }
        : { subject: "We received your full-appraisal request", text: `${hi}\n\nWe received your request for a full appraisal of ${p.address ?? "the property"}.\n\nWe'll be in touch shortly with a quote and what's needed. Everything you've already provided carries over – no need to enter it again.${sign}` };
    case "full_quote":
      return he
        ? { subject: "הצעת מחיר להערכה מלאה", text: `${hi}\n\nהצעת המחיר לשומה מלאה עבור ${p.address ?? "הנכס"}: ₪${Number(p.quote).toLocaleString("he-IL")}.\n\nלפרטים ולאישור:\n${p.link}${sign}` }
        : { subject: "Quote for a full appraisal", text: `${hi}\n\nOur quote for a full appraisal of ${p.address ?? "the property"}: ₪${Number(p.quote).toLocaleString("en-US")}.\n\nDetails and acceptance:\n${p.link}${sign}` };
    case "admin_new_user":
      return { subject: `משתמש חדש נרשם: ${p.email}`, text: `משתמש חדש נרשם ל${BRAND.he}.\n\nדוא״ל: ${p.email}\nשפה: ${p.lang}\n\n${base}` };
    case "admin_full_request":
      return { subject: `בקשה להערכה מלאה: ${p.address ?? ""}`, text: `התקבלה בקשה לשומה מלאה.\n\nנכס: ${p.address ?? ""}\nמטרה: ${p.purpose ?? ""}\nלקוח: ${p.client ?? ""}\n\n${base}` };
    case "clarify":
    case "custom":
      return { subject: p.subject ?? BRAND[lang], text: `${hi}\n\n${p.body ?? ""}${p.link ? `\n\n${p.link}` : ""}${sign}` };
  }
}

// ---- Outbox ------------------------------------------------------------------------------------

export interface EnqueueInput {
  userId?: string; caseId?: string; kind: MessageKind; to: string; lang?: "he" | "en";
  /** Fixed text (admin-written); otherwise rendered from the template when sent. */
  subject?: string; body?: string; params?: unknown;
  dedupe?: string; delayMs?: number; createdBy?: string; taskKeys?: string[];
}

/** Queue a message. Returns null when a message with the same dedupe key already exists. */
export function enqueue(db: Database, m: EnqueueInput, now = Date.now()): MessageRow | null {
  ensureOpsTables(db);
  const id = crypto.randomUUID();
  let status: MessageStatus = "queued";
  if (m.kind === "reminder" && m.userId) {
    const u = db.query(`SELECT reminders_opt_out FROM users WHERE id = ?`).get(m.userId) as { reminders_opt_out: number } | null;
    if (u?.reminders_opt_out) status = "suppressed";
  }
  const res = db.query(
    `INSERT OR IGNORE INTO messages (id, user_id, case_id, kind, to_addr, lang, subject, body, params, status, attempts, created_at, created_by, next_attempt_at, dedupe, task_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(id, m.userId ?? null, m.caseId ?? null, m.kind, m.to, m.lang ?? "he", m.subject ?? null, m.body ?? null,
    m.params === undefined ? null : JSON.stringify(m.params), status, new Date(now).toISOString(), m.createdBy ?? null,
    new Date(now + (m.delayMs ?? 0)).toISOString(), m.dedupe ?? null, JSON.stringify(m.taskKeys ?? []));
  if (!res.changes) return null;
  logEvent(db, { caseId: m.caseId, userId: m.userId, actor: m.createdBy ?? "system", kind: "message_queued", data: { id, kind: m.kind, status } });
  return getMessage(db, id);
}

export function getMessage(db: Database, id: string): MessageRow | null {
  ensureOpsTables(db);
  const r = db.query(`SELECT * FROM messages WHERE id = ?`).get(id);
  return r ? toMsg(r) : null;
}

export function listMessages(db: Database, q: { userId?: string; caseId?: string; status?: string; limit?: number }): MessageRow[] {
  ensureOpsTables(db);
  const where: string[] = [];
  const args: any[] = [];
  if (q.userId) { where.push("user_id = ?"); args.push(q.userId); }
  if (q.caseId) { where.push("case_id = ?"); args.push(q.caseId); }
  if (q.status) { where.push("status = ?"); args.push(q.status); }
  return (db.query(`SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, q.limit ?? 200) as any[]).map(toMsg);
}

/** Put a message back in the queue (after a failure, or once email is configured). */
export function retryMessage(db: Database, id: string, actor: string) {
  ensureOpsTables(db);
  const m = getMessage(db, id);
  if (!m) throw new Error("not found");
  if (m.status === "sent") throw new Error("already sent");
  db.query(`UPDATE messages SET status = 'queued', next_attempt_at = ?, attempts = 0, last_error = NULL WHERE id = ?`).run(new Date().toISOString(), id);
  logEvent(db, { caseId: m.caseId, userId: m.userId, actor, kind: "message_retry", data: { id, kind: m.kind } });
}

let running = false;

/** Send what is due. Safe to call often; one run at a time. */
export async function processOutbox(db: Database, mailer: Mailer = sendMail, now = Date.now()): Promise<{ sent: number; notSent: number; failed: number }> {
  ensureOpsTables(db);
  if (running) return { sent: 0, notSent: 0, failed: 0 };
  running = true;
  const out = { sent: 0, notSent: 0, failed: 0 };
  try {
    const base = getSettings(db).publicUrl;
    const due = (db.query(`SELECT * FROM messages WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 25`)
      .all(new Date(now).toISOString()) as any[]).map(toMsg);
    for (const m of due) {
      const u = m.userId ? (db.query(`SELECT name, lang FROM users WHERE id = ?`).get(m.userId) as { name: string | null; lang: string | null } | null) : null;
      const lang = (u?.lang === "en" ? "en" : u?.lang === "he" ? "he" : m.lang) as "he" | "en";
      const rendered = m.subject && m.body ? { subject: m.subject, text: m.body } : renderMessage(m.kind, lang, m.params ?? {}, u?.name ?? undefined, base, m.kind === "reminder" ? m.userId : undefined);
      try {
        const r = await mailer({ to: m.to, subject: rendered.subject, text: rendered.text, html: textToHtml(rendered.text).replace('dir="rtl"', `dir="${lang === "he" ? "rtl" : "ltr"}"`) });
        const at = new Date(now).toISOString();
        if (r.sent) {
          db.query(`UPDATE messages SET status = 'sent', sent_at = ?, via = ?, attempts = attempts + 1, subject = ?, body = ? WHERE id = ?`).run(at, r.via, rendered.subject, rendered.text, m.id);
          out.sent++;
          logEvent(db, { caseId: m.caseId, userId: m.userId, actor: "system", kind: "message_sent", data: { id: m.id, kind: m.kind, via: r.via } }, at);
        } else {
          db.query(`UPDATE messages SET status = 'not_sent', via = ?, attempts = attempts + 1, last_error = 'email service not configured', subject = ?, body = ? WHERE id = ?`)
            .run(r.via, rendered.subject, rendered.text, m.id);
          out.notSent++;
          logEvent(db, { caseId: m.caseId, userId: m.userId, actor: "system", kind: "message_not_sent", data: { id: m.id, kind: m.kind } }, at);
        }
      } catch (e) {
        const attempts = m.attempts + 1;
        const err = (e as Error).message.slice(0, 300);
        if (attempts >= MAX_ATTEMPTS) {
          db.query(`UPDATE messages SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`).run(attempts, err, m.id);
          out.failed++;
          logEvent(db, { caseId: m.caseId, userId: m.userId, actor: "system", kind: "message_failed", data: { id: m.id, kind: m.kind, error: err } });
        } else {
          const next = new Date(now + BACKOFF_MIN[attempts - 1]! * 60_000).toISOString();
          db.query(`UPDATE messages SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`).run(attempts, err, next, m.id);
        }
      }
    }
  } finally {
    running = false;
  }
  return out;
}
