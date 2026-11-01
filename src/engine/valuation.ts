import { area91, type Area91Result } from "./area";
import { configFor, valueAddOn, type AddOnLine, type ValuationConfig } from "./coefficients";
import { selectComparables, type ComparablesOutcome } from "./comparables";
import { analyseTransport, type TransportResult } from "./location";
import { marketContext, parcelKeyOf, type MarketContext } from "./market";
import { matchListingsToDeals, type MatchedPair } from "./matching";
import { buildCalibration, calibrateListings } from "./askCalibration";
import { buildListingEvidence, type ListingEvidence } from "./listingEvidence";
import { distanceM } from "./geo";
import { isInDeclaredComplex, nearbyProjects, renewalPotential, type RenewalResult } from "./renewal";
import { round } from "./stats";
import type { Subject } from "./types";
import type { DataProvider } from "../data/provider";

export interface ValuationResult {
  valuationDate: string;
  configVersion: string;
  dataSource: { id: string; isDemo: boolean };
  area: Area91Result;
  addOns: AddOnLine[];
  equivalentArea: number;
  fixedValueNis: number;
  comparables: ComparablesOutcome;
  /** Final estimate: deals blended with calibrated adverts when the evidence supports it. */
  value: { point: number; low: number; high: number } | null;
  /** Estimate from completed deals alone, always shown for transparency. */
  valueDealsOnly: { point: number; low: number; high: number } | null;
  /** Calibrated unsold adverts and the blend weight given to them (null if not enough data). */
  listingEvidence: ListingEvidence | null;
  /** Final blended price per equivalent sqm. */
  ppsqm: number | null;
  market: MarketContext;
  transport: TransportResult;
  renewal: RenewalResult;
  warnings: Warning[];
}

export type Warning =
  | { key: "insufficient_comparables" }
  | { key: "unpermitted_addons"; count: number }
  | { key: "assigned_addons"; count: number }
  | { key: "condition_assumed" }
  | { key: "expropriation_risk"; line: string }
  | { key: "declared_area_used" }
  | { key: "listings_disagree"; gap: number };

