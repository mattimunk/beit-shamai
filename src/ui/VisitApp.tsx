import { useEffect, useState } from "react";
import type { Subject } from "../engine/types";
import { getCaseFile } from "../data/apiClient";
import { STRINGS, type Lang } from "../i18n/strings";
import { LangContext } from "./context";
import { CaptureTour } from "./CaptureTour";

/**
 * What a filming link opens (/?visit=<file id>): only the guided tour for that property,
 * phone first – no tabs, roles or settings. Films go into the property's file.
 */
export function VisitApp({ caseId }: { caseId: string }) {
  const [lang, setLang] = useState<Lang>("he");
  const t = STRINGS[lang];
  const [subject, setSubject] = useState<Subject | null | undefined>(undefined);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
    document.title = `${t.visit.forProperty} – ${t.appName}`;
  }, [lang, t]);
  useEffect(() => { getCaseFile(caseId).then((c) => setSubject(c?.subject ?? null)).catch(() => setSubject(null)); }, [caseId]);

  const address = subject ? [subject.address.street, subject.address.number].filter(Boolean).join(" ") + (subject.address.city ? `, ${subject.address.city}` : "") : "";
  return (
    <LangContext.Provider value={lang}>
      <div className="app visit-app">
        <header className="visit-top">
          <span className="logo" aria-hidden>ב״ש</span>
          <div className="visit-addr">
            <div className="small muted">{t.visit.forProperty}</div>
            <b><bdi>{address || t.visit.noAddress}</bdi></b>
          </div>
          <button className="ghost" onClick={() => setLang(lang === "he" ? "en" : "he")}>{t.lang}</button>
        </header>
        {subject === undefined && <main className="visit"><div className="card muted">{t.loading}</div></main>}
        {subject === null && <main className="visit"><div className="card warnings">{t.visit.notFound}</div></main>}
        {subject && (
          <>
            <CaptureTour caseId={caseId} subject={subject} />
            <p className="small muted visit-foot">{t.visit.savedNote}</p>
          </>
        )}
      </div>
    </LangContext.Provider>
  );
}
