import { useEffect, useMemo, useState } from "react";
import { adminApi, type PropertyRowDto } from "../../data/adminApi";
import type { CaseStatus } from "../../data/apiClient";
import { useT } from "../context";
import { ago, Status } from "./bits";
import { taskTitle, useAT } from "./texts";

export interface PropFilter { status?: CaseStatus; attention?: boolean; task?: string; stale?: boolean; service?: "free" | "full" }
type Col = "appNo" | "address" | "owner" | "type" | "size" | "submittedAt" | "updatedAt" | "service" | "completion" | "confidence" | "status" | "tasks" | "assignee" | "waitingDays";

const STATUSES: CaseStatus[] = ["draft", "submitted", "working", "prelim_review", "prelim_sent", "full_requested", "full_in_progress", "full_done", "closed"];

export function PropertiesTable({ onOpen, initial }: { onOpen: (id: string) => void; initial?: PropFilter }) {
  const { A, lang } = useAT();
  const { f, t } = useT();
  const P = A.props;
  const [rows, setRows] = useState<PropertyRowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [flt, setFlt] = useState<PropFilter>(initial ?? {});
  const [city, setCity] = useState("");
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: "waitingDays", dir: -1 });
  useEffect(() => { adminApi.properties().then(setRows).catch((e) => setError((e as Error).message)); }, []);

  const cities = useMemo(() => [...new Set((rows ?? []).map((r) => r.city).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "he")), [rows]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = (rows ?? []).filter((r) =>
      (!needle || [r.address, r.appNo, r.owner?.name, r.owner?.email].some((v) => v?.toLowerCase().includes(needle))) &&
      (!flt.status || r.status === flt.status) && (!flt.service || r.service === flt.service) && (!city || r.city === city) &&
      (!flt.attention || (r.openAdmin > 0 && r.status !== "draft")) && (!flt.stale || r.stale) &&
      (!flt.task || r.taskKeys.some((k) => k.startsWith(flt.task!))));
    const val = (r: PropertyRowDto): string | number => {
      switch (sort.col) {
        case "owner": return r.owner?.name ?? r.owner?.email ?? "";
        case "tasks": return r.openAdmin * 100 + r.openUser;
        case "size": return r.size ?? 0;
        default: return (r as any)[sort.col] ?? "";
      }
    };
    list = [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), lang)) * sort.dir;
    });
    return list;
  }, [rows, q, flt, city, sort]);

  const th = (col: Col, label: string) => (
    <th aria-sort={sort.col === col ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button className="th-btn" onClick={() => setSort((s) => ({ col, dir: s.col === col ? (s.dir === 1 ? -1 : 1) : -1 }))}>{label}{sort.col === col ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</button>
    </th>
  );

  return (
    <main className="adm-main wide">
      <div className="filters">
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={P.search} aria-label={P.search} />
        <select value={flt.status ?? ""} onChange={(e) => setFlt((x) => ({ ...x, status: (e.target.value || undefined) as CaseStatus | undefined }))} aria-label={P.allStatuses}>
          <option value="">{P.allStatuses}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t.pipeline.status[s] ?? s}</option>)}
        </select>
        <select value={flt.service ?? ""} onChange={(e) => setFlt((x) => ({ ...x, service: (e.target.value || undefined) as any }))} aria-label={P.allServices}>
          <option value="">{P.allServices}</option><option value="free">{P.free}</option><option value="full">{P.full}</option>
        </select>
        <select value={city} onChange={(e) => setCity(e.target.value)} aria-label="city">
          <option value="">—</option>{cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="chk"><input type="checkbox" checked={!!flt.attention} onChange={(e) => setFlt((x) => ({ ...x, attention: e.target.checked }))} /> {P.needsAttention}</label>
        <label className="chk"><input type="checkbox" checked={!!flt.stale} onChange={(e) => setFlt((x) => ({ ...x, stale: e.target.checked }))} /> {P.staleOnly}</label>
        {flt.task && <button className="chip-x" onClick={() => setFlt((x) => ({ ...x, task: undefined }))}>{taskTitle(A, flt.task === "doc:" ? "doc:ownership" : flt.task).split("–")[0]} ✕</button>}
        <span className="small muted">{rows ? P.count(shown.length, rows.length) : ""}</span>
      </div>
      {error && <div className="card warnings">{error}</div>}
      {!rows && !error && <div className="card muted">{A.common.loading}</div>}
      {rows && (
        <div className="table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                {th("appNo", P.cols.id)}{th("address", P.cols.address)}{th("owner", P.cols.owner)}{th("type", P.cols.type)}{th("size", P.cols.size)}
                {th("submittedAt", P.cols.submitted)}{th("updatedAt", P.cols.updated)}{th("service", P.cols.service)}{th("completion", P.cols.completion)}
                {th("confidence", P.cols.confidence)}{th("status", P.cols.status)}{th("tasks", P.cols.tasks)}{th("assignee", P.cols.assignee)}{th("waitingDays", P.cols.waiting)}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => onOpen(r.id)} className={r.stale ? "stale" : ""} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen(r.id); }}>
                  <td><bdi dir="ltr" className="mono">{r.appNo ?? "—"}</bdi></td>
                  <td className="addr"><b><bdi>{r.address.trim() || "—"}</bdi></b></td>
                  <td>{r.owner ? (r.owner.name ?? r.owner.email) : <span className="muted">{A.queue.noOwner}</span>}</td>
                  <td>{r.type ? A.types[r.type] ?? r.type : "—"}</td>
                  <td>{r.size ? `${r.size} ${lang === "he" ? "מ״ר" : "sqm"}` : "—"}</td>
                  <td className="nowrap">{r.submittedAt ? f.dnum(r.submittedAt) : "—"}</td>
                  <td className="nowrap muted">{ago(r.updatedAt, lang)}</td>
                  <td><span className={`svc ${r.service}`}>{r.service === "full" ? P.full : P.free}</span></td>
                  <td><div className="mini-bar"><i style={{ width: `${r.completion}%` }} /></div><small>{r.completion}%</small></td>
                  <td><span className={`lvl lvl-${r.level}`}>{r.confidence}%</span></td>
                  <td><Status status={r.status} /></td>
                  <td className="nowrap">
                    {r.openAdmin + r.openUser > 0 ? <><b>{r.openAdmin}</b><span className="muted"> / {r.openUser}</span></> : <span className="muted">0</span>}
                    {r.topTask && <div className="small muted clip">{taskTitle(A, r.topTask)}</div>}
                  </td>
                  <td className="small">{r.assignee ?? <span className="muted">—</span>}</td>
                  <td className="nowrap">{r.status === "draft" ? <span className="muted">—</span> : <span className={r.stale ? "warn-text" : ""}>{P.days(r.waitingDays)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="muted empty">{P.none}</p>}
        </div>
      )}
    </main>
  );
}
