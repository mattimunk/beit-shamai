import { useEffect, useState } from "react";
import { adminApi, type QueueTaskDto, type TaskDto, type WorkbenchDto } from "../../data/adminApi";
import { captureBase, frameUrl, getCapture, type CaptureDto, type CaseStatus } from "../../data/apiClient";
import { LIMITATION_TEXT, type Limitation } from "../../ops/readiness";
import { shotOrder, useShotLabel } from "../CaptureTour";
import { useT } from "../context";
import { RequestsInbox, TAX_SITE } from "../RequestsInbox";
import { tabFor, TaskItem } from "./AdminApp";
import { ago, AskReason, Meter, Section, Status, useBusy, when } from "./bits";
import { taskTitle, useAT } from "./texts";

export type WbTab = "overview" | "tasks" | "documents" | "media" | "market" | "appraisal" | "comms" | "history";
const TABS: WbTab[] = ["overview", "tasks", "documents", "media", "market", "appraisal", "comms", "history"];
const STATUSES: CaseStatus[] = ["draft", "submitted", "working", "prelim_review", "prelim_sent", "full_requested", "full_in_progress", "full_done", "closed"];
const DAY = 86_400_000;
const REGISTRY: Record<string, Record<string, string>> = {
  he: { tabu: "טאבו", ila: "רמ״י", company: "חברה משכנת", amidar: "עמידר", other: "אחר" },
  en: { tabu: "Land Registry (Tabu)", ila: "Israel Land Authority", company: "Housing company", amidar: "Amidar", other: "Other" },
};

/** Task rows from the workbench, shaped like queue rows for TaskItem. */
const asQueue = (t: TaskDto): QueueTaskDto => ({
  ...t, ageDays: Math.floor((Date.now() - Date.parse(t.createdAt)) / DAY), overdue: !!t.dueAt && Date.parse(t.dueAt) < Date.now(), stale: false,
  effectivePriority: t.priority, blocked: t.data?.blocked, waitingOnUser: t.party === "user",
});

