import { useEffect, useMemo, useState } from "react";
import { valuate, type ValuationResult } from "../engine/valuation";
import type { Subject } from "../engine/types";
import { createDataRequest, detectServer, getDataRequest, requestProgress, valuateRemote, type RequestDto } from "../data/apiClient";
import { RequestsInbox } from "./RequestsInbox";
import { CaptureTour, shotOrder } from "./CaptureTour";
import { frameUrl, getCapture, getCaseFile, rememberCase, saveCaseFile, type CaptureDto } from "../data/apiClient";
import { SignIn, Profile } from "./Account";
import { AdminPipeline, MyProperties, PropertyStrip } from "./Properties";
import { getMe, signOut, submitCase, type CaseStatus, type MeDto } from "../data/apiClient";
import { VisitShare } from "./VisitShare";

/** A new property file starts with neutral details – nothing from the demo flat that could
 * end up in a real report (no extras, no unpermitted balcony, no block/parcel). */
function newSubject(): Subject {
  return {
    ...DEMO_SUBJECT,
    address: { city: "", street: "", number: "" },
    location: { lat: 32.0853, lng: 34.7818 },
    parcel: undefined,
    addOns: [],
    condition: "original",
    directions: [],
  };
}
import { DemoProvider, DEMO_VALUATION_DATE } from "../data/demo/demoProvider";
import { DEMO_SUBJECT } from "../data/demo/demoSubject";
import { STRINGS, type Lang } from "../i18n/strings";
import { LangContext, type Role } from "./context";
import { PropertyForm } from "./Form";
import { MapView } from "./MapView";
import { Card, CompsTable, Disclaimer, AreaTable, BlendPanel, ListingsPanel, MarketPanel, RenewalPanel, TransportPanel, ValueCard, Warnings } from "./Panels";
import { ShumaReport, type ReportMeta, type ReportPhoto, type ReportStage } from "./ShumaReport";
import { DocumentsPanel } from "./DocumentsPanel";
import { applyRegistry, documentFacts, type DocumentRecord } from "../data/documents";

type Tab = "mine" | "valuation" | "report" | "visit" | "admin" | "requests";

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

const addressLine = (s: Subject) => [s.address.street, s.address.number].filter(Boolean).join(" ") + (s.address.city ? `, ${s.address.city}` : "");

