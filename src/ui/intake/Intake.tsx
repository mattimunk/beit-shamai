import { useEffect, useMemo, useRef, useState } from "react";
import type { Subject } from "../../engine/types";
import {
  captureBase, getCapture, getCaseFile, listCaseDocuments, newFilmLink, requestSignInCode, saveDossier, saveProfile, saveVisitLayout,
  setShotSkipped, submitCase, verifySignIn, type CaptureDto, type CaseDocDto, type CaseStatus, type MeDto, type UserRole,
} from "../../data/apiClient";
import {
  emptyDossier, overallProgress, sectionProgress, SECTIONS, toSubject, tourLayout, upgradeDossier, type Dossier, type SectionId, type Submitter,
} from "../../dossier/schema";
import { CaptureTour, shotIds } from "../CaptureTour";
import { useT } from "../context";
import { newSubject } from "../newSubject";
import { PhoneField } from "../PhoneField";
import { qrSvg } from "../qr";
import { LegalSection, LocationSection, OccupancySection, PropertySection, ReviewSection, SectionHead, SetupSection, type Up } from "./Sections";
import { useIT } from "./texts";
import { Result } from "./Result";

type Stage = "welcome" | "contact" | SectionId;

const ROLE_OF: Record<Submitter, UserRole> = {
  owner: "seller", buyer: "buyer", agent: "agent", attorney: "attorney", mortgage_broker: "mortgage_broker", family: "seller", other: "other",
};

const DRAFT_KEY = "bs-intake-draft";
const loadDraft = (): Dossier | null => { try { const v = localStorage.getItem(DRAFT_KEY); return v ? upgradeDossier(JSON.parse(v)) : null; } catch { return null; } };
const saveDraft = (d: Dossier | null) => { try { d ? localStorage.setItem(DRAFT_KEY, JSON.stringify(d)) : localStorage.removeItem(DRAFT_KEY); } catch { /* memory only */ } };

/** A file made before the intake existed: start its dossier from what the file already has. */
function dossierFromSubject(s: Subject): Dossier {
  const d = emptyDossier();
  d.location.city = s.address.city || undefined;
  d.location.street = s.address.street || undefined;
  d.location.number = s.address.number || undefined;
  if (s.address.city) d.location.pin = { lat: s.location.lat, lng: s.location.lng };
  return d;
}

/**
 * The conversational intake: welcome → purpose → contact (signed-out only) → location →
 * property → legal → use → tour → summary. Saves as it goes; reopening resumes where it stopped.
 */