export function Workbench({ id, tab: tab0, me, onOpenUser, onOpenRequests }: { id: string; tab?: WbTab; me: string; onOpenUser: (id: string) => void; onOpenRequests?: () => void }) {
  const { A, lang } = useAT();
  const [w, setW] = useState<WbTab>(tab0 ?? "overview");
  const [d, setD] = useState<WorkbenchDto | null>(null);
  const [admins, setAdmins] = useState<string[]>([]);
  const { busy, error, run, setError } = useBusy();
  const load = () => adminApi.property(id).then(setD).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); adminApi.settings().then((s) => setAdmins(s.admins)).catch(() => {}); }, [id]);
  const act = (what: Parameters<typeof adminApi.propertyAction>[1], body: unknown) => run(async () => setD(await adminApi.propertyAction(id, what, body)));

  if (!d) return <main className="adm-main">{error ? <div className="card warnings">{error}</div> : <div className="card muted">{A.common.loading}</div>}</main>;
  const c = d.case;
  const open = d.tasks.filter((t) => t.status === "open");
  const count = (tab: WbTab) => open.filter((t) => tabFor(t.key) === tab || (tab === "tasks")).length;

  const primary = () => {
    switch (d.nextAction) {
      case "start_review": return act("status", { status: "working" });
      case "generate": return act("appraisal", { action: "generate" }).then(() => setW("appraisal"));
      case "upload_market": return setW("market");
      case "approve": case "send": case "send_quote": case "confirm_payment": case "assign_appraiser": case "deliver": case "full_work": return setW("appraisal");
      case "request_info": return setW("comms");
      case "close": return setW("overview");
      default: return undefined;
    }
  };

  return (
    <main className="adm-main wb">
      <header className="wb-head adm-card">
        <div className="wb-title">
          <div className="small muted"><bdi dir="ltr" className="mono">{c.appNo}</bdi> · <span className={`svc ${c.service}`}>{c.service === "full" ? A.props.full : A.props.free}</span></div>
          <h1><bdi>{c.address.trim() || "—"}</bdi></h1>
          <div className="wb-sub">
            <Status status={c.status} />
            {d.owner ? <button className="link-btn" onClick={() => onOpenUser(d.owner!.id)}>{d.owner.name ?? d.owner.email}</button> : <span className="muted small">{A.wb.noOwner}</span>}
            {d.owner?.phone && <a className="small" href={`tel:${d.owner.phone}`} dir="ltr">{d.owner.phone}</a>}
          </div>
        </div>
        <div className="wb-meters">
          <Meter value={d.readiness.completion} label={A.wb.completion} help={A.wb.completionHelp} />
          <Meter value={d.readiness.confidence} label={A.wb.confidence} help={`${A.level[d.readiness.level]} · ${A.wb.confidenceHelp}`} tone="level" />
        </div>
        <div className="wb-actions">
          {d.nextAction !== "none" && <button className="primary big" disabled={busy} onClick={primary}>{A.wb.action[d.nextAction]}</button>}
          <label className="mini-field">
            <span>{A.wb.assignee}</span>
            <select value={c.assignee ?? ""} onChange={(e) => act("assign", { assignee: e.target.value })}>
              <option value="">{A.wb.unassigned}</option>
              {[...new Set([me, ...admins, ...(c.assignee ? [c.assignee] : [])])].map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <StatusOverride current={c.status} onChange={(status, reason) => act("status", { status, reason })} />
        </div>
        {error && <div className="small warn-text">{error === "insufficient_evidence" ? A.wb.appraisal.insufficient : error}</div>}
      </header>

      <nav className="wb-tabs" role="tablist">
        {TABS.map((t) => {
          const n = t === "overview" || t === "history" ? 0 : t === "tasks" ? open.length : open.filter((x) => tabFor(x.key) === t).length;
          return <button key={t} role="tab" aria-selected={w === t} className={w === t ? "on" : ""} onClick={() => setW(t)}>{A.wb.tabs[t]}{n ? <span className="count">{n}</span> : null}</button>;
        })}
      </nav>
      {void count}

      {w === "overview" && <Overview d={d} />}
      {w === "tasks" && <TasksTab d={d} reload={load} />}
      {w === "documents" && <DocsTab d={d} reload={load} />}
      {w === "media" && <MediaTab d={d} />}
      {w === "market" && <MarketTab d={d} act={act} reload={load} onOpenRequests={onOpenRequests} />}
      {w === "appraisal" && <AppraisalTab d={d} act={act} busy={busy} />}
      {w === "comms" && <CommsTab d={d} act={act} reload={load} busy={busy} />}
      {w === "history" && <HistoryTab d={d} act={act} lang={lang} />}
    </main>
  );
}

function StatusOverride({ current, onChange }: { current: CaseStatus; onChange: (s: CaseStatus, reason: string) => void }) {
  const { A } = useAT();
  const { t } = useT();
  const [to, setTo] = useState<CaseStatus | null>(null);
  return (
    <div className="mini-field">
      <span>{A.wb.changeStatus}</span>
      <select value="" onChange={(e) => setTo(e.target.value as CaseStatus)}>
        <option value="">—</option>
        {STATUSES.filter((s) => s !== current).map((s) => <option key={s} value={s}>{t.pipeline.status[s]}</option>)}
      </select>
      {to && <AskReason label={A.wb.overrideReason} onCancel={() => setTo(null)} onSubmit={(r) => { onChange(to, r); setTo(null); }} />}
    </div>
  );
}

// ---- Overview ---------------------------------------------------------------------------------------

