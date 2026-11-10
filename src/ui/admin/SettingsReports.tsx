import { useEffect, useState, type ChangeEvent } from "react";
import { adminApi, type ReportsDto, type SettingsDto } from "../../data/adminApi";
import { Section, useBusy } from "./bits";
import { useAT } from "./texts";

export function SettingsView() {
  const { A } = useAT();
  const S = A.settings;
  const [s, setS] = useState<SettingsDto | null>(null);
  const [days, setDays] = useState("");
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useBusy();
  useEffect(() => { adminApi.settings().then((x) => { setS(x); setDays(x.reminderDays.join(", ")); }); }, []);
  if (!s) return <main className="adm-main"><div className="card muted">{A.common.loading}</div></main>;
  const num = (k: keyof SettingsDto) => (e: ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) } as SettingsDto);
  const save = () => run(async () => {
    const out = await adminApi.saveSettings({
      freshDays: s.freshDays, outdatedDays: s.outdatedDays, staleDays: s.staleDays, marketRadiusM: s.marketRadiusM, marketMonths: s.marketMonths,
      remindersOn: s.remindersOn, publicUrl: s.publicUrl, reminderDays: days.split(/[,\s]+/).filter(Boolean).map(Number),
    });
    setS({ ...s, ...out }); setDays(out.reminderDays.join(", ")); setSaved(true); setTimeout(() => setSaved(false), 2000);
  });
  return (
    <main className="adm-main">
      <h2>{S.title}</h2>
      <div className="wb-grid">
        <Section title={S.email}>
          <p className={s.emailConfigured ? "ok-text" : "warn-text"}>{s.emailConfigured ? S.emailOn(s.emailVia ?? "") : S.emailOff}</p>
          {!s.emailConfigured && <p className="small muted">{S.emailHow}</p>}
          <div className="row-buttons">
            <button className="ghost" disabled={busy || !s.emailConfigured} onClick={() => run(async () => { const r = await adminApi.retryUnsent(); setNote(`${r.queued}`); })}>{S.retryUnsent}</button>
            <button className="ghost" disabled={busy} onClick={() => run(async () => { await adminApi.tick(); setNote("✓"); })}>{S.runNow}</button>
            {note && <span className="small muted">{note}</span>}
          </div>
          <p className="small muted">{S.admins}: <bdi dir="ltr">{s.admins.join(", ") || "—"}</bdi></p>
        </Section>
        <Section title={S.reminders}>
          <label className="chk"><input type="checkbox" checked={s.remindersOn} onChange={(e) => setS({ ...s, remindersOn: e.target.checked })} /> {S.remindersOn}</label>
          <label className="mini-field"><span>{S.reminderDays}</span><input value={days} onChange={(e) => setDays(e.target.value)} dir="ltr" /></label>
          <label className="mini-field"><span>{S.staleDays}</span><input type="number" min={1} max={60} value={s.staleDays} onChange={num("staleDays")} /></label>
          <label className="mini-field"><span>{S.publicUrl}</span><input value={s.publicUrl} onChange={(e) => setS({ ...s, publicUrl: e.target.value })} dir="ltr" /></label>
        </Section>
        <Section title={S.market}>
          <label className="mini-field"><span>{S.freshDays}</span><input type="number" min={1} max={365} value={s.freshDays} onChange={num("freshDays")} /></label>
          <label className="mini-field"><span>{S.outdatedDays}</span><input type="number" min={2} max={730} value={s.outdatedDays} onChange={num("outdatedDays")} /></label>
          <label className="mini-field"><span>{S.radius}</span><input type="number" min={200} max={5000} step={50} value={s.marketRadiusM} onChange={num("marketRadiusM")} /></label>
          <label className="mini-field"><span>{S.months}</span><input type="number" min={3} max={60} value={s.marketMonths} onChange={num("marketMonths")} /></label>
        </Section>
      </div>
      <div className="row-buttons sticky-save">
        <button className="primary big" disabled={busy} onClick={save}>{saved ? `✓ ${S.saved}` : S.save}</button>
        {error && <span className="warn-text small">{error}</span>}
      </div>
    </main>
  );
}

export function ReportsView() {
  const { A, f } = useAT();
  const R = A.reports;
  const [r, setR] = useState<ReportsDto | null>(null);
  useEffect(() => { adminApi.reports().then(setR); }, []);
  if (!r) return <main className="adm-main"><div className="card muted">{A.common.loading}</div></main>;
  const bars = (vals: number[], label: string) => {
    const max = Math.max(1, ...vals);
    return (
      <figure className="bars" aria-label={label}>
        <div className="bars-row">
          {vals.map((v, i) => (
            <div key={i} className="bar-col" title={`${f.dnum(r.weekStarts[i]!)}: ${v}`}>
              <span className="bar-v">{v || ""}</span>
              <i style={{ height: `${(v / max) * 100}%` }} />
            </div>
          ))}
        </div>
        <figcaption className="small muted"><span>{f.dnum(r.weekStarts[0]!)}</span><span>{f.dnum(r.weekStarts[r.weekStarts.length - 1]!)}</span></figcaption>
      </figure>
    );
  };
  const kpi = (label: string, value: string | number, sub?: string) => <div className="kpi"><b>{value}</b><span>{label}</span>{sub && <small className="muted">{sub}</small>}</div>;
  const work = r.openByCategory.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.category]: (acc[x.category] ?? 0) + x.n }), {});
  const wmax = Math.max(1, ...Object.values(work));
  return (
    <main className="adm-main">
      <h2>{R.title}</h2>
      <div className="kpis">
        {kpi(R.submitted, `${r.submittedShare}%`)}
        {kpi(R.toPrelim, R.days(r.avgDaysToPrelim))}
        {kpi(R.taxWait, R.days(r.avgDaysTaxWait))}
        {kpi(R.reminders, r.remindersSent, r.remindersNotSent ? R.notSent(r.remindersNotSent) : undefined)}
        {kpi(R.docsUploaded, `${r.docsUploadedShare}%`, `${r.docsRequested}`)}
        {kpi(R.fullEnq, r.fullEnquiries)}
        {kpi(R.fullPaid, r.fullPaid)}
        {kpi(R.completed, r.prelimDelivered + r.fullDelivered)}
      </div>
      <div className="wb-grid">
        <Section title={R.users}>{bars(r.newUsers, R.users)}</Section>
        <Section title={R.properties}>{bars(r.newProperties, R.properties)}</Section>
        <Section title={R.workload}>
          <ul className="hbars">
            {Object.entries(work).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
              <li key={k}><span>{A.category[k] ?? k}</span><div className="mini-bar"><i style={{ width: `${(n / wmax) * 100}%` }} /></div><b>{n}</b></li>
            ))}
          </ul>
        </Section>
      </div>
    </main>
  );
}