/** Run a full valuation for a subject property against a data provider. */
export async function valuate(
  subject: Subject,
  provider: DataProvider,
  valuationDate: string,
): Promise<ValuationResult> {
  const city = subject.address.city;
  const cfg: ValuationConfig = configFor(await provider.getCityConfig(city));
  const maxR = Math.max(...cfg.comparables.radiiM);
  const since = new Date(valuationDate);
  since.setUTCMonth(since.getUTCMonth() - cfg.comparables.maxMonths);
  const q = { center: subject.location, radiusM: maxR, city };

  const fullKey = subject.parcel ? parcelKeyOf(subject.parcel) : undefined;
  const [deals, unitHistory, listings, index, stops, lines, signals, policy, storedPairs] = await Promise.all([
    provider.getDeals({ ...q, sinceIso: since.toISOString().slice(0, 10) }),
    fullKey ? provider.getUnitHistory(fullKey) : Promise.resolve([]),
    provider.getListings(q),
    provider.getPriceIndex(city),
    provider.getTransitStops({ ...q, radiusM: 2000 }),
    provider.getFutureLines(city),
    provider.getRenewalSignals({ ...q, radiusM: 1000 }),
    provider.getCityPolicy(city),
    provider.getMatchedPairs ? provider.getMatchedPairs({ ...q, sinceIso: since.toISOString().slice(0, 10) }) : Promise.resolve(null),
  ]);

  // 1. Area per Standard 9.1 and equivalent area from add-ons.
  const area = area91(subject.area);
  const addOns = subject.addOns.map((a) => valueAddOn(a, cfg));
  const equivalentArea = round(area.total + addOns.reduce((s, l) => s + l.equivalentSqm, 0), 0.01);
  const fixedValueNis = addOns.reduce((s, l) => s + l.fixedNis, 0);

  // 2. Comparables (completed deals only).
  const comparables = selectComparables(subject, deals, valuationDate, index, cfg);
  const toValue = (mid: number, lo: number, hi: number) => ({
    point: round(mid * equivalentArea + fixedValueNis, 10_000),
    low: round(lo * equivalentArea + fixedValueNis, 10_000),
    high: round(hi * equivalentArea + fixedValueNis, 10_000),
  });
  const valueDealsOnly =
    comparables.confidence === "insufficient"
      ? null
      : toValue(comparables.ppsqmMedian, comparables.ppsqmP25, comparables.ppsqmP75);

  // 3. Asking-price calibration: match past adverts to the deals they became, learn the
  //    sale-to-ask gap and area gap, then apply it to today's unsold adverts.
  const pairs: MatchedPair[] = storedPairs ?? matchListingsToDeals(deals, listings).pairs;
  const model = buildCalibration(subject.location, pairs, valuationDate, { radiusM: 1000, windowMonths: 18, shrinkK: 12 });
  const evidenceRadius = Math.max(comparables.radiusM, 600);
  const activeNear = listings.filter(
    (l) => l.status === "active" && distanceM(subject.location, l.location) <= evidenceRadius && Math.abs(l.rooms - subject.rooms) <= 1,
  );
  const listingEv =
    model && valueDealsOnly
      ? buildListingEvidence(subject, model, calibrateListings(model, activeNear, valuationDate), comparables, valuationDate, index, cfg)
      : null;

  let ppsqm: number | null = null;
  let value = valueDealsOnly;
  if (valueDealsOnly) {
    const w = listingEv?.blendWeight ?? 0;
    const mix = (d: number, l: number | undefined) => (1 - w) * d + w * (l ?? d);
    ppsqm = mix(comparables.ppsqmMedian, listingEv?.ppsqmMedian);
    value = toValue(ppsqm, mix(comparables.ppsqmP25, listingEv?.ppsqmP25), mix(comparables.ppsqmP75, listingEv?.ppsqmP75));
  }

  // 4. Market context: asking prices, sale-to-ask gap, days on market, prior sales of this unit.
  const marketRadius = Math.max(comparables.radiusM, 1000);
  const market = marketContext(subject.location, listings, valuationDate, marketRadius, model, unitHistory);

  // 4. Transport today and planned.
  const plotKey = subject.parcel ? `${subject.parcel.block}-${subject.parcel.parcel}` : undefined;
  const transport = analyseTransport(subject.location, stops, lines, plotKey);

  // 5. Urban renewal: own potential and nearby activity.
  const nearMetro = transport.future.some((f) => f.inDensificationArea);
  const inComplex = isInDeclaredComplex(subject.location, signals);
  const renewal: RenewalResult = {
    potential: renewalPotential(subject, Number(valuationDate.slice(0, 4)), {
      inDeclaredComplex: inComplex,
      nearMetro,
      policy,
    }),
    nearby: nearbyProjects(subject.location, signals, 500),
    radiusM: 500,
    policy,
  };

  // 6. Warnings shown at the top of the report.
  const warnings: Warning[] = [];
  if (!value) warnings.push({ key: "insufficient_comparables" });
  const unpermitted = subject.addOns.filter((a) => !a.permitted).length;
  if (unpermitted) warnings.push({ key: "unpermitted_addons", count: unpermitted });
  const assigned = subject.addOns.filter((a) => a.attachment === "assigned").length;
  if (assigned) warnings.push({ key: "assigned_addons", count: assigned });
  if (comparables.used.some((c) => c.adjustments.some((a) => a.assumed))) warnings.push({ key: "condition_assumed" });
  for (const f of transport.future) if (f.expropriationRisk) warnings.push({ key: "expropriation_risk", line: f.line.name });
  if (area.method === "declared") warnings.push({ key: "declared_area_used" });
  if (listingEv && Math.abs(listingEv.gapVsDeals) > 0.08) warnings.push({ key: "listings_disagree", gap: listingEv.gapVsDeals });

  return {
    valuationDate,
    configVersion: cfg.version,
    dataSource: { id: provider.id, isDemo: provider.isDemo },
    area,
    addOns,
    equivalentArea,
    fixedValueNis,
    comparables,
    value,
    valueDealsOnly,
    listingEvidence: listingEv,
    ppsqm,
    market,
    transport,
    renewal,
    warnings,
  };
}
