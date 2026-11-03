import { useEffect, useMemo, useState } from "react";
import { valuate, type ValuationResult } from "../engine/valuation";
import type { Subject } from "../engine/types";
import { createDataRequest, detectServer, getDataRequest, requestProgress, valuateRemote, type RequestDto } from "../data/apiClient";
import { RequestsInbox } from "./RequestsInbox";
import { DemoProvider, DEMO_VALUATION_DATE } from "../data/demo/demoProvider";
import { DEMO_SUBJECT } from "../data/demo/demoSubject";
import { STRINGS, type Lang } from "../i18n/strings";
import { LangContext, type Role } from "./context";
import { PropertyForm } from "./Form";
import { MapView } from "./MapView";
import { Card, CompsTable, Disclaimer, AreaTable, BlendPanel, ListingsPanel, MarketPanel, RenewalPanel, TransportPanel, ValueCard, Warnings } from "./Panels";
import { ShumaReport, type ReportMeta, type ReportStage } from "./ShumaReport";
import { DocumentsPanel } from "./DocumentsPanel";
import { applyRegistry, documentFacts, type DocumentRecord } from "../data/documents";

type Tab = "valuation" | "report" | "requests";

/** The open data request for this browser tab's report, kept across reloads where storage works. */
const REQ_KEY = "bs-request";
const loadReqId = () => { try { return sessionStorage.getItem(REQ_KEY); } catch { return null; } };
const saveReqId = (id: string | null) => { try { id ? sessionStorage.setItem(REQ_KEY, id) : sessionStorage.removeItem(REQ_KEY); } catch { /* memory only */ } };

// Printing is blocked inside sandboxed frames (e.g. hosted previews); hide the button there.
const canPrint = (() => {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
})();

