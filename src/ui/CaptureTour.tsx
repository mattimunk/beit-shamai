import { useEffect, useMemo, useState } from "react";
import type { Subject } from "../engine/types";
import { frameUrl, getCapture, saveVisitLayout, uploadShot, type CaptureDto, type VisitLayout } from "../data/apiClient";
import { useT } from "./context";

type ShotKind = "facade" | "entrance" | "stairs" | "salon" | "kitchen" | "bedroom" | "bathroom" | "toilet" | "extra" | "balcony" | "garden" | "storage" | "parking" | "view";
interface Shot { id: string; kind: ShotKind; n?: number }

/** Same order as the server's buildShotList (server/capture.ts). */
function shotList(l: VisitLayout): Shot[] {
  const many = (kind: ShotKind, c: number): Shot[] => Array.from({ length: Math.max(0, Math.min(12, Math.floor(c))) }, (_, i) => ({ id: `${kind}-${i + 1}`, kind, n: c > 1 ? i + 1 : undefined }));
  return [
    { id: "facade", kind: "facade" }, { id: "entrance", kind: "entrance" }, { id: "stairs", kind: "stairs" },
    { id: "salon", kind: "salon" }, { id: "kitchen", kind: "kitchen" },
    ...many("bedroom", l.bedrooms), ...many("bathroom", l.bathrooms), ...many("toilet", l.toilets),
    ...(l.extra ?? []).slice(0, 12).map((_, i) => ({ id: `extra-${i + 1}`, kind: "extra" as const, n: i + 1 })),
    ...many("balcony", l.balconies),
    ...(l.garden ? [{ id: "garden", kind: "garden" as const }] : []),
    ...(l.storage ? [{ id: "storage", kind: "storage" as const }] : []),
    ...(l.parking ? [{ id: "parking", kind: "parking" as const }] : []),
    { id: "view", kind: "view" },
  ];
}

/** The tour's shot ids for a layout, in walking order. */
export const shotIds = (l: VisitLayout) => shotList(l).map((s) => s.id);

const KIND_ORDER: ShotKind[] = ["facade", "entrance", "stairs", "salon", "kitchen", "bedroom", "bathroom", "toilet", "extra", "balcony", "garden", "storage", "parking", "view"];
/** Sort key: walking order of the shot list. */
export function shotOrder(shotId: string): number {
  const [kind, n] = shotId.split("-");
  const i = KIND_ORDER.indexOf(kind as ShotKind);
  return (i < 0 ? 99 : i) * 100 + Number(n ?? 0);
}

export function defaultLayout(s: Subject): VisitLayout {
  return {
    bedrooms: Math.max(1, Math.round(s.rooms) - 1),
    bathrooms: 1,
    toilets: 0,
    balconies: s.addOns.filter((a) => a.type === "sun_balcony" || a.type === "covered_balcony").length,
    garden: s.addOns.some((a) => a.type === "garden"),
    storage: s.addOns.some((a) => a.type === "storage"),
    parking: s.addOns.some((a) => a.type === "parking"),
  };
}

/** The shot's label, e.g. "חדר שינה 2". Exported for the report annex. */
export function useShotLabel(extraNames: string[] = []) {
  const { t } = useT();
  return (shotId: string) => {
    const [kind, n] = shotId.split("-") as [ShotKind, string | undefined];
    if (kind === "extra" && extraNames[Number(n) - 1]) return extraNames[Number(n) - 1]!;
    const base = t.visit.kinds[kind] ?? shotId;
    return n && Number(n) > 0 ? `${base} ${n}` : base;
  };
}

/**
 * Guided visit, car-rental style: the layout gives a shot list; each shot gets a short video
 * (or a photo), uploaded straight away; the server picks the sharpest frames for the report.
 */
