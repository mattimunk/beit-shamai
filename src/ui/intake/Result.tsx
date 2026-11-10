import { useEffect, useState } from "react";
import { acceptQuote, myAppraisal, requestFullAppraisal, type MyAppraisalDto } from "../../data/adminApi";
import type { CaseStatus } from "../../data/apiClient";
import { LIMITATION_TEXT, type Limitation } from "../../ops/readiness";
import { useT } from "../context";

const TX = {
  he: {
    prelim: "הערכת השווי הראשונית", range: "טווח שווי משוער", conf: { high: "גבוהה", medium: "בינונית", low: "נמוכה", insufficient: "לא מספיקה" } as Record<string, string>,
    confLabel: "רמת ביטחון", limits: "מה עוד חסר כדי לדייק", disclaimer: "זוהי הערכה ראשונית. היא אינה כוללת בהכרח ביקור בנכס ואינה מחליפה שומה של שמאי מקרקעין מוסמך.",
    wantFull: "צריכים שומה רשמית?", wantFullSub: "שמאי מקרקעין מוסמך יכין שומה חתומה. כל הפרטים והמסמכים שכבר מסרתם עוברים אוטומטית.",
    purpose: "למה דרושה השומה?", request: "הזמנת שומה מלאה", note: "הערה (לא חובה)",
    requested: "קיבלנו את הבקשה לשומה מלאה. נחזור אליכם עם הצעת מחיר.", quoted: (q: string) => `הצעת המחיר לשומה המלאה: ${q}`, accept: "אישור ההצעה",
    status: { requested: "התקבלה – נחזור עם הצעה", quoted: "נשלחה הצעת מחיר", accepted: "אושרה – בעבודה", in_progress: "בעבודה", signed: "נחתמה", delivered: "נמסרה" } as Record<string, string>,
    full: "שומה מלאה", waiting: "הנכס בטיפול. נעדכן אתכם בדוא״ל כשההערכה הראשונית תהיה מוכנה.",
  },
  en: {
    prelim: "Your preliminary valuation", range: "Estimated value range", conf: { high: "high", medium: "medium", low: "low", insufficient: "insufficient" } as Record<string, string>,
    confLabel: "Confidence", limits: "What would make it more accurate", disclaimer: "This is a preliminary estimate. It does not necessarily involve a site visit and is not a substitute for a valuation by a licensed appraiser.",
    wantFull: "Need a formal appraisal?", wantFullSub: "A licensed appraiser will prepare a signed report. Everything you've provided carries over automatically.",
    purpose: "What is it for?", request: "Order a full appraisal", note: "Note (optional)",
    requested: "We received your full-appraisal request and will get back to you with a quote.", quoted: (q: string) => `Quote for the full appraisal: ${q}`, accept: "Accept the quote",
    status: { requested: "Received – a quote is on its way", quoted: "Quote sent", accepted: "Accepted – in progress", in_progress: "In progress", signed: "Signed", delivered: "Delivered" } as Record<string, string>,
    full: "Full appraisal", waiting: "Your property is being handled. We'll email you when the preliminary valuation is ready.",
  },
};
const PURPOSES = { he: { bank: "בנק / משכנתא", sale: "מכירה", purchase: "רכישה", tax: "מיסוי", litigation: "הליך משפטי", inheritance: "ירושה / חלוקה", other: "אחר" }, en: { bank: "Bank / mortgage", sale: "Sale", purchase: "Purchase", tax: "Taxation", litigation: "Litigation", inheritance: "Inheritance / division", other: "Other" } };

/** On the summary step: the approved preliminary valuation (if sent) and the full-appraisal offer. */
export function Result({ caseId, status, onStatus }: { caseId: string; status: CaseStatus; onStatus: (s: CaseStatus) => void }) {
  const { lang, f } = useT();
  const X = TX[lang];
  const [r, setR] = useState<MyAppraisalDto | null>(null);
  const [purpose, setPurpose] = useState("sale");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => myAppraisal(caseId).then(setR).catch(() => setR({ preliminary: null, full: null }));
  useEffect(() => { load(); }, [caseId, status]);
  if (!r) return null;
  const p = r.preliminary;
  const order = async () => {
    setBusy(true); setErr(null);
    try { await requestFullAppraisal(caseId, purpose, note || undefined); onStatus("full_requested"); await load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="result">
      {p && (
        <section className="result-card">
          <h2>{X.prelim}</h2>
          <div className="result-range"><small>{X.range}</small><b><bdi>{f.nis(p.low)} – {f.nis(p.high)}</bdi></b></div>
          <p className="small">{X.confLabel}: <b>{X.conf[p.confidence] ?? p.confidence}</b></p>
          {p.limitations.filter((l) => !l.startsWith("warning:")).length > 0 && (
            <>
              <h3>{X.limits}</h3>
              <ul className="limits small">{p.limitations.filter((l) => !l.startsWith("warning:")).map((l) => <li key={l}>{LIMITATION_TEXT[lang][l as Limitation] ?? l}</li>)}</ul>
            </>
          )}
          <p className="small muted">{X.disclaimer}</p>
        </section>
      )}
      {!p && status !== "draft" && !r.full && <div className="notice">{X.waiting}</div>}
      {r.full ? (
        <section className="result-card">
          <h3>{X.full}: {X.status[r.full.status] ?? r.full.status}</h3>
          {r.full.status === "quoted" && r.full.quote && (
            <>
              <p>{X.quoted(f.nis(r.full.quote))}</p>
              <button className="primary big" disabled={busy} onClick={async () => { setBusy(true); try { await acceptQuote(caseId); await load(); } finally { setBusy(false); } }}>{X.accept}</button>
            </>
          )}
          {r.full.status === "requested" && <p className="small">{X.requested}</p>}
        </section>
      ) : (
        <section className="result-card soft">
          <h3>{X.wantFull}</h3>
          <p className="small">{X.wantFullSub}</p>
          <label className="field"><span>{X.purpose}</span>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>{Object.entries(PURPOSES[lang]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
          <label className="field"><span>{X.note}</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <button className="ghost big-ghost" disabled={busy} onClick={order}>{X.request}</button>
          {err && <div className="small warn-text">{err}</div>}
        </section>
      )}
    </div>
  );
}
