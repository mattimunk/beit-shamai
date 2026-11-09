import { useState, type ReactNode } from "react";
import type { Maybe, Unsure } from "../../dossier/schema";
import { useIT } from "./texts";

/** One question: label, optional explanation (ⓘ) and example, then the answer control. */
export function Q({ label, help, children, hint }: { label: ReactNode; help?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { T } = useIT();
  return (
    <div className="q">
      <div className="q-label">
        <span>{label}</span>
        {help && (
          <button type="button" className="q-help" aria-expanded={open} aria-label={T.ui.whatIsThis} onClick={() => setOpen(!open)}>ⓘ</button>
        )}
      </div>
      {open && help && <div className="q-explain">{help}</div>}
      {hint && <div className="q-hint">{hint}</div>}
      {children}
    </div>
  );
}

/** "Don't know" / "Later" buttons under a question. */
export function UnsureButtons<T>({ value, onChange, later = true }: { value: Maybe<T>; onChange: (v: Maybe<T>) => void; later?: boolean }) {
  const { T } = useIT();
  const b = (u: Unsure, label: string) => (
    <button type="button" className={"unsure" + (value === u ? " on" : "")} aria-pressed={value === u} onClick={() => onChange(value === u ? undefined : u)}>{label}</button>
  );
  return <div className="unsure-row">{b("unknown", T.ui.dontKnow)}{later && b("later", T.ui.later)}</div>;
}

/** Big tappable cards for a single choice. */
export function Cards<K extends string>({ options, value, onChange, cols = 2, unsure }: {
  options: { key: K; label: ReactNode; icon?: ReactNode; sub?: ReactNode }[];
  value: Maybe<K>; onChange: (v: Maybe<K>) => void; cols?: 2 | 3 | 4; unsure?: boolean;
}) {
  return (
    <>
      <div className={`cards cols-${cols}`} role="radiogroup">
        {options.map((o) => (
          <button key={o.key} type="button" role="radio" aria-checked={value === o.key} className={"choice" + (value === o.key ? " on" : "")} onClick={() => onChange(o.key)}>
            {o.icon && <span className="choice-icon" aria-hidden>{o.icon}</span>}
            <span className="choice-label">{o.label}</span>
            {o.sub && <span className="choice-sub">{o.sub}</span>}
          </button>
        ))}
      </div>
      {unsure && <UnsureButtons value={value} onChange={onChange} />}
    </>
  );
}

/** Small pills for several choices; an optional "none" that clears the others. */
export function Chips<K extends string>({ options, value, onChange, none, unsure }: {
  options: { key: K; label: ReactNode }[]; value: Maybe<K[] | "none">; onChange: (v: Maybe<K[] | "none">) => void; none?: ReactNode; unsure?: boolean;
}) {
  const list = Array.isArray(value) ? value : [];
  const toggle = (k: K) => {
    const next = list.includes(k) ? list.filter((x) => x !== k) : [...list, k];
    onChange(next.length ? next : undefined);
  };
  return (
    <>
      <div className="chip-row">
        {options.map((o) => (
          <button key={o.key} type="button" aria-pressed={list.includes(o.key)} className={"pick" + (list.includes(o.key) ? " on" : "")} onClick={() => toggle(o.key)}>{o.label}</button>
        ))}
        {none && <button type="button" aria-pressed={value === "none"} className={"pick" + (value === "none" ? " on" : "")} onClick={() => onChange(value === "none" ? undefined : "none")}>{none}</button>}
      </div>
      {unsure && <UnsureButtons value={value as Maybe<K[] | "none">} onChange={onChange} later={false} />}
    </>
  );
}

/** Yes / No (+ don't know). */
export function YesNo({ value, onChange, unsure = true }: { value: Maybe<"yes" | "no">; onChange: (v: Maybe<"yes" | "no">) => void; unsure?: boolean }) {
  const { T } = useIT();
  const b = (k: "yes" | "no", label: string) => (
    <button type="button" role="radio" aria-checked={value === k} className={"seg" + (value === k ? " on" : "")} onClick={() => onChange(value === k ? undefined : k)}>{label}</button>
  );
  return (
    <div className="yn">
      <div className="seg-group" role="radiogroup">{b("yes", T.ui.yes)}{b("no", T.ui.no)}</div>
      {unsure && <button type="button" className={"unsure" + (value === "unknown" ? " on" : "")} aria-pressed={value === "unknown"} onClick={() => onChange(value === "unknown" ? undefined : "unknown")}>{T.ui.dontKnow}</button>}
    </div>
  );
}

/** − n + for small counts (rooms, balconies…). */
export function Counter({ value, onChange, min = 0, max = 20, step = 1, unsure }: {
  value: Maybe<number>; onChange: (v: Maybe<number>) => void; min?: number; max?: number; step?: number; unsure?: boolean;
}) {
  const n = typeof value === "number" ? value : undefined;
  return (
    <div className="counter-wrap">
      <div className="counter">
        <button type="button" aria-label="−" onClick={() => onChange(Math.max(min, (n ?? min + step) - step))}>−</button>
        <output className={n === undefined ? "empty" : undefined}>{n ?? "?"}</output>
        <button type="button" aria-label="+" onClick={() => onChange(Math.min(max, (n ?? min - step) + step))}>+</button>
      </div>
      {unsure && <UnsureButtons value={value} onChange={onChange} later={false} />}
    </div>
  );
}

/** A number with a unit (m², ₪, year…), plus don't know / later. */
export function NumberAsk({ value, onChange, unit, placeholder, unsure = true, later = true, min, max }: {
  value: Maybe<number>; onChange: (v: Maybe<number>) => void; unit?: string; placeholder?: string; unsure?: boolean; later?: boolean; min?: number; max?: number;
}) {
  const [text, setText] = useState(typeof value === "number" ? String(value) : "");
  const invalid = text !== "" && (Number.isNaN(Number(text.replace(/,/g, ""))) || (min !== undefined && Number(text.replace(/,/g, "")) < min) || (max !== undefined && Number(text.replace(/,/g, "")) > max));
  return (
    <div className="num-ask">
      <div className="num-field">
        <input inputMode="decimal" dir="ltr" value={typeof value === "string" ? "" : text} placeholder={placeholder} aria-invalid={invalid}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value.replace(/,/g, ""));
            onChange(e.target.value.trim() === "" ? undefined : Number.isNaN(v) ? undefined : v);
          }} />
        {unit && <span className="unit">{unit}</span>}
      </div>
      {unsure && <UnsureButtons value={value} onChange={(v) => { if (typeof v !== "number") setText(""); onChange(v); }} later={later} />}
    </div>
  );
}

/** A short text answer. */
export function TextAsk({ value, onChange, placeholder, dir, autoComplete }: { value?: string; onChange: (v: string) => void; placeholder?: string; dir?: "ltr" | "rtl"; autoComplete?: string }) {
  return <input className="text-ask" value={value ?? ""} placeholder={placeholder} dir={dir} autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} />;
}

/** A card that groups related questions; opens and closes. */
export function Block({ title, icon, done, children, defaultOpen = true }: { title: ReactNode; icon?: ReactNode; done?: boolean; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={"block" + (open ? " open" : "")}>
      <button type="button" className="block-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon && <span className="block-icon" aria-hidden>{icon}</span>}
        <span className="block-title">{title}</span>
        {done && <span className="block-done" aria-hidden>✓</span>}
        <span className="block-caret" aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="block-body">{children}</div>}
    </section>
  );
}
