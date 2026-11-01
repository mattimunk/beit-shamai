import type { Subject } from "../engine/types";
import type { ValuationResult } from "../engine/valuation";
import { useT, type Role } from "./context";
import { AreaTable, BlendPanel, CompsTable, Disclaimer, ListingsPanel, MarketPanel, RenewalPanel, TransportPanel, Warnings } from "./Panels";

/** Printable report in the order defined by the spec (identification → value → … → disclaimer). */
export function Report({ r, subject, role }: { r: ValuationResult; subject: Subject; role: Role }) {
  const { t, f } = useT();
  const s = subject;
  return (
    <article className="report">
      <header className="report-head">
        <div>
          <div className="eyebrow">{t.appName}</div>
          <h1>{role === "realtor" ? t.titleRealtor : t.titleBuyer}</h1>
          <div className="muted">
            {t.reportDate}: {f.date(r.valuationDate)} · {f.hebDate(r.valuationDate)}
          </div>
        </div>
        {r.dataSource.isDemo && <div className="stamp">{t.demo}</div>}
      </header>

      <section className="report-section">
        <h2>{t.reportIdent}</h2>
        <dl className="ident">
          <div><dt>{t.street}</dt><dd><bdi>{s.address.street} {s.address.number}, {s.address.city}</bdi></dd></div>
          <div><dt>{t.block}</dt><dd>{s.parcel?.block ?? "—"}</dd></div>
          <div><dt>{t.parcel}</dt><dd>{s.parcel?.parcel ?? "—"}</dd></div>
          <div><dt>{t.subParcel}</dt><dd>{s.parcel?.subParcel ?? "—"}</dd></div>
          <div><dt>{t.rights}</dt><dd>{t.rightsOpt[s.rights]}</dd></div>
          <div><dt>{t.rooms}</dt><dd>{s.rooms}</dd></div>
          <div><dt>{t.floor}</dt><dd>{s.floor}/{s.floorsInBuilding}</dd></div>
          <div><dt>{t.yearBuilt}</dt><dd>{s.yearBuilt}</dd></div>
          <div><dt>{t.dataSource}</dt><dd>{r.dataSource.isDemo ? t.demo : r.dataSource.id}</dd></div>
        </dl>
      </section>

      <section className="report-section value-block">
        <h2>{t.value}</h2>
        {r.value ? (
          <>
            <div className="value">{f.nis(r.value.point)}</div>
            <div>{t.range}: {f.nis(r.value.low)} – {f.nis(r.value.high)}</div>
            <div className="muted">
              {f.nis(Math.round(r.ppsqm ?? r.comparables.ppsqmMedian))} {t.perSqm} · {t.confidence}: {t.confidenceOpt[r.comparables.confidence]} · {t.basedOn(r.comparables.used.length, r.comparables.radiusM)}
            </div>
          </>
        ) : (
          <div>{t.warning.insufficient_comparables}</div>
        )}
      </section>

      <Warnings r={r} />
      <AreaTable r={r} />
      <CompsTable r={r} />
      <ListingsPanel r={r} />
      <BlendPanel r={r} />
      <MarketPanel r={r} />
      <TransportPanel r={r} />
      <RenewalPanel r={r} />
      <Disclaimer role={role} />
    </article>
  );
}
