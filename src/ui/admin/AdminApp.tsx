import { useEffect, useMemo, useState } from "react";
import { adminApi, type OverviewDto, type QueueTaskDto } from "../../data/adminApi";
import { ago, AskReason, PriorityTag, Stat, useBusy } from "./bits";
import { PropertiesTable, type PropFilter } from "./PropertiesTable";
import { ReportsView, SettingsView } from "./SettingsReports";
import { taskTitle, useAT } from "./texts";
import { UserView, UsersTable } from "./Users";
import { Workbench, type WbTab } from "./Workbench";

type View =
  | { kind: "home" } | { kind: "properties"; filter?: PropFilter } | { kind: "users" } | { kind: "reports" } | { kind: "settings" }
  | { kind: "property"; id: string; tab?: WbTab } | { kind: "user"; id: string };

/** Which workbench tab a task belongs to. */
export function tabFor(key: string): WbTab {
  if (key === "tax_data" || key === "market_refresh") return "market";
  if (key.startsWith("doc:") || key === "verify_docs") return "documents";
  if (key === "tour" || key === "condition_review") return "media";
  if (key.startsWith("prelim") || key === "full_next" || key === "accept_quote") return "appraisal";
  if (key.startsWith("clarify:") || key === "user_responded") return "comms";
  return "tasks";
}

export function AdminApp({ me, onOpenRequests }: { me: string; onOpenRequests?: () => void }) {
  const { A } = useAT();
  const [view, setView] = useState<View>({ kind: "home" });
  const [stack, setStack] = useState<View[]>([]);
  const go = (v: View) => { setStack((s) => [...s, view]); setView(v); window.scrollTo({ top: 0 }); };
  const back = () => { const prev = stack[stack.length - 1]; setStack((s) => s.slice(0, -1)); setView(prev ?? { kind: "home" }); };
  const top = (k: "home" | "properties" | "users" | "reports" | "settings") => { setStack([]); setView({ kind: k } as View); };

  const deep = view.kind === "property" || view.kind === "user";
  return (
    <div className="adm">
      <nav className="adm-nav" aria-label="admin">
        {(["home", "properties", "users", "reports", "settings"] as const).map((k) => (
          <button key={k} className={view.kind === k ? "on" : ""} onClick={() => top(k)}>{A.nav[k]}</button>
        ))}
        {deep && <button className="adm-back" onClick={back}>{A.nav.back}</button>}
      </nav>
      {view.kind === "home" && <Home me={me} go={go} />}
      {view.kind === "properties" && <PropertiesTable initial={view.filter} onOpen={(id) => go({ kind: "property", id })} />}
      {view.kind === "users" && <UsersTable onOpen={(id) => go({ kind: "user", id })} />}
      {view.kind === "reports" && <ReportsView />}
      {view.kind === "settings" && <SettingsView />}
      {view.kind === "property" && (
        <Workbench key={view.id} id={view.id} tab={view.tab} me={me} onOpenUser={(id) => go({ kind: "user", id })} onOpenRequests={onOpenRequests} />
      )}
      {view.kind === "user" && <UserView key={view.id} id={view.id} onOpenProperty={(id) => go({ kind: "property", id })} />}
    </div>
  );
}

// ---- Home: the morning control centre ------------------------------------------------------------

type SortKey = "priority" | "age" | "date" | "city" | "category" | "assignee";