export function App() {
  const provider = useMemo(() => new DemoProvider(), []);
  const [lang, setLang] = useState<Lang>("he");
  const [role, setRoleState] = useState<Role>(() => {
    try { const v = localStorage.getItem("bs-role"); return v === "realtor" || v === "appraiser" ? v : "buyer"; } catch { return "buyer"; }
  });
  const setRole = (r: Role) => { setRoleState(r); try { localStorage.setItem("bs-role", r); } catch { /* memory only */ } };
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
  // The case (documents, adverts, visit films) survives a reload of this tab, and an opened
  // order brings back its own case.
  const [caseId, setCaseIdState] = useState<string>(() => {
    try { const v = sessionStorage.getItem("bs-case"); if (v) return v; } catch { /* no storage */ }
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(/\./g, "");
  });
  const setCaseId = (id: string) => { setCaseIdState(id); try { sessionStorage.setItem("bs-case", id); } catch { /* memory only */ } };
  useEffect(() => { try { sessionStorage.setItem("bs-case", caseId); } catch { /* memory only */ } }, []);
  const [captures, setCaptures] = useState<CaptureDto[]>([]);
  const [filesKey, setFilesKey] = useState(0);
  // Signed-in user (live mode). undefined = not checked yet; null = signed out.
  const [me, setMe] = useState<MeDto | null | undefined>(undefined);
  const [editProfile, setEditProfile] = useState(false);
  const [caseStatus, setCaseStatus] = useState<CaseStatus>("draft");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    getMe().then((m) => { setMe(m); if (m) setTab((t0) => (t0 === "valuation" && !sessionStorage.getItem("bs-case-open") ? "mine" : t0)); }).catch(() => setMe(null));
  }, [live]);
  // What a signed-in user sees of the report follows their role; admins can switch.
  const userTier: Role | null = me && !me.isAdmin ? (me.user.role === "agent" ? "realtor" : me.user.role === "appraiser" ? "appraiser" : "buyer") : null;
  useEffect(() => { if (userTier && role !== userTier) setRoleState(userTier); }, [userTier]);
  const [savedAddress, setSavedAddress] = useState<string | null>(null);

  // Live mode: load this tab's property file from the server, if it has one.
  useEffect(() => {
    if (!live) return;
    getCaseFile(caseId).then((c) => { if (c) { setSubject(c.subject); setSavedAddress(addressLine(c.subject)); setCaseStatus(((c as any).status ?? "draft") as CaseStatus); } }).catch(() => {});
  }, [live, caseId]);

  // Save the property's details to its file as they are edited (once it has an address).
  useEffect(() => {
    // Not before it has an address, and never the demo flat.
    if (!live || !subject.address.street.trim() || subject.address.city === DEMO_SUBJECT.address.city) return;
    const h = setTimeout(() => {
      saveCaseFile(caseId, subject).then(() => {
        rememberCase(caseId);
        const a = addressLine(subject);
        if (a !== savedAddress) { setSavedAddress(a); setFilesKey((k) => k + 1); }
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(h);
  }, [live, caseId, subject]);

  const openCase = async (id: string) => {
    const c = await getCaseFile(id).catch(() => null);
    setCaseId(id);
    if (c) setSubject(c.subject);
    setCaseStatus(((c as any)?.status ?? "draft") as CaseStatus);
    try { sessionStorage.setItem("bs-case-open", "1"); } catch { /* memory only */ }
    setSavedAddress(c ? addressLine(c.subject) : null);
    setDocs([]);
    setRequest(null);
    saveReqId(null);
    rememberCase(id);
    setTab("valuation");
  };
  const submit = async () => {
    setSubmitting(true);
    try {
      await saveCaseFile(caseId, subject);
      const r = await submitCase(caseId);
      setCaseStatus(r.case.status);
      if (r.request) { setRequest(r.request); saveReqId(r.request.id); }
      setNotice(t.pipeline.submitted);
      setFilesKey((k) => k + 1);
    } catch (e) { setError((e as Error).message); }
    finally { setSubmitting(false); }
  };
  const newCase = () => {
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(/\./g, "");
    setCaseId(id);
    setSubject(newSubject());
    setCaseStatus("draft");
    try { sessionStorage.setItem("bs-case-open", "1"); } catch { /* memory only */ }
    setSavedAddress(null);
    setDocs([]);
    setCaptures([]);
    setRequest(null);
    saveReqId(null);
    setTab("valuation");
  };
  // The filming link must open an existing file, so opening the visit tab saves it.
  useEffect(() => {
    if (live && tab === "visit") saveCaseFile(caseId, subject).then(() => { rememberCase(caseId); setFilesKey((k) => k + 1); }).catch(() => {});
  }, [live, tab, caseId]);
  useEffect(() => {
    if (!live) return;
    getCapture(caseId).then((r) => setCaptures(r.captures)).catch(() => setCaptures([]));
  }, [live, caseId]);
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
    try { const r = await createDataRequest(effective, caseId); saveReqId(r.id); setRequest(r); }
    catch (e) { setError((e as Error).message); }
    finally { setOrdering(false); }
  };
  // Report annex: frames from the visit films (in shot order) and attached photos.
  const photos: ReportPhoto[] = [
    ...[...captures].sort((a, b) => shotOrder(a.shotId) - shotOrder(b.shotId)).flatMap((c) => c.frames.map((f) => ({ src: frameUrl(caseId, f), shotId: c.shotId, date: c.at.slice(0, 10) }))),
    ...docs.filter((d) => d.kind === "photos" && d.url && /^image\//.test(d.mime)).map((d) => ({ src: d.url!, label: d.fileName })),
  ];
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
            {(live
              ? me
                ? ["mine", "valuation", "report", "visit", ...(me.isAdmin ? ["admin", "requests"] : [])]
                : []
              : ["valuation", "report"]
            ).map((k) => k as Tab).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                {t.tabs[k]}
              </button>
            ))}
          </nav>
          <div className="controls">
            {live && me && (
              <div className="user-chip">
                <button className="ghost" onClick={() => setEditProfile(true)} title={me.user.email}>
                  {me.user.name || me.user.email}{me.user.role ? ` · ${t.account.roles[me.user.role]}` : ""}{me.isAdmin ? " · admin" : ""}
                </button>
                <button className="ghost" onClick={async () => { await signOut(); setMe(null); setTab("valuation"); }}>{t.account.signOut}</button>
              </div>
            )}
            {(!live || me?.isAdmin) && <div className="segmented" role="radiogroup" aria-label="role">
              {(["buyer", "realtor", "appraiser"] as Role[]).map((k) => (
                <button key={k} role="radio" aria-checked={role === k} className={role === k ? "active" : ""} onClick={() => setRole(k)}>
                  {t.role[k]}
                </button>
              ))}
            </div>}
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
        {live && me && ["valuation", "report", "visit"].includes(tab) && (
          <PropertyStrip address={addressLine(effective)} status={caseStatus} onBack={() => setTab("mine")} onSubmit={submit} submitting={submitting} />
        )}
        {notice && <div className="notice no-print" onClick={() => setNotice(null)}>{notice}</div>}

        {live && me === undefined ? (
          <main className="account"><div className="card muted">{t.loading}</div></main>
        ) : live && me === null ? (
          <SignIn onSignedIn={(m, isNew) => { setMe(m); setEditProfile(isNew || !m.user.role); setTab("mine"); }} />
        ) : live && me && (editProfile || !me.user.role) ? (
          <Profile me={me} onSaved={(m) => { setMe(m); setEditProfile(false); }} onCancel={me.user.role ? () => setEditProfile(false) : undefined} />
        ) : tab === "mine" && live ? (
          <MyProperties onOpen={openCase} onNew={newCase} refreshKey={filesKey} />
        ) : tab === "admin" && live && me?.isAdmin ? (
          <AdminPipeline onOpen={openCase} />
        ) : tab === "visit" && live ? (
          <div className="visit-wrap">
            <VisitShare caseId={caseId} address={addressLine(effective)} />
            <CaptureTour key={caseId} caseId={caseId} subject={effective} onChange={setCaptures} />
          </div>
        ) : tab === "requests" && live ? (
          <RequestsInbox
            session={!!me?.isAdmin}
            onOpen={(r) => {
              if (r.caseId) { setCaseId(r.caseId); rememberCase(r.caseId); }
              setSubject(r.subject);
              setRequest(r);
              saveReqId(r.id);
              setTab("report");
            }}
          />
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
            {result && <ShumaReport r={result} subject={effective} tier={role} meta={metaShown} docs={docs} facts={facts} stage={stage} photos={photos} />}
          </main>
        )}
      </div>
    </LangContext.Provider>
  );
}
