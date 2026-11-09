import { useEffect, useState } from "react";
import { captureBase, filmLinkInfo, setShotSkipped, type VisitLayout } from "../data/apiClient";
import { STRINGS, type Lang } from "../i18n/strings";
import { LangContext } from "./context";
import { CaptureTour } from "./CaptureTour";
import { INTAKE_TEXT } from "./intake/texts";

/**
 * What a filming link opens (/?film=<token>): only the room-by-room tour for that property,
 * phone first. The token is temporary and revocable; it gives access to filming only.
 */
export function FilmApp({ token }: { token: string }) {
  const [lang, setLang] = useState<Lang>("he");
  const t = STRINGS[lang];
  const R = INTAKE_TEXT[lang].tour;
  const [info, setInfo] = useState<{ appNo?: string; address: string; layout: VisitLayout | null; skipped: string[] } | null | undefined>(undefined);
  const base = captureBase({ token });

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
    document.title = `${R.filmFor} – ${t.appName}`;
  }, [lang]);
  useEffect(() => { filmLinkInfo(token).then(setInfo).catch(() => setInfo(null)); }, [token]);

  const onSkip = (id: string, skip: boolean) => {
    setInfo((i) => (i ? { ...i, skipped: skip ? [...new Set([...i.skipped, id])] : i.skipped.filter((s) => s !== id) } : i));
    setShotSkipped(base, id, skip).catch(() => {});
  };

  return (
    <LangContext.Provider value={lang}>
      <div className="app visit-app">
        <header className="visit-top">
          <span className="logo" aria-hidden>ב״ש</span>
          <div className="visit-addr">
            <div className="small muted">{R.filmFor}{info?.appNo ? <> · <bdi dir="ltr">{info.appNo}</bdi></> : null}</div>
            {info?.address ? <b><bdi>{info.address}</bdi></b> : info === undefined ? <b>…</b> : null}
          </div>
          <button className="ghost" onClick={() => setLang(lang === "he" ? "en" : "he")}>{t.lang}</button>
        </header>
        {info === undefined && <main className="visit"><div className="card muted">{t.loading}</div></main>}
        {info === null && <main className="visit"><div className="card warnings">{R.linkExpired}</div></main>}
        {info && (
          <>
            <section className="film-intro">
              <h1>{R.title}</h1>
              <p>{R.sub}</p>
            </section>
            <CaptureTour base={base} layoutFixed={info.layout} skipped={info.skipped} onSkip={onSkip} compact />
            <p className="small muted visit-foot">{R.thanks}</p>
          </>
        )}
      </div>
    </LangContext.Provider>
  );
}