function Overview({ d }: { d: WorkbenchDto }) {
  const { A, lang } = useAT();
  const { f } = useT();
  const x = d.case.dossier;
  const v = (val: any) => (val === undefined || val === null || val === "" ? "—" : val === "unknown" ? "?" : val === "later" ? "…" : String(val));
  const facts: [string, string][] = x ? [
    [A.wb.market.fields.type, x.location?.type ? A.types[x.location.type] ?? x.location.type : "—"],
    [A.wb.market.fields.area, x.size?.interior !== undefined ? `${v(x.size.interior)} ${lang === "he" ? "מ״ר" : "sqm"}` : "—"],
    [lang === "he" ? "חדרים" : "Rooms", v(x.rooms?.rooms)],
    [lang === "he" ? "קומה" : "Floor", `${v(x.location?.floor)} / ${v(x.location?.floors)}`],
    [lang === "he" ? "שנת בנייה" : "Year built", v(x.building?.yearBuilt)],
    [lang === "he" ? "רישום" : "Registry", REGISTRY[lang][x.legal?.registry] ?? v(x.legal?.registry)],
    [lang === "he" ? "מטרה" : "Purpose", A.purposes[x.setup?.purpose] ?? v(x.setup?.purpose)],
    [lang === "he" ? "מחיר מבוקש" : "Asking price", typeof x.sale?.asking === "number" ? f.nis(x.sale.asking) : v(x.sale?.asking)],
    [A.wb.market.fields.block, x.location?.parcel ? `${x.location.parcel.block}/${x.location.parcel.parcel}${x.location.parcel.sub ? `/${x.location.parcel.sub}` : ""}` : "—"],
  ] : [];
  return (
    <div className="wb-grid">
      <Section title={A.wb.facts}>
        <dl className="facts">{facts.map(([k, val]) => <div key={k}><dt>{k}</dt><dd><bdi>{val}</bdi></dd></div>)}</dl>
        <p className="small muted">{lang === "he" ? "הפרטים נמסרו ע״י המגיש וטרם אומתו." : "Details as stated by the applicant, not yet verified."}</p>
      </Section>
      <Section title={A.wb.components}>
        <ul className="components">
          {d.readiness.components.map((c) => (
            <li key={c.key}>
              <span>{A.wb.comp[c.key] ?? c.key}</span>
              <div className="mini-bar"><i style={{ width: `${Math.round(c.score * 100)}%` }} /></div>
              <small className="muted">{c.weight}</small>
            </li>
          ))}
        </ul>
      </Section>
      <Section title={A.wb.limitations}>
        {d.readiness.limitations.length === 0 ? <p className="muted">—</p> : (
          <ul className="limits">{d.readiness.limitations.map((l) => <li key={l}>{LIMITATION_TEXT[lang][l as Limitation] ?? l}</li>)}</ul>
        )}
      </Section>
    </div>
  );
}

// ---- Tasks ------------------------------------------------------------------------------------------

