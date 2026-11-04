import { toLocalM } from "../engine/geo";
import type { ValuationResult } from "../engine/valuation";
import type { LatLng, Listing, RenewalStage, TransitStop } from "../engine/types";
import { STAGE_ORDER } from "../engine/renewal";
import { useT } from "./context";
import { basemapTiles, TILE_ATTRIBUTION, TILE_COPYRIGHT_URL } from "./basemap";

/**
 * Map in local metres around the property. With live data, OpenStreetMap street tiles are
 * drawn underneath; the demo (a fictional town) keeps the plain schematic background.
 */
const HALF = 1100; // metres shown either side of the property
const SIZE = 520;

export function MapView({ r, center, stops, listings }: { r: ValuationResult; center: LatLng; stops: TransitStop[]; listings: Listing[] }) {
  const { t, f } = useT();
  const tiles = r.dataSource.isDemo ? [] : basemapTiles(center, HALF, SIZE);
  const px = (p: LatLng) => {
    const m = toLocalM(center, p);
    return { x: SIZE / 2 + (m.x / HALF) * (SIZE / 2), y: SIZE / 2 - (m.y / HALF) * (SIZE / 2) };
  };
  const inView = (p: LatLng) => {
    const m = toLocalM(center, p);
    return Math.abs(m.x) < HALF && Math.abs(m.y) < HALF;
  };
  const rPx = (m: number) => (m / HALF) * (SIZE / 2);
  const stageColor = (s: RenewalStage) => {
    const i = STAGE_ORDER.indexOf(s);
    return i >= 6 ? "var(--c-renewal-3)" : i >= 4 ? "var(--c-renewal-2)" : "var(--c-renewal-1)";
  };

  return (
    <figure className="map">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={t.map}>
        <rect width={SIZE} height={SIZE} fill="var(--c-map-bg)" />
        {tiles.length > 0 && (
          <g aria-hidden>
            {tiles.map((tl) => (
              <image key={tl.url} href={tl.url} x={tl.x} y={tl.y} width={tl.w + 0.5} height={tl.h + 0.5} preserveAspectRatio="none" />
            ))}
            {/* Soften the street map so the markers stay readable. */}
            <rect width={SIZE} height={SIZE} fill="#fff" fillOpacity={0.35} />
          </g>
        )}
        {[300, 600, 1000].map((m) => (
          <g key={m}>
            <circle cx={SIZE / 2} cy={SIZE / 2} r={rPx(m)} fill="none" stroke="var(--c-grid)" strokeDasharray={m === r.comparables.radiusM ? "0" : "4 4"} strokeWidth={m === r.comparables.radiusM ? 1.5 : 1} />
            <text x={SIZE / 2 + rPx(m) * 0.707 + 3} y={SIZE / 2 - rPx(m) * 0.707 - 3} className="map-label">{f.dist(m)}</text>
          </g>
        ))}
        {/* Renewal projects */}
        {r.renewal.nearby.map((p) => {
          const q = px(p.location);
          return (
            <g key={p.projectKey}>
              <rect x={q.x - 9} y={q.y - 9} width={18} height={18} rx={3} fill={stageColor(p.stage)} fillOpacity={0.25} stroke={stageColor(p.stage)} strokeDasharray={p.unconfirmed ? "3 2" : undefined} strokeWidth={1.5}>
                <title>{p.label} · {t.stage[p.stage]}</title>
              </rect>
            </g>
          );
        })}
        {/* Bus / rail stops */}
        {stops.filter((s) => inView(s.location)).map((s) => {
          const q = px(s.location);
          return (
            <circle key={s.id} cx={q.x} cy={q.y} r={s.mode === "bus" ? 3 : 5} fill="var(--c-transit)">
              <title>{t.mode[s.mode]} · {s.name}</title>
            </circle>
          );
        })}
        {/* Future stations */}
        {r.transport.future.map((f) =>
          f.line.stations.filter((st) => inView(st.location)).map((st) => {
            const q = px(st.location);
            return (
              <g key={f.line.id + st.id}>
                <path d={`M${q.x} ${q.y - 8} l8 8 l-8 8 l-8 -8z`} fill="var(--c-future)" fillOpacity={f.line.maturity === "under_construction" ? 0.9 : 0.35} stroke="var(--c-future)" />
                {f.line.mode === "metro" && <circle cx={q.x} cy={q.y} r={rPx(800)} fill="none" stroke="var(--c-future)" strokeOpacity={0.35} strokeDasharray="2 4" />}
                <title>{f.line.name} · {st.name} · {t.maturity[f.line.maturity]}</title>
              </g>
            );
          }),
        )}
        {/* Active listings */}
        {listings.filter((l) => inView(l.location)).map((l) => {
          const q = px(l.location);
          return <rect key={l.id} x={q.x - 3.5} y={q.y - 3.5} width={7} height={7} fill="none" stroke="var(--c-listing)" strokeWidth={1.5}><title>{t.legend.listing}</title></rect>;
        })}
        {/* Comparables, sized by weight */}
        {r.comparables.used.map((c) => {
          const q = px(c.deal.location);
          return (
            <circle key={c.deal.id} cx={q.x} cy={q.y} r={4 + c.weightShare * 30} fill="var(--c-comp)" fillOpacity={0.55} stroke="var(--c-comp)">
              <title>{c.deal.address.street} {c.deal.address.number} · {Math.round(c.adjustedPpsqm).toLocaleString()} ₪/m²</title>
            </circle>
          );
        })}
        {/* Subject */}
        <path
          transform={`translate(${SIZE / 2} ${SIZE / 2})`}
          d="M0 -11 L3.2 -3.4 L11 -3.4 L4.8 1.6 L7 9.6 L0 5 L-7 9.6 L-4.8 1.6 L-11 -3.4 L-3.2 -3.4 Z"
          fill="var(--c-accent)"
          stroke="white"
          strokeWidth={1.5}
        />
      </svg>
      <figcaption className="legend">
        <span><i className="sw star" /> {t.legend.subject}</span>
        <span><i className="sw comp" /> {t.legend.comp}</span>
        <span><i className="sw listing" /> {t.legend.listing}</span>
        <span><i className="sw transit" /> {t.legend.bus}</span>
        <span><i className="sw future" /> {t.legend.future}</span>
        <span><i className="sw renewal" /> {t.legend.renewal}</span>
        {tiles.length > 0 && (
          <span className="attribution">
            <a href={TILE_COPYRIGHT_URL} target="_blank" rel="noreferrer">{TILE_ATTRIBUTION}</a>
          </span>
        )}
      </figcaption>
    </figure>
  );
}
