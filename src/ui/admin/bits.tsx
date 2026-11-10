import { useState, type ReactNode } from "react";
import type { CaseStatus } from "../../data/apiClient";
import { useT } from "../context";
import { useAT } from "./texts";

export function ago(iso: string | undefined, lang: string): string {
  if (!iso) return "—";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (Math.abs(m) < 60) return rtf.format(-m, "minute");
  if (Math.abs(m) < 48 * 60) return rtf.format(-Math.round(m / 60), "hour");
  return rtf.format(-Math.round(m / 1440), "day");
}

export const when = (iso: string | undefined, lang: string) =>
  iso ? new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—";

export function Status({ status }: { status: CaseStatus }) {
  const { t } = useT();
  return <span className={`badge st-${status}`}>{t.pipeline.status[status] ?? status}</span>;
}

export function PriorityTag({ p, blocked, waiting }: { p: number; blocked?: boolean; waiting?: boolean }) {
  const { A } = useAT();
  if (blocked) return <span className="ptag p-blocked">{A.queue.blocked}</span>;
  if (waiting) return <span className="ptag p-waiting">{A.party.user}</span>;
  return <span className={`ptag p${p}`}>{A.priority[p]}</span>;
}

/** 0–100 meter with a label. */
export function Meter({ value, label, help, tone }: { value: number; label: string; help?: string; tone?: "accent" | "level" }) {
  const cls = tone === "level" ? (value >= 80 ? "m-high" : value >= 60 ? "m-good" : value >= 40 ? "m-mod" : "m-low") : "m-accent";
  return (
    <div className="meter" title={help}>
      <div className="meter-top"><span>{label}</span><b>{value}%</b></div>
      <div className={`meter-bar ${cls}`}><i style={{ width: `${Math.max(2, Math.min(100, value))}%` }} /></div>
      {help && <div className="meter-help">{help}</div>}
    </div>
  );
}

export function Stat({ n, label, sub, tone, onClick }: { n: number | string; label: string; sub?: string; tone?: "warn" | "accent" | "ok" | "muted"; onClick?: () => void }) {
  return (
    <button type="button" className={`stat ${tone ?? ""}`} onClick={onClick} disabled={!onClick}>
      <b>{n}</b>
      <span>{label}</span>
      {sub && <small>{sub}</small>}
    </button>
  );
}

/** Ask for a reason (or a short text) inline before an action. */
export function AskReason({ label, onSubmit, onCancel, required = true, initial = "" }: { label: string; onSubmit: (v: string) => void; onCancel: () => void; required?: boolean; initial?: string }) {
  const { A } = useAT();
  const [v, setV] = useState(initial);
  return (
    <form className="ask-reason" onSubmit={(e) => { e.preventDefault(); if (!required || v.trim()) onSubmit(v.trim()); }}>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={label} aria-label={label} />
      <button className="primary" disabled={required && !v.trim()}>{A.common.confirm}</button>
      <button type="button" className="ghost" onClick={onCancel}>{A.common.cancel}</button>
    </form>
  );
}

export function Section({ title, children, extra }: { title: ReactNode; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="adm-card">
      <header className="adm-card-head"><h3>{title}</h3>{extra}</header>
      {children}
    </section>
  );
}

export function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError((e as Error).message); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}
