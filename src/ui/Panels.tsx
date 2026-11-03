import { useState, type ReactNode } from "react";
import type { ValuationResult } from "../engine/valuation";
import { SIGNAL_RELIABILITY } from "../engine/renewal";
import { monthsBetween } from "../engine/stats";
import { useT, type Role } from "./context";

export function Card({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={"card " + (className ?? "")}>
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

export function ValueCard({ r, role }: { r: ValuationResult; role: Role }) {
  const { t, f } = useT();
  const c = r.comparables;
  const [ordered, setOrdered] = useState(false);
  return (
    <section className="card value-card">
      <div className="eyebrow">{role === "realtor" ? t.titleRealtor : t.titleBuyer}</div>
      {r.value ? (
        <>
          <div className="value">{f.nis(r.value.point)}</div>
          <div className="range">
            {t.range}: {f.nis(r.value.low)} – {f.nis(r.value.high)}
          </div>
          <div className="kpis">
            <div><b>{f.nis(Math.round(r.ppsqm ?? c.ppsqmMedian))}</b><span>{t.perSqm}</span></div>
            <div><b>{f.num(r.equivalentArea)}</b><span>{t.eqTotal}</span></div>
            <div>
              <b className={"badge conf-" + c.confidence}>{t.confidenceOpt[c.confidence]}</b>
              <span>{t.confidence}</span>
            </div>
          </div>
          <div className="muted small">{t.basedOn(c.used.length, c.radiusM)}</div>
          {r.valueDealsOnly && r.listingEvidence && (
            <div className="muted small">
              {t.dealsOnlyValue}: {f.nis(r.valueDealsOnly.point)} · {t.blendListings}: {Math.round(r.listingEvidence.blendWeight * 100)}%
            </div>
          )}
        </>
      ) : (
        <div className="value muted">—</div>
      )}
      {role === "buyer" && (
        <>
          <button type="button" className="cta" onClick={() => setOrdered(true)} disabled={ordered}>
            {t.orderSigned}
          </button>
          {ordered && <p className="small muted">{t.orderNote}</p>}
        </>
      )}
    </section>
  );
}

export function Warnings({ r }: { r: ValuationResult }) {
  const { t, f } = useT();
  if (!r.warnings.length) return null;
  return (
    <section className="card warnings" aria-label={t.warnings}>
      <ul>
        {r.warnings.map((w, i) => {
          let text: string;
          switch (w.key) {
            case "unpermitted_addons": text = t.warning.unpermitted_addons(w.count); break;
            case "assigned_addons": text = t.warning.assigned_addons(w.count); break;
            case "expropriation_risk": text = t.warning.expropriation_risk(w.line); break;
            case "listings_disagree": text = t.warning.listings_disagree(f.pct(w.gap)); break;
            default: text = t.warning[w.key];
          }
          return <li key={i}>{text}</li>;
        })}
      </ul>
    </section>
  );
}

export function AreaTable({ r }: { r: ValuationResult }) {
  const { t, f } = useT();
  return (
    <Card title={t.areaTable}>
      <table>
        <tbody>
          {r.area.method === "declared" ? (
            <tr><td>{t.declaredUsed} ({r.area.declaredSource})</td><td className="num">{f.num(r.area.total)} {t.sqm}</td><td /></tr>
          ) : (
            r.area.levels.map((lv, li) => (
              lv.lines.map((ln, i) => (
                <tr key={`${li}-${i}`} className={ln.counted ? "" : "excluded"}>
                  <td>{r.area.levels.length > 1 && i === 0 ? `${t.level} ${li + 1} · ` : ""}{t.areaLine[ln.key]}</td>
                  <td className="num">{f.num(ln.sqm)} {t.sqm}</td>
                  <td />
                </tr>
              ))
            ))
          )}
          <tr className="subtotal"><td>{t.area91Total}</td><td className="num">{f.num(r.area.total)} {t.sqm}</td><td /></tr>
          {r.addOns.map((a, i) => (
            <tr key={"a" + i}>
              <td>
                {t.addOnType[a.addOn.type]}
                {a.addOn.type !== "parking" ? ` · ${f.num(a.addOn.area ?? 0)} ${t.sqm}` : ` · ${a.addOn.count ?? 1}`}
                {a.note && <em className="note"> ({t.noteOpt[a.note]})</em>}
              </td>
              <td className="num">
                {a.fixedNis ? f.nis(a.fixedNis) : `${f.num(a.equivalentSqm)} ${t.eqSqm}`}
              </td>
              <td className="num muted">{a.coefficientUsed !== null ? `× ${a.coefficientUsed}` : t.fixedValue}</td>
            </tr>
          ))}
          <tr className="total"><td>{t.eqTotal}</td><td className="num">{f.num(r.equivalentArea)} {t.sqm}</td><td /></tr>
        </tbody>
      </table>
      <p className="muted small">{t.configNote(r.configVersion)}</p>
    </Card>
  );
}

export function CompsTable({ r }: { r: ValuationResult }) {
  const { t, f } = useT();
  const c = r.comparables;
  return (
    <Card title={t.comps} className="wide-card">
      <div className="table-scroll">
        <table className="comps">
          <thead>
            <tr>
              {(["date", "address", "rooms", "area", "floor", "price", "raw", "adj", "adjusted", "dist", "weight"] as const).map((k) => (
                <th key={k} className={["date", "address", "adj"].includes(k) ? "" : "num"}>{t.compCols[k]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.used.map((x) => (
              <tr key={x.deal.id}>
                <td>{f.date(x.deal.date)}</td>
                <td><bdi>{x.deal.address.street} {x.deal.address.number}</bdi>{x.deal.newBuild ? " ●" : ""}</td>
                <td className="num">{x.deal.rooms}</td>
                <td className="num">{x.deal.area}</td>
                <td className="num">{x.deal.floor ?? "—"}{x.deal.floorsInBuilding ? `/${x.deal.floorsInBuilding}` : ""}</td>
                <td className="num">{f.nis(x.deal.price)}</td>
                <td className="num">{f.int(x.rawPpsqm)}</td>
                <td className="adj">
                  {x.adjustments.map((a) => (
                    <span key={a.key} className={"chip " + (a.pct > 0 ? "pos" : a.pct < 0 ? "neg" : "")}>
                      {t.adjKey[a.key]} {f.pct(a.pct)}{a.assumed ? "*" : ""}
                    </span>
                  ))}
                </td>
                <td className="num strong">{f.int(x.adjustedPpsqm)}</td>
                <td className="num">{f.dist(x.distanceM)}</td>
                <td className="num">
                  <span className="bar" style={{ width: `${Math.round(x.weightShare * 100)}%` }} />
                  {Math.round(x.weightShare * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">{t.assumedNote} · {t.rejectedCount(c.rejected.length)}</p>
    </Card>
  );
}

export function MarketPanel({ r }: { r: ValuationResult }) {
  const { t, f } = useT();
  const m = r.market;
  const gap = m.askingPpsqmMedian && r.value ? m.askingPpsqmMedian / r.comparables.ppsqmMedian - 1 : null;
  return (
    <Card title={t.market}>
      <dl className="stats">
        <div><dt>{t.askingMedian}</dt><dd>{m.askingPpsqmMedian ? f.nis(Math.round(m.askingPpsqmMedian)) : t.none}</dd></div>
        <div><dt>{t.vsValue}</dt><dd>{gap !== null ? f.pct(gap) : "—"}</dd></div>
        <div><dt>{t.saleToAsk}</dt><dd>{m.saleToAskDiscount !== null ? f.pct(m.saleToAskDiscount) : "—"}</dd></div>
        <div><dt>{t.dom}</dt><dd>{m.medianDaysOnMarket ?? "—"}</dd></div>
        <div><dt>{t.activeListings}</dt><dd>{m.activeListings.length}</dd></div>
      </dl>
      <h4>{t.priorSales}</h4>
      {m.priorSales.length ? (
        <ul className="timeline">
          {m.priorSales.map((s) => {
            const years = monthsBetween(s.date, r.valuationDate) / 12;
            const growth = r.value && years > 0 ? Math.pow(r.value.point / s.price, 1 / years) - 1 : null;
            return (
              <li key={s.id}>
                <b>{f.date(s.date)}</b> · {f.nis(s.price)}
                {growth !== null && <span className="muted"> · {t.annualGrowth}: {f.pct(growth)}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">{t.none}</p>
      )}
    </Card>
  );
}

export function BlendPanel({ r }: { r: ValuationResult }) {
  const { t, f } = useT();
  const le = r.listingEvidence;
  if (!r.valueDealsOnly) return null;
  const w = le?.blendWeight ?? 0;
  const rows = [
    { label: t.blendDeals, ppsqm: r.comparables.ppsqmMedian, n: r.comparables.used.length, w: 1 - w },
    ...(le ? [{ label: t.blendListings, ppsqm: le.ppsqmMedian, n: le.items.length, w }] : []),
  ];
  return (
    <Card title={t.blendTitle}>
      <table>
        <thead><tr><th /><th className="num">₪/{t.sqm}</th><th className="num">n</th><th className="num">{t.blendWeight}</th></tr></thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.label}>
              <td>{x.label}</td>
              <td className="num">{f.int(x.ppsqm)}</td>
              <td className="num">{x.n}</td>
              <td className="num"><span className="bar" style={{ width: `${Math.round(x.w * 40)}px` }} />{Math.round(x.w * 100)}%</td>
            </tr>
          ))}
          <tr className="total"><td>{t.blendFinal}</td><td className="num">{f.int(r.ppsqm ?? r.comparables.ppsqmMedian)}</td><td /><td /></tr>
        </tbody>
      </table>
      <p className="muted small">{le ? t.blendExplain : t.noCalibration}</p>
    </Card>
  );
}

export function ListingsPanel({ r }: { r: ValuationResult }) {
  const { t, f } = useT();
  const le = r.listingEvidence;
  const pairs = r.market.recentPairs;
  return (
    <Card title={t.sections.listings} className="wide-card">
      <h4>{t.pairsTitle}</h4>
      {pairs.length ? (
        <>
          <p className="muted small">{t.pairsNote(r.market.matchedCount)}</p>
          <div className="table-scroll">
            <table className="comps">
              <thead>
                <tr>
                  <th>{t.pairCols.date}</th><th>{t.pairCols.address}</th><th>{t.pairCols.source}</th>
                  <th className="num">{t.pairCols.first}</th><th className="num">{t.pairCols.last}</th><th className="num">{t.pairCols.sale}</th>
                  <th className="num">{t.pairCols.ratio}</th><th className="num">{t.pairCols.dom}</th><th className="num">{t.pairCols.cuts}</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((p) => (
                  <tr key={p.deal.id}>
                    <td>{f.date(p.deal.date)}</td>
                    <td><bdi>{p.deal.address.street} {p.deal.address.number}</bdi> {p.deal.floor !== undefined ? ` · ${t.floor} ${p.deal.floor}` : ""}</td>
                    <td>{p.listing.source}</td>
                    <td className="num">{f.nis(p.firstAsk)}</td>
                    <td className="num">{f.nis(p.lastAsk)}</td>
                    <td className="num strong">{f.nis(p.salePrice)}</td>
                    <td className="num"><span className={"chip " + (p.saleToLastAsk < 1 ? "neg" : "pos")}>{f.pct(p.saleToLastAsk - 1)}</span></td>
                    <td className="num">{p.daysOnMarket}</td>
                    <td className="num">{p.priceCuts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="muted">{t.noCalibration}</p>
      )}
      {le && (
        <>
          <h4>{t.calTitle}</h4>
          <p className="muted small">{t.calNote(le.model.saleToAsk.toFixed(3), le.model.areaRatio.toFixed(3))}</p>
          <div className="table-scroll">
            <table className="comps">
              <thead>
                <tr>
                  <th>{t.calCols.address}</th><th className="num">{t.calCols.days}</th><th className="num">{t.calCols.ask}</th>
                  <th className="num">{t.calCols.ratio}</th><th className="num">{t.calCols.expected}</th><th className="num">{t.calCols.area}</th>
                  <th>{t.compCols.adj}</th><th className="num">{t.calCols.ppsqm}</th><th className="num">{t.compCols.dist}</th>
                </tr>
              </thead>
              <tbody>
                {le.items.map((x) => (
                  <tr key={x.item.listing.id}>
                    <td><bdi>{x.item.listing.address.street} {x.item.listing.address.number}</bdi>{x.item.listing.floor !== undefined ? ` · ${t.floor} ${x.item.listing.floor}` : ""} · {x.item.listing.rooms} {t.rooms}</td>
                    <td className="num">{x.item.daysListed}</td>
                    <td className="num">{f.nis(x.item.listing.askingPrice)}</td>
                    <td className="num">× {x.item.ratioUsed.toFixed(3)}</td>
                    <td className="num strong">{f.nis(x.item.expectedPrice)}</td>
                    <td className="num">{f.iso(`${x.item.listing.area} → ${x.item.expectedArea}`)}</td>
                    <td className="adj">
                      {x.adjustments.map((a) => (
                        <span key={a.key} className={"chip " + (a.pct > 0 ? "pos" : a.pct < 0 ? "neg" : "")}>
                          {t.adjKey[a.key]} {f.pct(a.pct)}{a.assumed ? "*" : ""}
                        </span>
                      ))}
                    </td>
                    <td className="num strong">{f.int(x.adjustedPpsqm)}</td>
                    <td className="num">{f.dist(x.distanceM)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

export function TransportPanel({ r }: { r: ValuationResult }) {
  const { t, f } = useT();
  const tr = r.transport;
  return (
    <Card title={t.transport}>
      <div className="score-row">
        <div className="score"><b>{tr.score}</b><span>/100</span></div>
        <div className="muted small">{t.transportScore}</div>
      </div>
      <ul className="plain">
        {tr.nearest.map((n) => (
          <li key={n.mode}>
            <b>{t.mode[n.mode]}</b> · <bdi>{n.stop.name}</bdi> · {t.walk(Math.round(n.walkMin))} · {f.iso(`${n.stop.peakDeparturesPerHour}/h`)}
          </li>
        ))}
      </ul>
      <h4>{t.future}</h4>
      <table>
        <thead>
          <tr>
            <th>{t.futureCols.line}</th><th>{t.futureCols.maturity}</th><th>{t.futureCols.station}</th><th className="num">{t.futureCols.dist}</th><th>{t.futureCols.effect}</th>
          </tr>
        </thead>
        <tbody>
          {tr.future.map((x) => (
            <tr key={x.line.id}>
              <td>{x.line.name}{x.line.expectedOpening ? <div className="muted small">{x.line.expectedOpening}</div> : null}</td>
              <td><span className={"pill m-" + x.line.maturity}>{t.maturity[x.line.maturity]}</span></td>
              <td><bdi>{x.station.name}</bdi></td>
              <td className="num">{f.dist(x.distanceM)}</td>
              <td>
                {t.treatment[x.treatment]}
                {x.inDensificationArea && <div className="tag">{t.densification}</div>}
                {x.expropriationRisk && <div className="tag warn">{t.expropriation}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function RenewalPanel({ r }: { r: ValuationResult }) {
  const { t, f } = useT();
  const p = r.renewal.potential;
  const pol = r.renewal.policy;
  return (
    <Card title={t.renewal}>
      <div className="score-row">
        <span className={"badge pot-" + p.level}>{t.potentialOpt[p.level]}</span>
        <span className="muted small">{t.potential}</span>
      </div>
      <ul className="reasons">
        {p.reasons.map((x) => (
          <li key={x.key} className={x.points >= 0 ? "pos" : "neg"}>
            {x.points > 0 ? "+" : ""}{x.points} · {t.reason[x.key]}
          </li>
        ))}
      </ul>
      {pol && <p className="small"><b>{t.policy}:</b> {t.policyText(pol.hasBuildingRenewalPlan, pol.hasRenewalPolicy, pol.renewalLevyPercent)}</p>}
      <h4>{t.nearby(r.renewal.radiusM)}</h4>
      <table>
        <thead>
          <tr>
            <th>{t.nearbyCols.project}</th><th>{t.nearbyCols.stage}</th><th className="num">{t.nearbyCols.existing}</th><th className="num">{t.nearbyCols.planned}</th><th className="num">{t.nearbyCols.floors}</th><th className="num">{t.nearbyCols.dist}</th><th>{t.nearbyCols.source}</th>
          </tr>
        </thead>
        <tbody>
          {r.renewal.nearby.map((x) => (
            <tr key={x.projectKey}>
              <td><bdi>{x.label}</bdi></td>
              <td>
                {t.stage[x.stage]}
                {x.unconfirmed && <span className="tag warn"> {t.unconfirmed}</span>}
              </td>
              <td className="num">{x.unitsExisting ?? "—"}</td>
              <td className="num">{x.unitsPlanned ?? "—"}</td>
              <td className="num">{x.plannedFloors ?? "—"}</td>
              <td className="num">{f.dist(x.distanceM)}</td>
              <td className="small">
                {x.bestSignal.source.label} · {f.date(x.bestSignal.date)}
                <div className="muted">{t.reliability[SIGNAL_RELIABILITY[x.bestSignal.type]]}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function Disclaimer({ role }: { role: Role }) {
  const { t } = useT();
  return <p className="disclaimer">{role === "realtor" ? t.disclaimerRealtor : t.disclaimer}</p>;
}