export function CaptureTour({ base, subject, onChange, layoutFixed, skipped = [], onSkip, poll = false, compact = false }: {
  base: string; subject?: Subject; onChange?: (c: CaptureDto[]) => void;
  /** Rooms decided by the questionnaire: the layout editor is hidden. */
  layoutFixed?: VisitLayout | null;
  skipped?: string[]; onSkip?: (shotId: string, skip: boolean) => void;
  /** Check for new footage every few seconds (desktop waiting for the phone). */
  poll?: boolean;
  /** Inside the questionnaire: no own title or layout card. */
  compact?: boolean;
}) {
  const { t } = useT();
  const V = t.visit;
  const [layout, setLayout] = useState<VisitLayout | null>(null);
  const label = useShotLabel(layout?.extra ?? layoutFixed?.extra ?? []);
  const [captures, setCaptures] = useState<CaptureDto[]>([]);
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    getCapture(base).then((r) => {
      setLayout(layoutFixed ?? r.layout ?? (subject ? defaultLayout(subject) : { bedrooms: 2, bathrooms: 1, toilets: 0, balconies: 1, garden: false, storage: false, parking: false }));
      setCaptures(r.captures);
      onChange?.(r.captures);
    });
  }, [base]);
  useEffect(() => { if (layoutFixed) setLayout(layoutFixed); }, [JSON.stringify(layoutFixed)]);
  // Footage filmed on another device shows up here by itself.
  useEffect(() => {
    if (!poll) return;
    const h = setInterval(() => {
      getCapture(base).then((r) => {
        setCaptures((cur) => {
          if (r.captures.length === cur.length && r.captures.every((c, i) => c.at === cur[i]?.at)) return cur;
          onChange?.(r.captures);
          return r.captures;
        });
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(h);
  }, [base, poll]);

  const shots = useMemo(() => (layout ? shotList(layout) : []), [layout]);
  const byShot = new Map<string, CaptureDto>(captures.map((c: CaptureDto) => [c.shotId, c] as const));
  const done = shots.filter((s) => byShot.has(s.id)).length;
  const next = shots.find((s) => !byShot.has(s.id) && !skipped.includes(s.id));

  const updateLayout = (patch: Partial<VisitLayout>) => {
    const l = { ...layout!, ...patch };
    setLayout(l);
    saveVisitLayout(base, l);
  };

  const upload = async (shot: Shot, file: File) => {
    setErrors((e) => ({ ...e, [shot.id]: "" }));
    setBusy((b) => ({ ...b, [shot.id]: 0 }));
    try {
      const rec = await uploadShot(base, shot.id, file, (p) => setBusy((b) => ({ ...b, [shot.id]: p })));
      if (skipped.includes(shot.id)) onSkip?.(shot.id, false);
      const list = [...captures.filter((c) => c.shotId !== shot.id), rec];
      setCaptures(list);
      onChange?.(list);
      setOpen(null);
    } catch (e) {
      setErrors((x) => ({ ...x, [shot.id]: (e as Error).message }));
    } finally {
      setBusy((b) => { const { [shot.id]: _, ...rest } = b; return rest; });
    }
  };

  if (!layout) return <main className="visit"><div className="card muted">{t.loading}</div></main>;

  const counter = (key: "bedrooms" | "bathrooms" | "toilets" | "balconies") => (
    <label className="field" key={key}>
      <span>{V.layout[key]}</span>
      <div className="stepper">
        <button type="button" onClick={() => updateLayout({ [key]: Math.max(0, layout[key] - 1) })}>−</button>
        <b>{layout[key]}</b>
        <button type="button" onClick={() => updateLayout({ [key]: Math.min(12, layout[key] + 1) })}>+</button>
      </div>
    </label>
  );

  return (
    <main className={"visit" + (compact ? " compact" : "")}>
      {!compact && (
        <section className="card">
          <h2>{V.title}</h2>
          <p className="muted">{V.intro}</p>
          {!layoutFixed && (
            <div className="visit-layout">
              {(["bedrooms", "bathrooms", "toilets", "balconies"] as const).map(counter)}
              {(["garden", "storage", "parking"] as const).map((k) => (
                <label key={k} className="inline"><input type="checkbox" checked={layout[k]} onChange={(e) => updateLayout({ [k]: e.target.checked })} /> {V.layout[k]}</label>
              ))}
            </div>
          )}
        </section>
      )}
      <div className="visit-progress">
        <div className="bar"><i style={{ width: `${(done / Math.max(1, shots.length)) * 100}%` }} /></div>
        <span className="small">{V.progress(done, shots.length)}</span>
      </div>
      <details className="small how">
        <summary>{V.howTitle}</summary>
        <ul>{V.how.map((h) => <li key={h}>{h}</li>)}</ul>
      </details>

      <ol className="shots">
        {shots.map((s) => {
          const c = byShot.get(s.id);
          const p = busy[s.id];
          const isSkipped = !c && skipped.includes(s.id);
          const isNext = next?.id === s.id;
          const expanded = open === s.id || (open === null && isNext);
          return (
            <li key={s.id} className={"shot card" + (c ? " done" : "") + (isNext ? " next" : "") + (isSkipped ? " skipped" : "")}>
              <button type="button" className="shot-head" onClick={() => setOpen(expanded ? "" : s.id)}>
                <span className="tick">{c ? "✓" : isSkipped ? "↷" : "○"}</span>
                <b>{label(s.id)}</b>
                {c && <span className="small muted">{c.media === "video" ? V.video(Math.round(c.duration ?? 0)) : V.photo}</span>}
                {isSkipped && <span className="small muted">{V.skipped}</span>}
              </button>
              {c && (
                <div className="frames">
                  {c.frames.map((f) => <img key={f} src={frameUrl(base, f)} alt={label(s.id)} loading="lazy" />)}
                </div>
              )}
              {expanded && (
                <div className="shot-body">
                  <p className="shot-instr">{V.instruction}</p>
                  <ul className="tips">{V.tips[s.kind].map((tip) => <li key={tip}>{tip}</li>)}</ul>
                  {p !== undefined ? (
                    <div className="uploading">
                      <div className="bar"><i style={{ width: `${Math.round(p * 100)}%` }} /></div>
                      <span className="small">{p < 1 ? V.uploading(Math.round(p * 100)) : V.processing}</span>
                    </div>
                  ) : (
                    <div className="shot-actions">
                      <label className="button primary">
                        🎥 {c ? V.retake : V.film}
                        <input type="file" accept="video/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(s, f); e.target.value = ""; }} />
                      </label>
                      <label className="button ghost">
                        📁 {V.uploadVideo}
                        <input type="file" accept="video/*,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(s, f); e.target.value = ""; }} />
                      </label>
                      <label className="button ghost">
                        📷 {V.takePhoto}
                        <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(s, f); e.target.value = ""; }} />
                      </label>
                      {!c && onSkip && (
                        <button type="button" className="ghost" onClick={() => { onSkip(s.id, !isSkipped); setOpen(null); }}>{isSkipped ? V.unskip : V.skipForNow}</button>
                      )}
                    </div>
                  )}
                  {errors[s.id] && <p className="warnings small">{errors[s.id]}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!next && shots.length > 0 && <section className="card">{V.complete}</section>}
    </main>
  );
}
