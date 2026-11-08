import { useEffect, useMemo, useState } from "react";
import { adminCases, myCases, setCaseStatusAdmin, type CaseStatus, type PipelineCase } from "../data/apiClient";
import { useT } from "./context";

const STATUSES: CaseStatus[] = ["draft", "submitted", "data", "documents", "review", "done"];

function ago(iso: string | undefined, lang: string): string {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (m < 60) return rtf.format(-m, "minute");
  if (m < 48 * 60) return rtf.format(-Math.round(m / 60), "hour");
  return rtf.format(-Math.round(m / 1440), "day");
}

export function StatusBadge({ status }: { status: CaseStatus }) {
  const { t } = useT();
  return <span className={`badge st-${status}`}>{t.pipeline.status[status]}</span>;
}

/** "My properties": the signed-in user's property files. */
export function MyProperties({ onOpen, onNew, refreshKey }: { onOpen: (id: string) => void; onNew: () => void; refreshKey: number }) {
  const { t, lang } = useT();
  const P = t.pipeline;
  const [list, setList] = useState<PipelineCase[] | null>(null);
  useEffect(() => { myCases().then(setList).catch(() => setList([])); }, [refreshKey]);
  return (
    <main className="props">
      <div className="props-head">
        <h2>{P.mine}</h2>
        <button className="primary" onClick={onNew}>＋ {t.files.new}</button>
      </div>
      {list === null && <div className="card muted">{t.loading}</div>}
      {list?.length === 0 && <div className="card"><p>{P.empty}</p><button className="primary" onClick={onNew}>＋ {t.files.new}</button></div>}
      <div className="prop-cards">
        {list?.map((c) => (
          <button key={c.id} className="card prop-card" onClick={() => onOpen(c.id)}>
            <div className="prop-top"><b><bdi>{c.address.trim() || t.files.untitled}</bdi></b><StatusBadge status={c.status} /></div>
            <div className="small muted">
              {c.shots ? `${t.files.shots(c.shots)} · ` : ""}{P.updated} {ago(c.updatedAt, lang)}
            </div>
            {c.status === "draft" && <div className="small next-step">{P.nextDraft}</div>}
          </button>
        ))}
      </div>
    </main>
  );
}

/** Admin: every property file, by status. */
export function AdminPipeline({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, lang } = useT();
  const P = t.pipeline;
  const [list, setList] = useState<PipelineCase[] | null>(null);
  const [filter, setFilter] = useState<CaseStatus | "active">("active");
  const [error, setError] = useState<string | null>(null);
  const load = () => adminCases().then(setList).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); }, []);
  const counts = useMemo(() => Object.fromEntries(STATUSES.map((s) => [s, (list ?? []).filter((c) => c.status === s).length])), [list]);
  const shown = (list ?? []).filter((c) => (filter === "active" ? c.status !== "draft" && c.status !== "done" : c.status === filter));
  const change = async (c: PipelineCase, status: CaseStatus) => {
    await setCaseStatusAdmin(c.id, status);
    setList((l) => (l ?? []).map((x) => (x.id === c.id ? { ...x, status, statusAt: new Date().toISOString() } : x)));
  };
  return (
    <main className="props">
      <div className="props-head"><h2>{P.admin}</h2><button className="ghost" onClick={load}>{P.refresh}</button></div>
      {error && <div className="warnings">{error}</div>}
      <div className="chips">
        <button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>{P.active} ({(list ?? []).filter((c) => c.status !== "draft" && c.status !== "done").length})</button>
        {STATUSES.map((s) => (
          <button key={s} className={filter === s ? "active" : ""} onClick={() => setFilter(s)}>{P.status[s]} ({counts[s] ?? 0})</button>
        ))}
      </div>
      {list && shown.length === 0 && <div className="card muted">{P.none}</div>}
      {shown.length > 0 && (
        <div className="card table-scroll">
          <table className="plan pipeline">
            <thead><tr><th>{P.cols.address}</th><th>{P.cols.owner}</th><th>{P.cols.submitted}</th><th>{P.cols.data}</th><th>{P.cols.shots}</th><th>{P.cols.status}</th><th /></tr></thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td><bdi>{c.address.trim() || t.files.untitled}</bdi></td>
                  <td className="small">{c.owner ? <>{c.owner.name ?? ""} <span className="muted">{c.owner.email}</span>{c.owner.role ? ` · ${t.account.roles[c.owner.role as keyof typeof t.account.roles] ?? c.owner.role}` : ""}</> : "—"}</td>
                  <td className="small">{ago(c.submittedAt, lang) || "—"}</td>
                  <td className="small">{c.request ? `${c.request.done}/${c.request.total}${c.request.status === "final" ? " ✓" : ""}` : "—"}</td>
                  <td className="small">{c.shots || "—"}</td>
                  <td>
                    <select value={c.status} onChange={(e) => change(c, e.target.value as CaseStatus)}>
                      {STATUSES.map((s) => <option key={s} value={s}>{P.status[s]}</option>)}
                    </select>
                    <div className="small muted">{ago(c.statusAt, lang)}</div>
                  </td>
                  <td><button className="ghost" onClick={() => onOpen(c.id)}>{P.open}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

/** Above a property's tabs: back to the list, the address, its status, and "send for review". */
export function PropertyStrip({ address, status, onBack, onSubmit, submitting }: {
  address: string; status: CaseStatus; onBack: () => void; onSubmit: () => void; submitting: boolean;
}) {
  const { t } = useT();
  const P = t.pipeline;
  return (
    <div className="property-bar no-print">
      <button className="ghost" onClick={onBack}>{P.back}</button>
      <b className="strip-addr"><bdi>{address || t.files.untitled}</bdi></b>
      <StatusBadge status={status} />
      {status === "draft" && (
        <button className="primary" onClick={onSubmit} disabled={submitting || !address}>{P.submit}</button>
      )}
      {status === "draft" && <span className="small muted">{P.submitHelp}</span>}
    </div>
  );
}
