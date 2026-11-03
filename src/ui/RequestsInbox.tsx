import { useState } from "react";
import { listDataRequests, requestProgress, uploadTaxExport, type PlanItemDto, type RequestDto } from "../data/apiClient";
import { useT } from "./context";

const TAX_SITE = "https://nadlan.taxes.gov.il/svinfonadlan2010/";
const dmy = (iso: string) => iso.split("-").reverse().join("/");

function readToken(): string {
  try { return sessionStorage.getItem("bs-admin") ?? ""; } catch { return ""; }
}
function keepToken(v: string) {
  try { sessionStorage.setItem("bs-admin", v); } catch { /* storage unavailable: keep in memory only */ }
}

/**
 * Inbox for whoever has Tax Authority access: open requests, each with the exact searches
 * to run in the "מידע נדל"ן" system and an upload button per search.
 */
export function RequestsInbox() {
  const { t } = useT();
  const R = t.req;
  const [token, setToken] = useState(readToken);
  const [list, setList] = useState<RequestDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try { keepToken(token); setList(await listDataRequests(token)); } catch (e) { setError((e as Error).message); }
  };

  const criteriaText = (it: PlanItemDto) =>
    `${R.cols.city}: ${it.city}\n${R.cols.kind}: ${it.kind}\n${R.cols.period}: ${dmy(it.from)} – ${dmy(it.to)}\n${R.cols.area}: ${it.areaFrom} – ${it.areaTo}`;

  const copy = async (it: PlanItemDto) => {
    try { await navigator.clipboard.writeText(criteriaText(it)); setCopied(it.id); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked */ }
  };

  const upload = async (req: RequestDto, it: PlanItemDto, file: File) => {
    try {
      const out = await uploadTaxExport(token, req.id, it.id, file);
      const i = out.import;
      setNotes((n) => ({ ...n, [it.id]: (out.mismatch.length ? `⚠ ${out.mismatch.join("; ")} – ` : "") + R.result(i.stored, i.rows, i.partial, i.unlocated) }));
      setList((l) => (l ?? []).map((x) => (x.id === req.id ? out.request : x)));
    } catch (e) {
      setNotes((n) => ({ ...n, [it.id]: `⚠ ${(e as Error).message}` }));
    }
  };

  return (
    <main className="inbox">
      <section className="card">
        <h2>{R.inbox}</h2>
        <p className="muted">{R.howTo} <a href={TAX_SITE} target="_blank" rel="noreferrer">{R.openSite}</a></p>
        <div className="inbox-login">
          <label className="field">
            <span>{R.token}</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </label>
          <button className="primary" onClick={load} disabled={!token}>{R.load}</button>
          <span className="muted small">{R.tokenHelp}</span>
        </div>
        {error && <div className="warnings">{error}</div>}
      </section>

      {list && list.length === 0 && <section className="card muted">{R.none}</section>}
      {list?.map((req) => {
        const p = requestProgress(req);
        const s = req.subject;
        return (
          <section key={req.id} className="card request">
            <header className="request-head">
              <b><bdi>{s.address.street} {s.address.number}, {s.address.city}</bdi></b>
              <span className={"badge " + req.status}>{req.status === "final" ? R.final : R.preliminary}</span>
              <span className="muted small">{R.progress(p.done, p.total)} · {req.createdAt.slice(0, 16).replace("T", " ")}</span>
            </header>
            <table className="plan">
              <thead>
                <tr><th>{R.cols.city}</th><th>{R.cols.kind}</th><th>{R.cols.period}</th><th>{R.cols.area}</th><th>{R.cols.status}</th><th /></tr>
              </thead>
              <tbody>
                {req.items.map((it) => (
                  <tr key={it.id} className={"st-" + it.status}>
                    <td>{it.city}</td>
                    <td>{it.kind}</td>
                    <td><bdi>{dmy(it.from)} – {dmy(it.to)}</bdi></td>
                    <td><bdi>{it.areaFrom} – {it.areaTo}</bdi></td>
                    <td>{R.status[it.status]}{(notes[it.id] ?? it.note) && <div className="small muted">{notes[it.id] ?? it.note}</div>}</td>
                    <td className="actions">
                      {it.status === "pending" && (
                        <>
                          <button className="ghost" onClick={() => copy(it)}>{copied === it.id ? R.copied : R.copy}</button>
                          <label className="button primary">
                            {R.upload}
                            <input type="file" accept=".xls,.html,.htm" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(req, it, f); e.target.value = ""; }} />
                          </label>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </main>
  );
}
