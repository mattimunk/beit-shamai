import type { ReactNode } from "react";
import type { Subject } from "../engine/types";
import type { ValuationResult } from "../engine/valuation";
import { DEFAULT_CONFIG } from "../engine/coefficients";
import { distanceM } from "../engine/geo";
import { REPORT_TEXT, type Tier } from "../i18n/reportText";
import { englishNis, hebrewNis } from "../i18n/numberWords";
import { useT } from "./context";
import type { DocumentFacts, DocumentRecord } from "../data/documents";
import { MapView } from "./MapView";

export interface ReportMeta {
  client: string;
  purpose: string;
  fileNo: string;
  visitDate: string; // "" = no site visit
  inspector: string;
  visitMethod: string;
  appraiserName: string;
  licence: string;
}

const ADJ_KEYS = ["time", "floor", "age", "condition", "view", "new_build", "rights"] as const;

/**
 * The report in the format Israeli appraisers use: letterhead, "to / re" block, numbered
 * chapters following the regulations' mandatory contents, comparables with excluded deals
 * and reasons, coefficients, lettered considerations, step-by-step calculation, the
 * conventional conclusion with the amount in words, and declaration / signature.
 */
export function ShumaReport({
  r, subject: s, tier, meta, docs, facts,
}: { r: ValuationResult; subject: Subject; tier: Tier; meta: ReportMeta; docs: DocumentRecord[]; facts: DocumentFacts }) {
  const { t, f, lang } = useT();
  const T = REPORT_TEXT[lang];
  const rightsWord = T.rights[s.rights];
  const addr = `${s.address.street} ${s.address.number}, ${s.address.city}`;
  const parcel = s.parcel ? `${T.identRows.block} ${s.parcel.block} ${T.identRows.parcel} ${s.parcel.parcel}${s.parcel.subParcel ? ` ${T.identRows.sub} ${s.parcel.subParcel}` : ""}` : "";
  const c = r.comparables;
  const isSurvey = tier === "realtor";
  const le = r.listingEvidence;
  const words = (n: number) => (lang === "he" ? hebrewNis(n) : englishNis(n));
  const letter = (i: number) => (lang === "he" ? hebrewLetterNumber(i + 1) : String.fromCharCode(97 + i));

  // Chapter list (numbers are positional so the table of contents always matches).
  const chapters: { key: keyof typeof T.ch; body: ReactNode }[] = [];
  const add = (key: keyof typeof T.ch, body: ReactNode) => chapters.push({ key, body });

  add("purpose", <p>{T.purpose[tier](rightsWord, meta.purpose)}</p>);

  add("dates", (
    <>
      <p>{T.valuationDate(f.date(r.valuationDate))}</p>
      <p>{meta.visitDate ? T.visited(f.date(meta.visitDate), meta.inspector || "—", meta.visitMethod) : T.notVisited}</p>
    </>
  ));

  add("documents", docs.length ? (
    <>
      <p>{T.docsIntro}</p>
      <ol className="plain-ol">
        {docs.map((d) => (
          <li key={d.id}>
            {T.docLine(t.docs.kind[d.kind], typeof d.fields.date === "string" && d.fields.date ? f.date(d.fields.date) : "", "")}
            <span className="file-name"> <bdi dir="auto">{d.fileName}</bdi></span>
          </li>
        ))}
      </ol>
    </>
  ) : <p>{T.docsNone}</p>);

  add("ident", (
    <table className="kv">
      <tbody>
        <tr><th>{T.identRows.block}</th><td>{s.parcel?.unsettled ? T.unsettled : s.parcel?.block ?? "—"}</td><th>{T.identRows.parcel}</th><td>{s.parcel?.parcel ?? "—"}</td><th>{T.identRows.sub}</th><td>{s.parcel?.subParcel ?? "—"}</td></tr>
        <tr><th>{T.identRows.address}</th><td colSpan={3}><bdi>{addr}</bdi></td><th>{T.identRows.floor}</th><td>{s.floor}</td></tr>
        <tr><th>{T.identRows.type}</th><td colSpan={3}>{T.propType}</td><th>{T.identRows.rights}</th><td>{rightsWord}</td></tr>
      </tbody>
    </table>
  ));

  const dirs = s.directions.map((d) => t.dirOpt[d]).join(", ");
  add("desc", (
    <>
      <h4>{T.descEnv}</h4>
      <p><bdi>{T.envText(s.address.city, s.address.neighborhood ?? "")}</bdi></p>
      {r.transport.nearest.length ? (
        <ul>
          {r.transport.nearest.map((n) => (
            <li key={n.mode}><bdi>{T.transitText(t.mode[n.mode], n.stop.name.replace(/^תחנת\s+/, ""), Math.round(n.walkMin), n.stop.peakDeparturesPerHour)}</bdi></li>
          ))}
        </ul>
      ) : <p>{T.noTransit}</p>}
      <h4>{T.descBuilding}</h4>
      <p>{T.buildingText(s.floorsInBuilding, s.yearBuilt, s.elevator)}</p>
      <h4>{T.descUnit}</h4>
      <p>{T.unitText(s.rooms, s.floor, dirs, t.conditionOpt[s.condition], s.hasSafeRoom)}</p>
      <h4>{T.descArea}</h4>
      <table className="grid-table">
        <tbody>
          {r.area.levels.flatMap((lv, li) =>
            lv.lines.map((ln, i) => (
              <tr key={`${li}-${i}`} className={ln.counted ? "" : "excluded"}>
                <td>{r.area.levels.length > 1 && i === 0 ? `${t.level} ${li + 1} · ` : ""}{t.areaLine[ln.key]}</td>
                <td className="num">{f.num(ln.sqm)} {t.sqm}</td>
              </tr>
            )),
          )}
          <tr className="subtotal"><td>{r.area.method === "declared" ? t.declaredUsed : t.area91Total}</td><td className="num">{f.num(r.area.total)} {t.sqm}</td></tr>
          {r.addOns.map((a, i) => (
            <tr key={"a" + i}>
              <td>{t.addOnType[a.addOn.type]}{a.addOn.type === "parking" ? ` × ${a.addOn.count ?? 1}` : ""} · {t.attachment[a.addOn.attachment]}{a.addOn.permitted ? "" : ` · ${lang === "he" ? "ללא היתר" : "unpermitted"}`}</td>
              <td className="num">{a.addOn.type === "parking" ? "—" : `${f.num(a.addOn.area ?? 0)} ${t.sqm}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  ));

  const plans = r.renewal.nearby.filter((p) => p.signals.some((x) => x.type === "plan" || x.type === "declared_complex"));
  const unpermitted = r.addOns.filter((a) => !a.addOn.permitted && a.addOn.type !== "parking");
  add("planning", (
    <>
      <p>{T.planningIntro}</p>
      {plans.length ? (
        <ul>{plans.map((p) => <li key={p.projectKey}><bdi>{T.planRow(p.label, t.stage[p.stage], f.dist(p.distanceM))}</bdi></li>)}</ul>
      ) : <p>{T.planningNone}</p>}
      {r.transport.future.length > 0 && (
        <ul>{r.transport.future.map((x) => <li key={x.line.id}><bdi>{T.futureRow(x.line.name, t.maturity[x.line.maturity], x.station.name, f.dist(x.distanceM))}</bdi></li>)}</ul>
      )}
      {r.transport.future.some((x) => x.inDensificationArea) && <p>{T.tama70}</p>}
      {r.transport.future.filter((x) => x.expropriationRisk).map((x) => <p key={x.line.id} className="warn-text">{T.expropriation(x.line.name)}</p>)}
      {facts.permit ? <p>{T.permitSeen(facts.permit.permitNo ?? "", facts.permit.date ? f.date(facts.permit.date) : "")}{facts.permit.notes ? ` ${facts.permit.notes}` : ""}</p> : <p>{T.permitsIntro}</p>}
      {facts.form4Date !== undefined && <p>{T.form4Seen(facts.form4Date ? f.date(facts.form4Date) : "")}</p>}
      {facts.planAreas.map((p, i) => <p key={i}>{T.planAreaSeen(t.docs.planType[p.planType as keyof typeof t.docs.planType] ?? p.planType, p.area)}</p>)}
      {facts.arnonaArea && <p>{T.arnonaSeen(facts.arnonaArea)}</p>}
      {unpermitted.map((a, i) => <p key={i} className="warn-text">{T.unpermitted(t.addOnType[a.addOn.type], a.addOn.area ?? 0)}</p>)}
    </>
  ));

  add("legal", (
    <>
      {facts.registry ? (
        <>
          <p>{T.registryText(facts.registry.date ? f.date(facts.registry.date) : "", rightsWord, facts.registry.registeredArea ? String(facts.registry.registeredArea) : "")}</p>
          {facts.registry.mortgage && <p>{T.registryMortgage}</p>}
          {facts.registry.caveat && <p className="warn-text">{T.registryCaveat}</p>}
          {!facts.registry.mortgage && !facts.registry.caveat && <p>{T.registryClean}</p>}
          {facts.registry.notes && <p>{facts.registry.notes}</p>}
        </>
      ) : <p>{T.legalText(rightsWord)}</p>}
      {facts.engineerNotes && <p>{T.engineerSeen(facts.engineerNotes)}</p>}
      {facts.priorAppraisals.map((p, i) => <p key={i}>{T.priorAppraisalSeen(p.date ? f.date(p.date) : "", p.value ? f.nis(p.value) : "")}</p>)}
      {r.addOns.filter((a) => a.addOn.attachment === "assigned").map((a, i) => <p key={i}>{T.assignedNote(t.addOnType[a.addOn.type])}</p>)}
      {r.market.priorSales.length > 0 && (
        <>
          <p>{T.priorSales}</p>
          <ul>{r.market.priorSales.map((d) => <li key={d.id}>{f.date(d.date)} – {f.nis(d.price)}</li>)}</ul>
        </>
      )}
    </>
  ));

  const months = DEFAULT_CONFIG.comparables.maxMonths;
  const excluded = c.rejected
    .filter((x) => x.reason !== "too_old" && x.reason !== "too_far")
    .map((x) => ({ ...x, d: distanceM(s.location, x.deal.location) }))
    .sort((a, b) => a.d - b.d);
  add("data", (
    <>
      <h4>{T.dataSelected}</h4>
      <p>{T.dataIntro(c.used.length, months, c.radiusM)}</p>
      <div className="table-scroll">
        <table className="grid-table compact">
          <thead>
            <tr>
              <th>{T.cols.n}</th><th>{T.cols.date}</th><th>{T.cols.address}</th><th>{T.cols.gush}</th>
              <th className="num">{T.cols.rooms}</th><th className="num">{T.cols.floor}</th><th className="num">{T.cols.area}</th>
              <th className="num">{T.cols.price}</th><th className="num">{T.cols.ppsqm}</th>
              {ADJ_KEYS.map((k) => <th key={k} className="num">{T.adjCols[k]}</th>)}
              <th className="num">{T.cols.adjusted}</th><th className="num">{T.cols.weight}</th>
            </tr>
          </thead>
          <tbody>
            {c.used.map((x, i) => (
              <tr key={x.deal.id}>
                <td>{i + 1}</td>
                <td>{f.dnum(x.deal.date)}</td>
                <td><bdi>{x.deal.address.street} {x.deal.address.number}</bdi></td>
                <td>{x.deal.parcel ? `${x.deal.parcel.block}/${x.deal.parcel.parcel}` : "—"}</td>
                <td className="num">{x.deal.rooms}</td>
                <td className="num">{x.deal.floor}</td>
                <td className="num">{x.deal.area}</td>
                <td className="num">{f.int(x.deal.price)}</td>
                <td className="num">{f.int(x.rawPpsqm)}</td>
                {ADJ_KEYS.map((k) => {
                  const a = x.adjustments.find((y) => y.key === k);
                  return <td key={k} className="num">{a ? `${f.pct(a.pct)}${a.assumed ? "*" : ""}` : "—"}</td>;
                })}
                <td className="num strong">{f.int(x.adjustedPpsqm)}</td>
                <td className="num">{Math.round(x.weightShare * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">{T.assumed}</p>
      <h4>{T.dataExcluded}</h4>
      {excluded.length ? (
        <table className="grid-table compact">
          <thead><tr><th>{T.cols.date}</th><th>{T.cols.address}</th><th className="num">{T.cols.area}</th><th className="num">{T.cols.price}</th><th className="num">{T.cols.dist}</th><th>{T.cols.reason}</th></tr></thead>
          <tbody>
            {excluded.map((x) => (
              <tr key={x.deal.id}>
                <td>{f.dnum(x.deal.date)}</td>
                <td><bdi>{x.deal.address.street} {x.deal.address.number}</bdi></td>
                <td className="num">{x.deal.area}</td>
                <td className="num">{f.int(x.deal.price)}</td>
                <td className="num">{f.dist(x.d)}</td>
                <td>{T.excludedReason[x.reason]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>{T.excludedNone}</p>}
      {le && (
        <>
          <h4>{T.dataAsking}</h4>
          <p>{T.askingIntro(le.model.localN, f.pct(1 - le.model.saleToAsk, false), f.pct(le.model.areaRatio, false))}</p>
          <table className="grid-table compact">
            <thead><tr><th>{T.cols.address}</th><th className="num">{t.calCols.days}</th><th className="num">{t.calCols.ask}</th><th className="num">{t.calCols.expected}</th><th className="num">{t.calCols.area}</th><th className="num">{T.cols.adjusted}</th></tr></thead>
            <tbody>
              {le.items.map((x) => (
                <tr key={x.item.listing.id}>
                  <td><bdi>{x.item.listing.address.street} {x.item.listing.address.number}</bdi></td>
                  <td className="num">{x.item.daysListed}</td>
                  <td className="num">{f.int(x.item.listing.askingPrice)}</td>
                  <td className="num">{f.int(x.item.expectedPrice)}</td>
                  <td className="num">{f.iso(`${x.item.listing.area} → ${x.item.expectedArea}`)}</td>
                  <td className="num">{f.int(x.adjustedPpsqm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  ));

  const a = DEFAULT_CONFIG.adjustments;
  add("coef", (
    <>
      <p>{T.coefIntro}</p>
      <table className="grid-table compact">
        <thead><tr><th>{T.coefCols.item}</th><th>{T.coefCols.basis}</th><th className="num">{T.coefCols.coef}</th><th>{T.coefCols.note}</th></tr></thead>
        <tbody>
          {r.addOns.map((x, i) => (
            <tr key={i}>
              <td>{t.addOnType[x.addOn.type]}</td>
              <td>{x.addOn.type === "parking" ? t.fixedValue : `${f.num(x.addOn.area ?? 0)} ${t.sqm}`}</td>
              <td className="num">{x.coefficientUsed !== null ? x.coefficientUsed : f.nis(x.fixedNis)}</td>
              <td>{x.note ? t.noteOpt[x.note] : ""}</td>
            </tr>
          ))}
          <tr><td>{T.rates.floor}</td><td /><td className="num">{f.pct(a.perFloorWithElevator)}</td><td /></tr>
          <tr><td>{T.rates.floorNoElev}</td><td /><td className="num">{f.pct(a.perFloorNoElevatorAbove2)}</td><td /></tr>
          <tr><td>{T.rates.ground}</td><td /><td className="num">{f.pct(a.groundFloor)}</td><td /></tr>
          <tr><td>{T.rates.decade}</td><td /><td className="num">{f.pct(a.perDecadeAge)}</td><td /></tr>
          <tr><td>{T.rates.cond}</td><td /><td className="num">{(Object.keys(a.condition) as (keyof typeof a.condition)[]).map((k) => `${t.conditionOpt[k]} ${f.pct(a.condition[k])}`).join(" · ")}</td><td /></tr>
          <tr><td>{T.rates.newBuild}</td><td /><td className="num">{f.pct(a.newBuildPremium)}</td><td /></tr>
        </tbody>
      </table>
      <p className="small">{T.coefNote(r.configVersion)}</p>
    </>
  ));

  const P = T.principles;
  const considerations: string[] = [
    P.approach(c.used.length, months, c.radiusM),
    r.area.method === "measured" ? P.area91 : P.areaDeclared(t.declaredSourceOpt[(r.area.declaredSource ?? "user") as keyof typeof t.declaredSourceOpt]),
    P.equivalent,
    P.adjustments(f.pct(DEFAULT_CONFIG.comparables.maxGrossAdjustment, false)),
    ...(c.used.some((x) => x.adjustments.some((y) => y.assumed)) ? [P.assumed] : []),
    P.weighting,
    le ? P.asking(le.items.length, le.model.localN, `${Math.round(le.blendWeight * 100)}%`) : P.askingOff,
    ...(unpermitted.length ? [P.unpermitted] : []),
    ...(r.income ? [T.incomeCheck(f.nis(r.income.rentMonthly), f.pct(r.income.grossYield, false), f.pct(r.income.typicalRange[0], false), f.pct(r.income.typicalRange[1], false), r.income.withinRange)] : []),
    ...(r.transport.nearest.length ? [P.location(r.transport.score)] : []),
    ...(r.transport.future.length ? [P.futureTransit] : []),
    P.renewal(t.potentialOpt[r.renewal.potential.level]),
    P.assumptions,
    P.sources,
  ];
  add("principles", (
    <ol className="lettered">
      {considerations.map((x, i) => <li key={i}><span className="letter">{letter(i)}.</span> {x}</li>)}
    </ol>
  ));

  if (!isSurvey && r.value && r.ppsqm) {
    const sub = r.ppsqm * r.equivalentArea;
    add("calc", (
      <table className="grid-table calc">
        <tbody>
          <tr><td>{T.calcRows.area}</td><td className="num">{f.num(r.area.total)} {t.sqm}</td></tr>
          <tr><td>{T.calcRows.eq}</td><td className="num">{f.num(r.equivalentArea - r.area.total)} {t.sqm}</td></tr>
          <tr className="subtotal"><td>{T.calcRows.eqTotal}</td><td className="num">{f.num(r.equivalentArea)} {t.sqm}</td></tr>
          <tr><td>{T.calcRows.ppsqm}</td><td className="num">× {f.nis(Math.round(r.ppsqm))}</td></tr>
          <tr className="subtotal"><td>{T.calcRows.sub}</td><td className="num">{f.nis(Math.round(sub))}</td></tr>
          {r.fixedValueNis > 0 && <tr><td>{T.calcRows.parking}</td><td className="num">+ {f.nis(r.fixedValueNis)}</td></tr>}
          <tr><td>{T.calcRows.total}</td><td className="num">{f.nis(Math.round(sub + r.fixedValueNis))}</td></tr>
          <tr className="total"><td>{T.calcRows.rounded}</td><td className="num">{f.nis(r.value.point)}</td></tr>
        </tbody>
      </table>
    ));
    add("value", (
      <>
        <p>{T.conclusion(rightsWord)}</p>
        <div className="final-value">{f.nis(r.value.point)}</div>
        <p className="center">({T.inWords}: {words(r.value.point)})</p>
        <p className="small">{T.rangeLine(f.nis(r.value.low), f.nis(r.value.high))}</p>
      </>
    ));
  } else if (isSurvey) {
    add("surveySummary", <p>{T.surveyLine(f.nis(Math.round(c.ppsqmP25)), f.nis(Math.round(c.ppsqmP75)), f.nis(Math.round(c.ppsqmMedian)))}</p>);
  }

  if (tier === "appraiser") {
    add("declaration", (
      <>
        <p>{T.declaration}</p>
        <p className="small">{T.aiNote}</p>
        <div className="signature">
          <div><div className="sig-line" />{T.signature}</div>
          <div><b>{meta.appraiserName || "__________"}</b><br />{T.licence}: {meta.licence || "______"}</div>
        </div>
      </>
    ));
  } else {
    add("disclaimer", <p>{tier === "realtor" ? T.disclaimerRealtor : T.disclaimerBuyer}</p>);
  }

  add("annex", <MapView r={r} center={s.location} stops={r.transport.stopsNearby} listings={r.market.activeListings} />);

  return (
    <article className={"shuma" + (tier === "appraiser" ? " is-draft" : "")} data-draft={T.draft}>
      <header className="letterhead">
        <div className="lh-name">{tier === "appraiser" && meta.appraiserName ? T.appraiserHead(meta.appraiserName, meta.licence) : T.brand}</div>
        <div className="lh-meta">
          <div>{T.date}: {f.date(r.valuationDate)} · {f.hebDate(r.valuationDate)}</div>
          <div>{T.fileNo}: {meta.fileNo}</div>
        </div>
      </header>
      {r.dataSource.isDemo && <div className="demo-strip">{T.demo}</div>}

      <section className="addressee">
        <p><b>{T.to}:</b> {meta.client}</p>
        <p className="re"><b>{T.re}:</b> <u><bdi>{T.reLine(T.kind[tier], addr, parcel)}</bdi></u></p>
        <p className="subtitle">{T.subtitle[tier]}</p>
        <p>{T.intro[tier](meta.client)}</p>
      </section>

      <nav className="toc">
        <h3>{T.toc}</h3>
        <ol>{chapters.map((ch, i) => <li key={ch.key}><span>{i + 1}.</span> {T.ch[ch.key]}</li>)}</ol>
      </nav>

      {chapters.map((ch, i) => (
        <section key={ch.key} className={"chapter ch-" + ch.key}>
          <h2><span className="ch-no">{i + 1}.</span> {T.ch[ch.key]}</h2>
          {ch.body}
        </section>
      ))}
    </article>
  );
}

/** 1 → א, 10 → י, 11 → י״א, 15 → ט״ו, 16 → ט״ז, 20 → כ (Hebrew numbering as used in documents). */
export function hebrewLetterNumber(n: number): string {
  const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const tens = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
  if (n === 15) return "ט״ו";
  if (n === 16) return "ט״ז";
  const t = tens[Math.floor(n / 10) % 10] ?? "";
  const o = ones[n % 10] ?? "";
  const s = t + o;
  return s.length > 1 ? `${s.slice(0, -1)}״${s.slice(-1)}` : s;
}
