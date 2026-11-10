import { useEffect, useMemo, useState } from "react";
import { adminApi, type UserDetailDto, type UserRowDto } from "../../data/adminApi";
import { useT } from "../context";
import { ago, Section, Status, useBusy, when } from "./bits";
import { taskTitle, useAT } from "./texts";
import { EventList, MessageList } from "./Workbench";

type UF = "all" | "noProperty" | "drafts" | "active";

export function UsersTable({ onOpen }: { onOpen: (id: string) => void }) {
  const { A, lang } = useAT();
  const { t } = useT();
  const U = A.users;
  const [rows, setRows] = useState<UserRowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [flt, setFlt] = useState<UF>("all");
  useEffect(() => { adminApi.users().then(setRows).catch((e) => setError((e as Error).message)); }, []);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (rows ?? []).filter((u) =>
      (!n || [u.name, u.email, u.phone].some((v) => v?.toLowerCase().includes(n))) &&
      (flt === "all" || (flt === "noProperty" && u.properties === 0) || (flt === "drafts" && u.drafts > 0) || (flt === "active" && u.submitted > 0)));
  }, [rows, q, flt]);
  return (
    <main className="adm-main wide">
      <div className="filters">
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={U.search} aria-label={U.search} />
        <div className="seg-mini">{(Object.keys(U.filters) as UF[]).map((k) => <button key={k} className={flt === k ? "on" : ""} onClick={() => setFlt(k)}>{U.filters[k]}</button>)}</div>
        <span className="small muted">{rows ? U.count(shown.length) : ""}</span>
      </div>
      {error && <div className="card warnings">{error}</div>}
      {!rows && !error && <div className="card muted">{A.common.loading}</div>}
      {rows && (
        <div className="table-wrap">
          <table className="adm-table">
            <thead><tr>
              <th>{U.cols.name}</th><th>{U.cols.email}</th><th>{U.cols.phone}</th><th>{U.cols.role}</th><th>{U.cols.registered}</th><th>{U.cols.lastSeen}</th>
              <th>{U.cols.lang}</th><th>{U.cols.properties}</th><th>{U.cols.welcome}</th><th>{U.cols.open}</th>
            </tr></thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id} onClick={() => onOpen(u.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onOpen(u.id); }}>
                  <td><b>{u.name ?? "—"}</b>{u.isAdmin && <span className="badge small-badge">{U.admin}</span>}</td>
                  <td dir="ltr" className="ltr-cell">{u.email}</td>
                  <td dir="ltr" className="ltr-cell">{u.phone ?? "—"}</td>
                  <td>{u.role ? (t.account.roles as any)[u.role] ?? u.role : "—"}</td>
                  <td className="nowrap">{when(u.createdAt, lang)}</td>
                  <td className="nowrap muted">{ago(u.lastSeen, lang)}</td>
                  <td>{u.lang === "en" ? "EN" : "עב"}</td>
                  <td>{u.properties ? <><b>{u.submitted}</b><span className="muted"> / {u.properties}</span></> : <span className="muted">{U.noProps}</span>}</td>
                  <td><span className={`msg-st ms-${u.welcome}`}>{u.welcome === "none" ? "—" : A.msgStatus[u.welcome] ?? u.welcome}</span></td>
                  <td>{u.openRequests || <span className="muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="muted empty">{U.none}</p>}
        </div>
      )}
    </main>
  );
}

export function UserView({ id, onOpenProperty }: { id: string; onOpenProperty: (id: string) => void }) {
  const { A, lang } = useAT();
  const { t } = useT();
  const U = A.users;
  const [d, setD] = useState<UserDetailDto | null>(null);
  const { busy, error, run } = useBusy();
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const load = () => adminApi.user(id).then(setD);
  useEffect(() => { load(); }, [id]);
  const act = (what: Parameters<typeof adminApi.userAction>[1], body?: unknown) => run(async () => setD(await adminApi.userAction(id, what, body)));
  if (!d) return <main className="adm-main"><div className="card muted">{A.common.loading}</div></main>;
  const u = d.user;
  return (
    <main className="adm-main wb">
      <header className="adm-card wb-head">
        <div className="wb-title">
          <h1>{u.name ?? u.email}</h1>
          <div className="wb-sub small">
            <a href={`mailto:${u.email}`} dir="ltr">{u.email}</a>
            {u.phone && <a href={`tel:${u.phone}`} dir="ltr">{u.phone}</a>}
            {u.role && <span>{(t.account.roles as any)[u.role] ?? u.role}</span>}
            <span className="muted">{U.cols.registered}: {when(u.createdAt, lang)} · {U.cols.lastSeen}: {ago(u.lastSeen, lang)} · {u.lang === "en" ? "English" : "עברית"}</span>
          </div>
        </div>
        <div className="wb-actions">
          <button className="ghost" disabled={busy} onClick={() => act("welcome")}>{U.resendWelcome}</button>
          <label className="chk"><input type="checkbox" checked={u.remindersOptOut} onChange={(e) => act("reminders", { optOut: e.target.checked })} /> {U.optOut}</label>
        </div>
        {error && <div className="small warn-text">{error}</div>}
      </header>
      <div className="wb-grid">
        <Section title={U.properties}>
          {d.properties.length === 0 ? <p className="muted">{U.noProps}</p> : (
            <ul className="prop-mini">
              {d.properties.map((p) => (
                <li key={p.id}><button className="person" onClick={() => onOpenProperty(p.id)}>
                  <span className="person-main"><b><bdi>{p.address.trim() || "—"}</bdi></b><small className="muted"><bdi dir="ltr">{p.appNo}</bdi> · {ago(p.updatedAt, lang)}</small></span>
                  <Status status={p.status} />
                </button></li>
              ))}
            </ul>
          )}
          {d.tasks.length > 0 && <ul className="small muted">{d.tasks.map((x) => <li key={x.id}>{taskTitle(A, x.key)} · {A.queue.remindersSent(x.remindersSent)}{x.paused ? ` · ${A.queue.pause}` : ""}</li>)}</ul>}
        </Section>
        <Section title={U.message}>
          <form className="compose" onSubmit={(e) => { e.preventDefault(); act("message", { subject, text }).then(() => { setSubject(""); setText(""); }); }}>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={A.wb.comms.subject} aria-label={A.wb.comms.subject} />
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={A.wb.comms.text} aria-label={A.wb.comms.text} />
            <button className="primary" disabled={busy || !subject.trim() || !text.trim()}>{A.common.send}</button>
          </form>
        </Section>
        <Section title={A.wb.notes}>
          <p className="small muted">🔒 {A.wb.notesHelp}</p>
          <form className="compose" onSubmit={(e) => { e.preventDefault(); act("notes", { text: note }).then(() => setNote("")); }}>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-label={A.wb.addNote} />
            <button className="ghost" disabled={!note.trim()}>{A.wb.addNote}</button>
          </form>
          <ul className="notes">{d.notes.map((n) => <li key={n.id}><p>{n.text}</p><small className="muted">{n.author} · {when(n.at, lang)}</small></li>)}</ul>
        </Section>
        <Section title={U.messages}><MessageList messages={d.messages} onChanged={load} /></Section>
        <section className="adm-card wb-span"><header className="adm-card-head"><h3>{A.wb.history}</h3></header><EventList events={d.events} /></section>
      </div>
    </main>
  );
}