export function Intake({ me, caseId, fresh, startAt, onSignedIn, onSaved, onStatus, onSignInInstead }: {
  me: MeDto | null;
  caseId: string;
  /** A new property: start at the welcome screen. */
  fresh: boolean;
  /** Open at this step (a link from an email); "result" shows the outcome on the summary. */
  startAt?: string;
  onSignedIn: (m: MeDto) => void;
  /** After the first save and when the address changes, so lists refresh. */
  onSaved: () => void;
  onStatus: (s: CaseStatus) => void;
  onSignInInstead?: () => void;
}) {
  const { T } = useIT();
  const [d, setD] = useState<Dossier>(() => (fresh && !me ? loadDraft() : null) ?? emptyDossier());
  const [base, setBase] = useState<Subject>(newSubject);
  const [loaded, setLoaded] = useState(fresh);
  const [stage, setStage] = useState<Stage>(fresh ? "welcome" : "setup");
  const [appNo, setAppNo] = useState<string | undefined>();
  const [status, setStatus] = useState<CaseStatus>("draft");
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [docs, setDocs] = useState<CaseDocDto[]>([]);
  const [captures, setCaptures] = useState<CaptureDto[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);
  const savedOnce = useRef(false);

  const up: Up = (fn) => setD((cur) => { const next = structuredClone(cur); fn(next); return next; });

  // Open an existing file where it was left.
  useEffect(() => {
    if (fresh || !me) { setLoaded(true); return; }
    let stop = false;
    getCaseFile(caseId).then((c) => {
      if (stop) return;
      if (c) {
        setBase(c.subject);
        const dd = c.dossier ? upgradeDossier(c.dossier as Dossier) : dossierFromSubject(c.subject);
        setD(dd);
        setAppNo(c.appNo);
        setStatus((c.status ?? "draft") as CaseStatus);
        const want = startAt === "result" ? "review" : startAt;
        setStage(want && SECTIONS.includes(want as SectionId) ? (want as SectionId) : dd.at && SECTIONS.includes(dd.at) ? dd.at : "setup");
        savedOnce.current = true;
      } else setStage("welcome");
      setLoaded(true);
    }).catch(() => setLoaded(true));
    return () => { stop = true; };
  }, [caseId]);

  const refreshDocs = () => { if (me) listCaseDocuments(caseId).then(setDocs).catch(() => {}); };
  useEffect(() => { refreshDocs(); getCapture(captureBase({ caseId })).then((r) => setCaptures(r.captures)).catch(() => {}); }, [caseId, !!me]);

  const inWizard = stage !== "welcome" && stage !== "contact";
  // Autosave: the dossier and the matching subject, shortly after each change.
  useEffect(() => {
    if (!loaded) return;
    if (!me) { if (stage !== "welcome") saveDraft({ ...d, at: inWizard ? (stage as SectionId) : d.at }); return; }
    if (!inWizard) return;
    setSaving("saving");
    const h = setTimeout(() => {
      saveDossier(caseId, toSubject(d, base), { ...d, at: stage })
        .then((r) => {
          if (r.appNo) setAppNo(r.appNo);
          setSaving("saved");
          if (!savedOnce.current) { savedOnce.current = true; saveDraft(null); onSaved(); }
        })
        .catch(() => setSaving("idle"));
    }, 700);
    return () => clearTimeout(h);
  }, [d, stage, me, loaded]);

  // Tell the server the tour's rooms, so the phone link shows the same list.
  const layout = useMemo(() => tourLayout(d), [d]);
  useEffect(() => { if (me && savedOnce.current && stage === "tour") saveVisitLayout(captureBase({ caseId }), layout).catch(() => {}); }, [stage, JSON.stringify(layout)]);

  const ids = shotIds(layout);
  const shots = { done: captures.filter((c) => ids.includes(c.shotId)).length, total: ids.length };
  const pct = overallProgress(d, shots);

  const go = (s: Stage) => { setStage(s); requestAnimationFrame(() => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const idx = inWizard ? SECTIONS.indexOf(stage as SectionId) : -1;
  const next = () => {
    if (stage === "setup" && !me) return go("contact");
    if (idx >= 0 && idx < SECTIONS.length - 1) go(SECTIONS[idx + 1]!);
  };
  const back = () => {
    if (stage === "contact") return go("setup");
    if (stage === "setup") return fresh ? go("welcome") : undefined;
    if (idx > 0) go(SECTIONS[idx - 1]!);
  };
  const canNext = stage !== "setup" || (!!d.setup.purpose && !!d.setup.submitter);

  const submit = async () => {
    setSubmitting(true);
    try {
      await saveDossier(caseId, toSubject(d, base), { ...d, at: "review" });
      const r = await submitCase(caseId);
      setStatus(r.case.status);
      onStatus(r.case.status);
    } finally { setSubmitting(false); }
  };

  if (!loaded) return <main className="intake"><div className="card muted">…</div></main>;
  if (stage === "welcome") return <Welcome onStart={() => go("setup")} onSignIn={me ? undefined : onSignInInstead} />;

  const props = { d, up, caseId, docs, refreshDocs };
  return (
    <main className="intake" ref={topRef}>
      {inWizard && <Stepper d={d} stage={stage as SectionId} shots={shots} pct={pct} onGo={(s) => go(s)} appNo={appNo} saving={saving} locked={!me} />}
      <div className="intake-body">
        {stage === "setup" && <SetupSection {...props} />}
        {stage === "contact" && <ContactStep submitter={d.setup.submitter} onDone={(m) => { onSignedIn(m); go("location"); }} />}
        {stage === "location" && <LocationSection {...props} />}
        {stage === "property" && <PropertySection {...props} />}
        {stage === "legal" && <LegalSection {...props} />}
        {stage === "occupancy" && <OccupancySection {...props} />}
        {stage === "tour" && <TourSection d={d} up={up} caseId={caseId} onCaptures={setCaptures} />}
        {stage === "review" && me && savedOnce.current && <Result caseId={caseId} status={status} onStatus={(st) => { setStatus(st); onStatus(st); }} />}
        {stage === "review" && (
          <ReviewSection {...props} shots={shots} onEdit={(s) => go(s)} onSubmit={submit} submitted={status !== "draft"} submitting={submitting} />
        )}
      </div>
      {stage !== "contact" && stage !== "review" && (
        <nav className="intake-nav">
          <button type="button" className="ghost" onClick={back} disabled={stage === "setup" && !fresh}>{T.ui.back}</button>
          <button type="button" className="primary big" onClick={next} disabled={!canNext}>{T.ui.next}</button>
        </nav>
      )}
      {stage === "contact" && <nav className="intake-nav"><button type="button" className="ghost" onClick={back}>{T.ui.back}</button><span /></nav>}
    </main>
  );
}

// ---- Welcome --------------------------------------------------------------------------------------

function Welcome({ onStart, onSignIn }: { onStart: () => void; onSignIn?: () => void }) {
  const { T } = useIT();
  const W = T.welcome;
  return (
    <main className="intake welcome">
      <div className="welcome-card">
        <HouseArt />
        <h1>{W.title}</h1>
        <p className="lead">{W.sub}</p>
        <ul className="welcome-points">{W.points.map((p) => <li key={p}>{p}</li>)}</ul>
        <button type="button" className="primary big" onClick={onStart}>{W.start}</button>
        {onSignIn && <button type="button" className="link" onClick={onSignIn}>{W.haveAccount}</button>}
      </div>
    </main>
  );
}

/** An original line drawing: a small building with a camera viewfinder around it. */
function HouseArt() {
  return (
    <svg className="house-art" viewBox="0 0 240 150" aria-hidden>
      <rect x="0" y="0" width="240" height="150" rx="22" fill="var(--accent-soft, #eef3ff)" />
      <g fill="none" stroke="var(--accent, #2f5bea)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M70 120 V62 L120 34 L170 62 V120 Z" fill="#fff" />
        <path d="M58 68 L120 30 L182 68" />
        <rect x="108" y="88" width="24" height="32" rx="3" />
        <rect x="82" y="72" width="18" height="16" rx="2" />
        <rect x="140" y="72" width="18" height="16" rx="2" />
        <path d="M40 40 V28 H52 M188 28 H200 V40 M200 112 V124 H188 M52 124 H40 V112" opacity="0.6" />
      </g>
      <circle cx="196" cy="44" r="5" fill="#e3473d" />
    </svg>
  );
}

// ---- Progress -------------------------------------------------------------------------------------

function Stepper({ d, stage, shots, pct, onGo, appNo, saving, locked }: {
  d: Dossier; stage: SectionId; shots: { done: number; total: number }; pct: number;
  onGo: (s: SectionId) => void; appNo?: string; saving: "idle" | "saving" | "saved"; locked: boolean;
}) {
  const { T } = useIT();
  const i = SECTIONS.indexOf(stage);
  return (
    <div className="ix-progress">
      <div className="ix-progress-top">
        <span className="small muted">{T.ui.step(i + 1, SECTIONS.length)} · {T.sections[stage]}</span>
        <span className="small muted">
          {appNo && <>{T.ui.appNo} <bdi dir="ltr">{appNo}</bdi> · </>}
          {saving === "saving" ? T.ui.saving : saving === "saved" ? `✓ ${T.ui.saved}` : ""}
        </span>
      </div>
      <div className="bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
      <ol className="steps">
        {SECTIONS.map((s, k) => {
          const p = s === "tour" ? shots : s === "review" ? { done: 0, total: 0 } : sectionProgress(d, s);
          const full = p.total > 0 && p.done >= p.total;
          return (
            <li key={s}>
              <button type="button" className={"step" + (s === stage ? " now" : "") + (full ? " full" : "")} disabled={locked && k > 0}
                aria-current={s === stage ? "step" : undefined} onClick={() => onGo(s)}>
                <span className="dot">{full ? "✓" : k + 1}</span>
                <span className="lbl">{T.sections[s]}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---- Contact (signed-out) -------------------------------------------------------------------------

function ContactStep({ submitter, onDone }: { submitter?: Submitter; onDone: (m: MeDto) => void }) {
  const { T, lang } = useIT();
  const { t } = useT();
  const C = T.contact;
  const A = t.account;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"form" | "code">("form");
  const [emailed, setEmailed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const err = (e: unknown) => setError((A.errors as Record<string, string>)[(e as Error).message] ?? (e as Error).message);

  const send = async () => {
    setBusy(true); setError(null);
    try { const r = await requestSignInCode(email.trim(), lang); setEmailed(r.emailed); setStep("code"); } catch (e) { err(e); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try {
      const r = await verifySignIn(email.trim(), code.trim(), lang);
      const patch: Record<string, unknown> = {};
      if (name.trim() && !r.user.name) patch.name = name.trim();
      if (phone && !r.user.phone) patch.phone = phone;
      if (!r.user.role && submitter) patch.role = ROLE_OF[submitter];
      onDone(Object.keys(patch).length ? await saveProfile(patch) : r);
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  return (
    <>
      <SectionHead title={C.title} sub={C.sub} icon="✉️" />
      {step === "form" ? (
        <form className="contact-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <label className="field"><span>{C.name}</span><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></label>
          <label className="field"><span>{C.email}</span><input type="email" inputMode="email" dir="ltr" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <PhoneField label={C.phone} value={phone} onChange={setPhone} />
          <button className="primary big" disabled={busy || !email.includes("@") || !name.trim()}>{C.send}</button>
        </form>
      ) : (
        <form className="contact-form" onSubmit={(e) => { e.preventDefault(); verify(); }}>
          <p className="small">{emailed ? C.sentTo(email) : A.codeLogged}</p>
          <label className="field">
            <span>{C.code}</span>
            <input className="otp" inputMode="numeric" autoComplete="one-time-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
          </label>
          <button className="primary big" disabled={busy || code.trim().length < 6}>{C.verify}</button>
          <button type="button" className="link" onClick={() => { setStep("form"); setCode(""); }}>{C.change}</button>
        </form>
      )}
      {error && <div className="card warnings small">{error}</div>}
    </>
  );
}

// ---- Tour -----------------------------------------------------------------------------------------

const LINK_KEY = (caseId: string) => `bs-film-${caseId}`;

function useWide() {
  const q = "(min-width: 900px) and (pointer: fine)";
  const [wide, setWide] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return wide;
}

function TourSection({ d, up, caseId, onCaptures }: { d: Dossier; up: Up; caseId: string; onCaptures: (c: CaptureDto[]) => void }) {
  const { T, f } = useIT();
  const R = T.tour;
  const wide = useWide();
  const base = captureBase({ caseId });
  const [link, setLink] = useState<{ token: string; expiresAt: number; path: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // One link per file at a time; reuse it while valid so a phone already open keeps working.
  const makeLink = (force = false) => {
    if (!force) {
      try {
        const v = JSON.parse(sessionStorage.getItem(LINK_KEY(caseId)) ?? "null");
        if (v && v.expiresAt > Date.now() + 60 * 60_000) { setLink(v); return; }
      } catch { /* none */ }
    }
    newFilmLink(caseId).then((l) => { setLink(l); try { sessionStorage.setItem(LINK_KEY(caseId), JSON.stringify(l)); } catch { /* memory only */ } }).catch(() => {});
  };
  useEffect(() => { if (wide) makeLink(); }, [wide, caseId]);

  const url = link ? `${location.origin}${link.path}` : "";
  const svg = useMemo(() => (url ? qrSvg(url, 200) : ""), [url]);
  const expires = link ? new Date(link.expiresAt) : null;

  return (
    <>
      <SectionHead title={R.title} sub={R.sub} icon="🎥" />
      {wide && link && (
        <div className="qr-card">
          <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="qr-text">
            <b>{R.phoneTitle}</b>
            <p className="small">{R.phoneSub}</p>
            {expires && <p className="small muted">{R.expires(`${f.date(expires.toISOString())} ${expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`)}</p>}
            <div className="row-buttons">
              <a className="button ghost" href={`https://wa.me/?text=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">{R.sendLink}</a>
              <button type="button" className="ghost" onClick={() => { navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? R.copied : R.copy}</button>
              <button type="button" className="ghost" onClick={() => makeLink(true)}>{R.newLink}</button>
            </div>
          </div>
        </div>
      )}
      {wide && <p className="small muted film-here">{R.filmHere}</p>}
      <CaptureTour
        base={base}
        layoutFixed={tourLayout(d)}
        skipped={d.tourSkipped}
        onSkip={(id, skip) => {
          up((x) => { x.tourSkipped = skip ? [...new Set([...x.tourSkipped, id])] : x.tourSkipped.filter((s) => s !== id); });
          setShotSkipped(base, id, skip).catch(() => {});
        }}
        onChange={onCaptures}
        poll={wide}
        compact
      />
    </>
  );
}