function Home({ me, go }: { me: string; go: (v: View) => void }) {
  const { A, lang } = useAT();
  const [ov, setOv] = useState<OverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [sort, setSort] = useState<SortKey>("priority");
  const [cat, setCat] = useState<string>("");
  const load = () => adminApi.overview().then(setOv).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); const h = setInterval(load, 60_000); return () => clearInterval(h); }, []);

  const active = useMemo(() => {
    if (!ov) return [];
    let list = ov.queue.active.filter((t) => (scope === "mine" ? (t.assignee ?? t.caseAssignee) === me : true) && (!cat || t.category === cat));
    const by: Record<SortKey, (a: QueueTaskDto, b: QueueTaskDto) => number> = {
      priority: () => 0,
      age: (a, b) => b.ageDays - a.ageDays,
      date: (a, b) => a.createdAt.localeCompare(b.createdAt),
      city: (a, b) => (a.city ?? "").localeCompare(b.city ?? "", lang),
      category: (a, b) => a.category.localeCompare(b.category),
      assignee: (a, b) => (a.assignee ?? a.caseAssignee ?? "~").localeCompare(b.assignee ?? b.caseAssignee ?? "~"),
    };
    if (sort !== "priority") list = [...list].sort(by[sort]);
    return list;
  }, [ov, scope, sort, cat, me]);

  if (error) return <main className="adm-main"><div className="card warnings">{error}</div></main>;
  if (!ov) return <main className="adm-main"><div className="card muted">{A.common.loading}</div></main>;
  const s = ov.stats;
  const S = A.summary;
  const urgent = ov.queue.active.filter((t) => t.effectivePriority === 1 && !t.blocked).length;
  const lines = [
    s.newSubmissions && S.newProps(s.newSubmissions), urgent && S.urgent(urgent), s.prelimAwaitingApproval && S.approve(s.prelimAwaitingApproval),
    s.fullRequested && S.full(s.fullRequested), s.awaitingMarket && S.market(s.awaitingMarket), s.stale && S.stale(s.stale, ov.staleDays), s.usersWeek && S.newUsers(s.usersWeek),
  ].filter(Boolean) as string[];
  const first = ov.queue.active.find((t) => !t.blocked);
  const cats = [...new Set(ov.queue.active.map((t) => t.category))];
  const openTask = (t: QueueTaskDto) => (t.caseId ? go({ kind: "property", id: t.caseId, tab: tabFor(t.key) }) : t.userId ? go({ kind: "user", id: t.userId }) : undefined);

  return (
    <main className="adm-main">
      <section className="morning">
        <h1>{A.greet(new Date().getHours())}</h1>
        {lines.length ? (
          <>
            <p className="lead">{S.lead}</p>
            <ul className="morning-list">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
            {first && <p className="morning-first">{S.first} <button className="link-btn" onClick={() => openTask(first)}>{taskTitle(A, first.key, first.data)}{first.address ? ` · ${first.address}` : ""}</button></p>}
          </>
        ) : <p className="lead">{S.calm}</p>}
      </section>
      {!ov.emailConfigured && s.messagesNotSent > 0 && (
        <button className="banner warn" onClick={() => go({ kind: "settings" })}>✉️ {A.emailOff(s.messagesNotSent)}</button>
      )}

      <div className="stats">
        <Stat n={s.newSubmissions} label={A.stats.newSubmissions} tone={s.newSubmissions ? "accent" : "muted"} onClick={() => go({ kind: "properties", filter: { status: "submitted" } })} />
        <Stat n={s.attention} label={A.stats.attention} tone={s.attention ? "warn" : "muted"} onClick={() => go({ kind: "properties", filter: { attention: true } })} />
        <Stat n={s.awaitingMarket} label={A.stats.awaitingMarket} onClick={() => go({ kind: "properties", filter: { task: "tax_data" } })} />
        <Stat n={s.awaitingDocs} label={A.stats.awaitingDocs} onClick={() => go({ kind: "properties", filter: { task: "doc:" } })} />
        <Stat n={s.readyForPrelim} label={A.stats.readyForPrelim} tone={s.readyForPrelim ? "ok" : "muted"} onClick={() => go({ kind: "properties", filter: { task: "prelim_generate" } })} />
        <Stat n={s.prelimAwaitingApproval} label={A.stats.prelimAwaitingApproval} tone={s.prelimAwaitingApproval ? "warn" : "muted"} onClick={() => go({ kind: "properties", filter: { status: "prelim_review" } })} />
        <Stat n={s.prelimDelivered} label={A.stats.prelimDelivered} onClick={() => go({ kind: "properties", filter: { status: "prelim_sent" } })} />
        <Stat n={s.fullRequested} label={A.stats.fullRequested} tone={s.fullRequested ? "warn" : "muted"} onClick={() => go({ kind: "properties", filter: { status: "full_requested" } })} />
        <Stat n={s.fullInProgress} label={A.stats.fullInProgress} onClick={() => go({ kind: "properties", filter: { status: "full_in_progress" } })} />
        <Stat n={s.completed} label={A.stats.completed} onClick={() => go({ kind: "properties", filter: { status: "full_done" } })} />
        <Stat n={s.properties} label={A.stats.properties} sub={A.stats.drafts(s.drafts)} onClick={() => go({ kind: "properties" })} />
        <Stat n={s.users} label={A.stats.users} sub={A.stats.usersNew(s.usersToday, s.usersWeek)} onClick={() => go({ kind: "users" })} />
      </div>

      <div className="home-grid">
        <section className="adm-card queue">
          <header className="adm-card-head">
            <h3>{A.queue.title} <span className="count">{active.length}</span></h3>
            <div className="queue-tools">
              <div className="seg-mini">
                <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>{A.queue.all}</button>
                <button className={scope === "mine" ? "on" : ""} onClick={() => setScope("mine")}>{A.queue.mine}</button>
              </div>
              <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={A.queue.allCats}>
                <option value="">{A.queue.allCats}</option>
                {cats.map((c) => <option key={c} value={c}>{A.category[c] ?? c}</option>)}
              </select>
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label={A.queue.sort}>
                {(Object.keys(A.queue.sorts) as SortKey[]).map((k) => <option key={k} value={k}>{A.queue.sort}: {A.queue.sorts[k]}</option>)}
              </select>
            </div>
          </header>
          {active.length === 0 && <p className="muted empty">{A.queue.empty}</p>}
          <ul className="tasks">{active.map((t) => <TaskItem key={t.id} t={t} onOpen={() => openTask(t)} onChanged={load} />)}</ul>
          {ov.queue.snoozed > 0 && <p className="small muted">{A.queue.snoozed(ov.queue.snoozed)}</p>}

          <details className="waiting">
            <summary>{A.queue.waiting} <span className="count">{ov.queue.waiting.length}</span></summary>
            <ul className="tasks">{ov.queue.waiting.map((t) => <TaskItem key={t.id} t={t} onOpen={() => openTask(t)} onChanged={load} />)}</ul>
          </details>
          {ov.queue.doneToday.length > 0 && (
            <details className="waiting">
              <summary>{A.queue.done} <span className="count">{ov.queue.doneToday.length}</span></summary>
              <ul className="tasks done">{ov.queue.doneToday.map((t) => <TaskItem key={t.id} t={t} onOpen={() => openTask(t)} onChanged={load} />)}</ul>
            </details>
          )}
        </section>

        <section className="adm-card">
          <header className="adm-card-head"><h3>{A.newUsers}</h3></header>
          {ov.newUsers.length === 0 && <p className="muted empty">{A.noNewUsers}</p>}
          <ul className="people">
            {ov.newUsers.map((u) => (
              <li key={u.id}>
                <button className="person" onClick={() => go({ kind: "user", id: u.id })}>
                  <span className="avatar" aria-hidden>{(u.name ?? u.email).slice(0, 1).toUpperCase()}</span>
                  <span className="person-main">
                    <b>{u.name ?? u.email}</b>
                    <small className="muted">{u.name ? `${u.email} · ` : ""}{ago(u.createdAt, lang)}{u.cases ? "" : ` · ${A.users.noProps}`}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

/** One task in a list: what, which property, how long, and the quick actions. */
export function TaskItem({ t, onOpen, onChanged, compact }: { t: QueueTaskDto | (QueueTaskDto & { address?: undefined }); onOpen?: () => void; onChanged: () => void; compact?: boolean }) {
  const { A, lang } = useAT();
  const { busy, error, run } = useBusy();
  const [ask, setAsk] = useState<null | "dismiss" | "done">(null);
  const [preview, setPreview] = useState<null | { subject: string; text: string; to: string }>(null);
  const isOpen = t.status === "open";
  const user = t.party === "user";
  const act = (body: Parameters<typeof adminApi.task>[1]) => run(async () => { await adminApi.task(t.id, body); setAsk(null); setPreview(null); onChanged(); });
  return (
    <li className={`task p${t.effectivePriority ?? t.priority}${t.blocked ? " blocked" : ""}${user ? " waiting" : ""}${isOpen ? "" : " closed"}`}>
      <div className="task-main">
        <PriorityTag p={t.effectivePriority ?? t.priority} blocked={!!t.blocked} waiting={user} />
        <button className="task-title" onClick={onOpen} disabled={!onOpen}>{taskTitle(A, t.key, t.data)}</button>
        {t.blocked && <span className="small muted">· {A.blocked[t.blocked] ?? t.blocked}</span>}
      </div>
      {!compact && (
        <div className="task-meta small muted">
          {t.appNo && <bdi dir="ltr">{t.appNo}</bdi>}{t.address && <> · <bdi>{t.address}</bdi></>}{t.ownerName || t.ownerEmail ? <> · {t.ownerName ?? t.ownerEmail}</> : null}
        </div>
      )}
      <div className="task-meta small">
        <span className="muted">{A.queue.ageDays(t.ageDays ?? 0)}</span>
        {t.overdue && isOpen && <span className="flag-overdue">{A.queue.overdue}</span>}
        {t.stale && !t.overdue && isOpen && !user && <span className="flag-stale">{A.queue.stale}</span>}
        <span className="muted">· {A.category[t.category] ?? t.category}</span>
        {(t.assignee ?? t.caseAssignee) && <span className="muted">· {t.assignee ?? t.caseAssignee}</span>}
        {user && isOpen && <span className="muted">· {A.queue.remindersSent(t.remindersSent)}{t.remindersPaused ? ` · ${A.queue.pause}` : ""}</span>}
        {!isOpen && <span className="muted">· {A.wb.closedBy(t.doneBy ?? "", t.note ?? "")}</span>}
      </div>
      {isOpen && (
        <div className="task-actions">
          {onOpen && <button className="ghost" onClick={onOpen}>{A.queue.open}</button>}
          {!user && !t.blocked && <button className="ghost" disabled={busy} onClick={() => (t.party === "admin" ? act({ action: "done" }) : setAsk("done"))}>{A.queue.doneBtn}</button>}
          {user && (
            <>
              <button className="ghost" disabled={busy} onClick={() => run(async () => setPreview(await adminApi.reminderPreview(t.id)))}>{A.queue.remind}</button>
              <button className="ghost" disabled={busy} onClick={() => act({ action: t.remindersPaused ? "resume" : "pause" })}>{t.remindersPaused ? A.queue.resume : A.queue.pause}</button>
            </>
          )}
          <button className="ghost" disabled={busy} onClick={() => act({ action: "snooze" })}>{A.queue.snooze}</button>
          <button className="ghost" disabled={busy} onClick={() => setAsk("dismiss")}>{A.queue.notApplicable}</button>
        </div>
      )}
      {ask && <AskReason label={A.queue.reason} onCancel={() => setAsk(null)} onSubmit={(reason) => act({ action: ask, reason })} />}
      {preview && (
        <form className="reminder-edit" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); act({ action: "remind", subject: String(f.get("subject")), text: String(f.get("text")) }); }}>
          <div className="small muted">{A.wb.comms.preview} · {preview.to}</div>
          <input name="subject" defaultValue={preview.subject} aria-label={A.wb.comms.subject} />
          <textarea name="text" defaultValue={preview.text} rows={8} aria-label={A.wb.comms.text} dir={lang === "he" ? "rtl" : "ltr"} />
          <div className="row-buttons"><button className="primary" disabled={busy}>{A.common.send}</button><button type="button" className="ghost" onClick={() => setPreview(null)}>{A.common.cancel}</button></div>
        </form>
      )}
      {error && <div className="small warn-text">{error}</div>}
    </li>
  );
}