function TasksTab({ d, reload }: { d: WorkbenchDto; reload: () => void }) {
  const { A, lang } = useAT();
  const open = d.tasks.filter((t) => t.status === "open").sort((a, b) => a.priority - b.priority);
  const closed = d.tasks.filter((t) => t.status !== "open").sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  return (
    <div className="wb-grid one">
      <Section title={A.wb.openTasks}>
        {open.length === 0 ? <p className="muted">{A.queue.empty}</p> : <ul className="tasks">{open.map((t) => <TaskItem key={t.id} t={asQueue(t)} onChanged={reload} compact />)}</ul>}
      </Section>
      <Section title={A.wb.closedTasks}>
        <ul className="closed-list">
          {closed.map((t) => (
            <li key={t.id}>
              <span className={t.status === "dismissed" ? "muted strike" : ""}>{taskTitle(A, t.key, t.data)}</span>
              <small className="muted"> · {A.wb.closedBy(t.doneBy === "system" ? A.party.system : t.doneBy === "user" ? A.party.user : t.doneBy ?? "", t.note ?? "")} · {when(t.doneAt, lang)}</small>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

// ---- Documents --------------------------------------------------------------------------------------

function DocsTab({ d, reload }: { d: WorkbenchDto; reload: () => void }) {
  const { A, lang } = useAT();
  const { t } = useT();
  const missing = d.tasks.filter((x) => x.status === "open" && x.key.startsWith("doc:"));
  const verify = d.tasks.find((x) => x.status === "open" && x.key === "verify_docs");
  const kinds = (t.docs as any).kind ?? {};
  return (
    <div className="wb-grid">
      <Section title={A.wb.docs} extra={verify && <button className="ghost" onClick={() => adminApi.task(verify.id, { action: "done" }).then(reload)}>{A.wb.markChecked}</button>}>
        {d.docs.length === 0 ? <p className="muted">{A.wb.noDocs}</p> : (
          <ul className="doc-list">
            {d.docs.map((doc) => (
              <li key={doc.id}>
                <span className="doc-kind">{kinds[doc.kind] ?? doc.kind}</span>
                <a href={`/api/cases/${encodeURIComponent(d.case.id)}/documents/${doc.id}/file`} target="_blank" rel="noreferrer"><bdi>{doc.fileName}</bdi></a>
                <small className="muted">{when(doc.addedAt, lang)}</small>
                <span className={doc.verified ? "ok-text small" : "small muted"}>{doc.verified ? `✓ ${A.wb.verified}` : A.wb.unverified}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={A.wb.missingDocs}>
        {missing.length === 0 ? <p className="muted">—</p> : <ul className="tasks">{missing.map((x) => <TaskItem key={x.id} t={asQueue(x)} onChanged={reload} compact />)}</ul>}
      </Section>
    </div>
  );
}

// ---- Rooms & media ----------------------------------------------------------------------------------

function MediaTab({ d }: { d: WorkbenchDto }) {
  const { A } = useAT();
  const [caps, setCaps] = useState<CaptureDto[] | null>(null);
  const base = captureBase({ caseId: d.case.id });
  const label = useShotLabel(d.case.dossier?.rooms?.custom ?? []);
  useEffect(() => { getCapture(base).then((r) => setCaps(r.captures)).catch(() => setCaps([])); }, [d.case.id]);
  return (
    <div className="wb-grid one">
      <Section title={A.wb.media} extra={<span className="small muted">{A.wb.mediaProgress(d.shots.done, d.shots.total)}</span>}>
        <p className="small muted">{A.wb.aiSoon}</p>
        {caps && caps.length === 0 && <p className="muted">{A.wb.noMedia}</p>}
        <div className="shot-grid">
          {[...(caps ?? [])].sort((a, b) => shotOrder(a.shotId) - shotOrder(b.shotId)).map((c) => (
            <figure key={c.shotId}>
              <div className="shot-frames">{c.frames.slice(0, 3).map((fr) => <a key={fr} href={frameUrl(base, fr)} target="_blank" rel="noreferrer"><img src={frameUrl(base, fr)} alt={label(c.shotId)} loading="lazy" /></a>)}</div>
              <figcaption>{label(c.shotId)} <small className="muted">· {c.media === "video" ? "🎥" : "📷"}</small></figcaption>
            </figure>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ---- Market data ------------------------------------------------------------------------------------

function MarketTab({ d, act, reload, onOpenRequests }: { d: WorkbenchDto; act: (w: any, b: unknown) => Promise<unknown>; reload: () => void; onOpenRequests?: () => void }) {
  const { A, lang } = useAT();
  const { f } = useT();
  const M = A.wb.market;
  const m = d.market;
  const [ask, setAsk] = useState(false);
  const x = d.case.dossier;
  const s = d.case.subject;
  const taxOpen = d.tasks.find((t) => t.status === "open" && t.key === "tax_data");
  const items = d.request?.items ?? [];
  const period = items.length ? `${f.dnum(items.map((i) => i.from).sort()[0]!)} – ${f.dnum(items.map((i) => i.to).sort().pop()!)}` : "—";
  const fields: [string, string][] = [
    [M.fields.address, [s.address.street, s.address.number].filter(Boolean).join(" ") || "—"], [M.fields.city, s.address.city || "—"],
    [M.fields.neighbourhood, x?.location?.neighbourhood ?? s.address.neighborhood ?? "—"],
    [M.fields.block, x?.location?.parcel?.block ?? s.parcel?.block ?? "—"], [M.fields.parcel, x?.location?.parcel?.parcel ?? s.parcel?.parcel ?? "—"],
    [M.fields.sub, x?.location?.parcel?.sub ?? s.parcel?.subParcel ?? "—"], [M.fields.type, x?.location?.type ? A.types[x.location.type] ?? x.location.type : "—"],
    [M.fields.area, typeof x?.size?.interior === "number" ? `${x.size.interior}` : "—"], [M.fields.period, period],
  ];
  return (
    <div className="wb-grid">
      <Section title={M.city} extra={m.city && <span className={`fresh f-${m.city.freshness}`}>{A.fresh[m.city.freshness]}</span>}>
        {m.city ? (
          <dl className="facts">
            <div><dt>{M.lastChecked}</dt><dd>{m.city.lastChecked ? `${f.dnum(m.city.lastChecked)} · ${M.by[m.city.checkedBy ?? ""] ?? ""}` : "—"}</dd></div>
            <div><dt>{M.latestDeal}</dt><dd>{m.city.latestDeal ? f.dnum(m.city.latestDeal) : "—"}</dd></div>
            <div><dt>{M.deals12m}</dt><dd>{m.city.deals12m}</dd></div>
            <div><dt>{M.nearby(700, 24)}</dt><dd><b>{m.nearby}</b> · {M.level}: {A.conf[m.level] ?? m.level}</dd></div>
          </dl>
        ) : <p className="muted">—</p>}
        {m.nearby > 0 && <p className="small ok-text">{M.reused(m.nearby)}</p>}
        {(m.level === "none" || m.level === "insufficient") && <p className="small warn-text">{M.insufficient}</p>}
      </Section>
      <Section title={M.searchInfo} extra={<a className="button ghost" href={TAX_SITE} target="_blank" rel="noreferrer">{M.openSite} ↗</a>}>
        <dl className="facts">{fields.map(([k, v]) => <div key={k}><dt>{k}</dt><dd><bdi>{v}</bdi></dd></div>)}</dl>
        {taxOpen && (
          <div className="row-buttons">
            {!ask && <button className="ghost" onClick={() => setAsk(true)}>{M.noResults}</button>}
            {ask && <AskReason label={M.noResultsReason} onCancel={() => setAsk(false)} onSubmit={(reason) => { setAsk(false); act("market", { reason }); }} />}
            {onOpenRequests && <button className="ghost" onClick={onOpenRequests}>{lang === "he" ? "כל בקשות הנתונים" : "All data requests"}</button>}
          </div>
        )}
      </Section>
      {d.request && (
        <section className="wb-span">
          <RequestsInbox session onlyRequest={d.request.id} onUploaded={() => act("sync", {}).then(reload)} />
        </section>
      )}
    </div>
  );
}

// ---- Appraisal (preliminary + full) -------------------------------------------------------------------

function AppraisalTab({ d, act, busy }: { d: WorkbenchDto; act: (w: any, b: unknown) => Promise<unknown>; busy: boolean }) {
  const { A, lang } = useAT();
  const { f } = useT();
  const P = A.wb.appraisal;
  const gen = d.tasks.find((t) => t.status === "open" && t.key === "prelim_generate");
  const blocked = gen?.data?.blocked;
  const current = d.appraisals.filter((a) => a.status !== "superseded");
  const old = d.appraisals.filter((a) => a.status === "superseded");
  return (
    <div className="wb-grid one">
      <Section title={lang === "he" ? "הערכה ראשונית" : "Preliminary estimate"} extra={
        <button className={current.length ? "ghost" : "primary"} disabled={busy || blocked === "market" || blocked === "address" || !["working", "prelim_review", "prelim_sent", "submitted"].includes(d.case.status)}
          onClick={() => act("appraisal", { action: "generate" })}>{current.length ? P.regenerate : P.generate}</button>
      }>
        {blocked && <p className="small warn-text">{blocked === "market" ? P.blockedMarket : A.blocked[blocked]}</p>}
        {current.length === 0 && <p className="muted">{P.none}</p>}
        {current.map((a) => (
          <article key={a.id} className={`appraisal st-${a.status}`}>
            <div className="ap-head">
              <span className="badge">{P.status[a.status]}</span>
              <small className="muted">{when(a.createdAt, lang)}{a.approvedBy ? ` · ✓ ${a.approvedBy}` : ""}{a.sentAt ? ` · ✉ ${when(a.sentAt, lang)}` : ""}</small>
            </div>
            <div className="ap-range"><span>{P.range}</span><b><bdi>{f.nis(a.low)} – {f.nis(a.high)}</bdi></b><small className="muted">{P.point}: {f.nis(a.point)}</small></div>
            <div className="ap-meta small">
              <span>{P.compConf}: <b>{A.conf[a.confidence] ?? a.confidence}</b></span><span>{P.readiness}: <b>{a.readiness}%</b></span><span>{P.comparables}: <b>{a.comparables}</b></span>
            </div>
            {a.limitations.length > 0 && <ul className="limits small">{a.limitations.filter((l) => !l.startsWith("warning:")).map((l) => <li key={l}>{LIMITATION_TEXT[lang][l as Limitation] ?? l}</li>)}</ul>}
            <p className="small muted">{P.disclaimer}</p>
            <details>
              <summary className="small">{P.evidence} ({a.evidence.length})</summary>
              <table className="adm-table small">
                <thead><tr><th>{P.cols.address}</th><th>{P.cols.date}</th><th>{P.cols.price}</th><th>{P.cols.area}</th><th>{P.cols.distance}</th></tr></thead>
                <tbody>{a.evidence.map((e, i) => <tr key={i}><td><bdi>{e.address}</bdi></td><td>{f.dnum(e.date)}</td><td>{f.nis(e.price)}</td><td>{e.area}</td><td>{f.dist(e.distanceM)}</td></tr>)}</tbody>
              </table>
            </details>
            <div className="row-buttons">
              {a.status === "draft" && <button className="primary" disabled={busy} onClick={() => act("appraisal", { action: "approve", id: a.id })}>{P.approve}</button>}
              {a.status === "approved" && <button className="primary" disabled={busy} onClick={() => act("appraisal", { action: "send", id: a.id })}>{P.send}</button>}
              {(a.status === "draft" || a.status === "approved") && <button className="ghost" disabled={busy} onClick={() => act("appraisal", { action: "reject", id: a.id })}>{P.reject}</button>}
            </div>
          </article>
        ))}
        {old.length > 0 && <details><summary className="small muted">{P.status.superseded} ({old.length})</summary>{old.map((a) => <div key={a.id} className="small muted">{when(a.createdAt, lang)} · {f.nis(a.low)} – {f.nis(a.high)}{a.note ? ` · ${a.note}` : ""}</div>)}</details>}
      </Section>
      <FullPanel d={d} act={act} busy={busy} />
    </div>
  );
}

function FullPanel({ d, act, busy }: { d: WorkbenchDto; act: (w: any, b: unknown) => Promise<unknown>; busy: boolean }) {
  const { A } = useAT();
  const F = A.wb.full;
  const fr = d.full;
  const [purpose, setPurpose] = useState("sale");
  const [quote, setQuote] = useState(fr?.quote ? String(fr.quote) : "");
  const [appraiser, setAppraiser] = useState(fr?.appraiser ?? "");
  const [item, setItem] = useState("");
  useEffect(() => { setQuote(fr?.quote ? String(fr.quote) : ""); setAppraiser(fr?.appraiser ?? ""); }, [fr?.id, fr?.quote, fr?.appraiser]);
  if (!fr) {
    return (
      <Section title={F.title}>
        <p className="muted">{F.none}</p>
        <div className="row-buttons">
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label={F.purpose}>{Object.entries(A.purposes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <button className="ghost" disabled={busy} onClick={() => act("full", { open: { purpose } })}>{F.open}</button>
        </div>
      </Section>
    );
  }
  const patch = (p: unknown) => act("full", { id: fr.id, patch: p });
  const next: Record<string, string[]> = { requested: ["quoted", "accepted"], quoted: ["accepted"], accepted: ["in_progress"], in_progress: ["signed"], signed: ["delivered"], delivered: [], cancelled: [] };
  const steps = ["requested", "quoted", "accepted", "in_progress", "signed", "delivered"];
  return (
    <Section title={F.title} extra={<span className="badge">{A.fullStatus[fr.status]}</span>}>
      <ol className="steps-line">{steps.map((s) => <li key={s} className={steps.indexOf(s) <= steps.indexOf(fr.status) ? "on" : ""}>{A.fullStatus[s]}</li>)}</ol>
      <div className="full-grid">
        <label className="mini-field"><span>{F.purpose}</span>
          <select value={fr.purpose} onChange={(e) => patch({ purpose: e.target.value })}>{Object.entries(A.purposes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
        <label className="mini-field"><span>{F.quote}</span>
          <span className="inline-save"><input inputMode="numeric" value={quote} onChange={(e) => setQuote(e.target.value.replace(/\D/g, ""))} dir="ltr" /><button className="ghost" disabled={busy || !quote} onClick={() => patch({ quote: Number(quote) })}>{F.save}</button></span>
        </label>
        <label className="mini-field"><span>{F.payment}</span>
          <select value={fr.payment} onChange={(e) => patch({ payment: e.target.value })}>{Object.entries(A.payments).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
        <label className="mini-field"><span>{F.appraiser}</span>
          <span className="inline-save"><input type="email" value={appraiser} onChange={(e) => setAppraiser(e.target.value)} dir="ltr" /><button className="ghost" disabled={busy} onClick={() => patch({ appraiser })}>{F.save}</button></span>
        </label>
      </div>
      <p className="small muted">{F.paymentAdapter}</p>
      {fr.purposeNote && <p className="small">“{fr.purposeNote}”</p>}
      <h4>{F.checklist}</h4>
      <ul className="checklist">
        {fr.checklist.map((i) => (
          <li key={i.key}>
            <label><input type="checkbox" checked={i.done} disabled={busy} onChange={(e) => patch({ item: { key: i.key, done: e.target.checked } })} /> {A.check[i.key] ?? i.key}</label>
            {i.done && i.by && <small className="muted"> · {i.by}</small>}
          </li>
        ))}
      </ul>
      <form className="row-buttons" onSubmit={(e) => { e.preventDefault(); if (item.trim()) { patch({ addItem: item.trim() }); setItem(""); } }}>
        <input value={item} onChange={(e) => setItem(e.target.value)} placeholder={F.addItem} aria-label={F.addItem} /><button className="ghost" disabled={!item.trim()}>＋</button>
      </form>
      <div className="row-buttons">
        {next[fr.status]?.map((s) => <button key={s} className="primary" disabled={busy} onClick={() => patch({ status: s })}>{F.to[s]}</button>)}
        {fr.status !== "delivered" && fr.status !== "cancelled" && <button className="ghost" disabled={busy} onClick={() => patch({ status: "cancelled" })}>{F.to.cancelled}</button>}
      </div>
    </Section>
  );
}

// ---- Communications -----------------------------------------------------------------------------------

function CommsTab({ d, act, reload, busy }: { d: WorkbenchDto; act: (w: any, b: unknown) => Promise<unknown>; reload: () => void; busy: boolean }) {
  const { A, lang } = useAT();
  const C = A.wb.comms;
  const userTasks = d.tasks.filter((t) => t.status === "open" && t.party === "user");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [step, setStep] = useState("legal");
  return (
    <div className="wb-grid">
      <Section title={C.reminders} extra={d.owner?.remindersOptOut ? <span className="small warn-text">{C.optOut}</span> : undefined}>
        {userTasks.length === 0 ? <p className="muted">—</p> : (
          <ul className="tasks">{userTasks.map((t) => (
            <TaskItem key={t.id} t={asQueue(t)} onChanged={reload} compact />
          ))}</ul>
        )}
        {userTasks.some((t) => t.nextReminderAt) && (
          <ul className="small muted">{userTasks.filter((t) => t.nextReminderAt).map((t) => <li key={t.id}>{taskTitle(A, t.key, t.data)} – {A.queue.nextReminder}: {when(t.nextReminderAt, lang)}</li>)}</ul>
        )}
      </Section>
      <Section title={C.compose}>
        {!d.owner ? <p className="muted">{A.wb.noOwner}</p> : (
          <form className="compose" onSubmit={(e) => { e.preventDefault(); act("message", { kind: "clarify", subject, text, step }).then(() => { setSubject(""); setText(""); }); }}>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={C.subject} aria-label={C.subject} />
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={C.text} aria-label={C.text} />
            <label className="mini-field"><span>{C.step}</span>
              <select value={step} onChange={(e) => setStep(e.target.value)}>{["location", "property", "legal", "occupancy", "tour", "review"].map((s) => <option key={s} value={s}>{A.steps[s]}</option>)}</select>
            </label>
            <button className="primary" disabled={busy || !subject.trim() || !text.trim()}>{C.send}</button>
          </form>
        )}
      </Section>
      <section className="adm-card wb-span">
        <header className="adm-card-head"><h3>{C.messages}</h3></header>
        <MessageList messages={d.messages} onChanged={reload} />
      </section>
    </div>
  );
}

export function MessageList({ messages, onChanged }: { messages: WorkbenchDto["messages"]; onChanged: () => void }) {
  const { A, lang } = useAT();
  if (!messages.length) return <p className="muted">{A.wb.comms.none}</p>;
  return (
    <ul className="msg-list">
      {messages.map((m) => (
        <li key={m.id}>
          <details>
            <summary>
              <span className={`msg-st ms-${m.status}`}>{A.msgStatus[m.status] ?? m.status}</span>
              <b>{A.msgKind[m.kind] ?? m.kind}</b>
              <span className="muted small">{m.subject ? ` · ${m.subject}` : ""} · {m.to} · {when(m.sentAt ?? m.createdAt, lang)}{m.createdBy ? ` · ${m.createdBy}` : ""}</span>
            </summary>
            {m.body && <pre className="msg-body">{m.body}</pre>}
            {m.lastError && <div className="small warn-text">{m.lastError} · {A.wb.comms.attempts(m.attempts)}</div>}
            {m.taskKeys.length > 0 && <div className="small muted">{m.taskKeys.map((k) => taskTitle(A, k)).join(" · ")}</div>}
          </details>
          {(m.status === "failed" || m.status === "not_sent") && <button className="ghost" onClick={() => adminApi.retryMessage(m.id).then(onChanged)}>{A.wb.comms.retry}</button>}
        </li>
      ))}
    </ul>
  );
}

// ---- History + notes -----------------------------------------------------------------------------------

function HistoryTab({ d, act, lang }: { d: WorkbenchDto; act: (w: any, b: unknown) => Promise<unknown>; lang: string }) {
  const { A } = useAT();
  const [note, setNote] = useState("");
  return (
    <div className="wb-grid">
      <Section title={A.wb.notes}>
        <p className="small muted">🔒 {A.wb.notesHelp}</p>
        <form className="compose" onSubmit={(e) => { e.preventDefault(); act("notes", { text: note }).then(() => setNote("")); }}>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-label={A.wb.addNote} />
          <button className="ghost" disabled={!note.trim()}>{A.wb.addNote}</button>
        </form>
        <ul className="notes">{d.notes.map((n) => <li key={n.id}><p>{n.text}</p><small className="muted">{n.author} · {when(n.at, lang)}</small></li>)}</ul>
      </Section>
      <Section title={A.wb.history}>
        <EventList events={d.events} />
      </Section>
    </div>
  );
}

export function EventList({ events }: { events: WorkbenchDto["events"] }) {
  const { A, lang } = useAT();
  const detail = (e: WorkbenchDto["events"][number]) => {
    const x = e.data ?? {};
    if (e.kind.startsWith("task_") && x.key) return `${taskTitle(A, x.key)}${x.reason ? ` – ${x.reason}` : ""}${x.step ? ` (${x.step})` : ""}`;
    if (e.kind === "applicant_activity") return A.what[x.what] ?? x.what;
    if (e.kind === "status_override" || e.kind === "review_started") return x.reason ?? "";
    if (e.kind.startsWith("message_") || e.kind === "reminder_sent") return x.kind ? A.msgKind[x.kind] ?? x.kind : (x.keys ?? []).map((k: string) => taskTitle(A, k)).join(", ");
    if (e.kind === "market_no_results") return x.reason ?? "";
    return "";
  };
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id}>
          <span className="tl-when">{when(e.at, lang)}</span>
          <span className="tl-what"><b>{A.ev[e.kind] ?? e.kind}</b>{detail(e) ? <> · {detail(e)}</> : null}</span>
          <span className="tl-who muted">{e.actor === "system" ? A.party.system : e.actor === "user" ? A.party.user : e.actor}</span>
        </li>
      ))}
    </ol>
  );
}

export { ago };
