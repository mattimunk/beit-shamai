import { useEffect, useMemo, useState } from "react";
import { valuate, type ValuationResult } from "../engine/valuation";
import type { Subject } from "../engine/types";
import { detectServer, valuateRemote } from "../data/apiClient";
import { DemoProvider, DEMO_VALUATION_DATE } from "../data/demo/demoProvider";
import { DEMO_SUBJECT } from "../data/demo/demoSubject";
import { STRINGS, type Lang } from "../i18n/strings";
import { LangContext, type Role } from "./context";
import { PropertyForm } from "./Form";
import { MapView } from "./MapView";
import { Card, CompsTable, Disclaimer, AreaTable, BlendPanel, ListingsPanel, MarketPanel, RenewalPanel, TransportPanel, ValueCard, Warnings } from "./Panels";
import { Report } from "./Report";

type Tab = "valuation" | "report";

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
  const t = STRINGS[lang];

  useEffect(() => {
    detectServer().then((ok) => {
      setServerAvailable(ok);
      setLive(ok);
    });
  }, []);

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
        const r = live ? await valuateRemote(subject) : await valuate(subject, provider, DEMO_VALUATION_DATE);
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
  }, [subject, provider, live]);

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
            {(["valuation", "report"] as Tab[]).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
                {t.tabs[k]}
              </button>
            ))}
          </nav>
          <div className="controls">
            <div className="segmented" role="radiogroup" aria-label="role">
              {(["buyer", "realtor"] as Role[]).map((k) => (
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

        {tab === "valuation" ? (
          <main className="layout">
            <aside className="inputs no-print">
              <h2>{t.inputs}</h2>
              <PropertyForm subject={subject} onChange={setSubject} live={live} />
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
          <main className="report-wrap">{result && <Report r={result} subject={subject} role={role} />}</main>
        )}
      </div>
    </LangContext.Provider>
  );
}