export function App() {
  const provider = useMemo(() => new DemoProvider(), []);
  const [lang, setLang] = useState<Lang>("he");
  const [role, setRole] = useState<Role>("buyer");
  const [tab, setTab] = useState<Tab>("valuation");
  const [subject, setSubject] = useState<Subject>(DEMO_SUBJECT);
  const [result, setResult] = useState<ValuationResult | null>(null);
  const [serverAvailable, setServerAvailable] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [request, setRequest] = useState<RequestDto | null>(null);
  const [ordering, setOrdering] = useState(false);
  const caseId = useMemo(() => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(/\./g, "")), []);
  const t = STRINGS[lang];
  const [meta, setMeta] = useState<ReportMeta>(() => ({
    client: "",
    purpose: "",
    fileNo: `BS-${new Date().getFullYear()}-${caseId.slice(0, 6).toUpperCase()}`,
    visitDate: "",
    inspector: "",
    visitMethod: "",
    appraiserName: "",
    licence: "",
  }));
  const facts = useMemo(() => documentFacts(docs), [docs]);
  const effective = useMemo(() => applyRegistry(subject, docs), [subject, docs]);
  const metaShown: ReportMeta = {
    ...meta,
    client: meta.client || t.metaDefaults.client,
    purpose: meta.purpose || t.metaDefaults.purpose,
    visitMethod: meta.visitDate ? meta.visitMethod || t.metaDefaults.visitMethod : "",
  };

  useEffect(() => {
    detectServer().then((ok) => {
      setServerAvailable(ok);
      setLive(ok);
    });
  }, []);

  // Follow the data request until it is final (the inbox fills it in, usually within a day).
  useEffect(() => {
    if (!live) return;
    const id = request?.id ?? loadReqId();
    if (!id || request?.status === "final") return;
    let stop = false;
    const poll = () => getDataRequest(id).then((r) => { if (!stop) setRequest(r); }).catch(() => { if (!request) saveReqId(null); });
    poll();
    const h = setInterval(poll, 60_000);
    return () => { stop = true; clearInterval(h); };
  }, [live, request?.id, request?.status]);

  const orderFinal = async () => {
    setOrdering(true);
    try { const r = await createDataRequest(effective); saveReqId(r.id); setRequest(r); }
    catch (e) { setError((e as Error).message); }
    finally { setOrdering(false); }
  };
  const stage: ReportStage | undefined = live
    ? request
      ? { status: request.status, ...requestProgress(request), finalAt: request.finalAt }
      : { status: "preliminary", done: 0, total: 0 }
    : undefined;

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
    document.title = `${t.appName} – ${t.tagline}`;
  }, [lang, t]);

  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(async () => {
      setBusy(true);
      try {
        const vf = { rentMonthly: facts.rentMonthly, contractSales: facts.contractSales };
        const r = live ? await valuateRemote(effective, vf, undefined, caseId) : await valuate(effective, provider, DEMO_VALUATION_DATE, vf);
        if (!cancelled) {
          setResult(r);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setResult(null);
          setError((e as Error).message);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, live ? 500 : 150);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [effective, facts, provider, live]);

  return (
    <LangContext.Provider value={lang}>
      <div className="app">
        <header className="topbar no-print">
          <div className="brand">
            <span className="logo" aria-hidden>ב״ש</span>
            <div>
              <div className="name">{t.appName}</div>
              <div className="tagline">{t.tagline}</div>
            </div>
          </div>
          <nav className="tabs" role="tablist">
            {(["valuation", "report", ...(live && role !== "buyer" ? ["requests"] : [])] as Tab[]).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                {t.tabs[k]}
              </button>
            ))}
          </nav>
          <div className="controls">
            <div className="segmented" role="radiogroup" aria-label="role">
              {(["buyer", "realtor", "appraiser"] as Role[]).map((k) => (
                <button key={k} role="radio" aria-checked={role === k} className={role === k ? "active" : ""} onClick={() => setRole(k)}>
                  {t.role[k]}
                </button>
              ))}
            </div>
            {serverAvailable && (
              <div className="segmented" role="radiogroup" aria-label="data">
                <button role="radio" aria-checked={!live} className={!live ? "active" : ""} onClick={() => { setLive(false); setSubject(DEMO_SUBJECT); }}>{t.modeDemo}</button>
                <button role="radio" aria-checked={live} className={live ? "active" : ""} onClick={() => setLive(true)}>{t.modeLive}</button>
              </div>
            )}
            <button className="ghost" onClick={() => setLang(lang === "he" ? "en" : "he")}>{t.lang}</button>
            {tab === "report" && canPrint && <button className="primary" onClick={() => window.print()}>{t.print}</button>}
          </div>
        </header>

        {!live && <div className="demo-banner no-print">{t.demoBanner}</div>}

        {tab === "requests" && live ? (
          <RequestsInbox />
        ) : tab === "valuation" ? (
          <main className="layout">
            <aside className="inputs no-print">
              <h2>{t.inputs}</h2>
              <PropertyForm subject={effective} onChange={setSubject} live={live} />
              <DocumentsPanel docs={docs} onChange={setDocs} live={live} caseId={caseId} city={effective.address.city} />
            </aside>
            <div className="results">
              {busy && !result && <div className="card muted">{t.loading}</div>}
              {error && <div className="card warnings">{t.liveError} {error}</div>}
              {result && live && result.comparables.used.length === 0 && <div className="card warnings">{t.liveEmpty}</div>}
              {result && (
                <>
                  <div className="top-row">
                    <ValueCard r={result} role={role} />
                    <Card title={t.map} className="map-card">
                      <MapView r={result} center={subject.location} stops={result.transport.stopsNearby} listings={result.market.activeListings} />
                    </Card>
                  </div>
                  <Warnings r={result} />
                  <CompsTable r={result} />
                  <ListingsPanel r={result} />
                  <div className="two-col">
                    <BlendPanel r={result} />
                    <MarketPanel r={result} />
                  </div>
                  <AreaTable r={result} />
                  <div className="two-col">
                    <TransportPanel r={result} />
                    <RenewalPanel r={result} />
                  </div>
                  <Disclaimer role={role} />
                </>
              )}
            </div>
          </main>
        ) : (
          <main className="report-wrap">
            <aside className="meta-editor no-print">
              <h3>{t.meta.title}</h3>
              {(["client", "purpose", "fileNo", "visitDate", "inspector", "visitMethod", ...(role === "appraiser" ? ["appraiserName", "licence"] : [])] as (keyof ReportMeta)[]).map((k) => (
                <label key={k} className="field">
                  <span>{t.meta[k]}</span>
                  <input
                    type={k === "visitDate" ? "date" : "text"}
                    value={meta[k]}
                    placeholder={k === "client" ? t.metaDefaults.client : k === "purpose" ? t.metaDefaults.purpose : k === "visitMethod" ? t.metaDefaults.visitMethod : ""}
                    onChange={(e) => setMeta({ ...meta, [k]: e.target.value })}
                  />
                </label>
              ))}
              {live && request?.status !== "final" && (
                <div className="order-final">
                  {request ? (
                    <span className="badge preliminary">{t.req.preliminary} · {t.req.progress(requestProgress(request).done, requestProgress(request).total)}</span>
                  ) : (
                    <button className="primary" onClick={orderFinal} disabled={ordering}>{t.req.order}</button>
                  )}
                  <span className="muted small">{t.req.orderHelp}</span>
                </div>
              )}
            </aside>
            {result && <ShumaReport r={result} subject={effective} tier={role} meta={metaShown} docs={docs} facts={facts} stage={stage} />}
          </main>
        )}
      </div>
    </LangContext.Provider>
  );
}
