import { area91, type Area91Result } from "./area";
import { configFor, valueAddOn, type AddOnLine, type ValuationConfig } from "./coefficients";
import { selectComparables, type ComparablesOutcome } from "./comparables";
import { analyseTransport, type TransportResult } from "./location";
import { marketContext, parcelKeyOf, type MarketContext } from "./market";
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
  value: { point: number; low: number; high: number } | null;
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
  | { key: "declared_area_used" };

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
  const [deals, unitHistory, listings, index, stops, lines, signals, policy] = await Promise.all([
    provider.getDeals({ ...q, sinceIso: since.toISOString().slice(0, 10) }),
    fullKey ? provider.getUnitHistory(fullKey) : Promise.resolve([]),
    provider.getListings(q),
    provider.getPriceIndex(city),
    provider.getTransitStops({ ...q, radiusM: 2000 }),
    provider.getFutureLines(city),
    provider.getRenewalSignals({ ...q, radiusM: 1000 }),
    provider.getCityPolicy(city),
  ]);

  // 1. Area per Standard 9.1 and equivalent area from add-ons.
  const area = area91(subject.area);
  const addOns = subject.addOns.map((a) => valueAddOn(a, cfg));
  const equivalentArea = round(area.total + addOns.reduce((s, l) => s + l.equivalentSqm, 0), 0.01);
  const fixedValueNis = addOns.reduce((s, l) => s + l.fixedNis, 0);

  // 2. Comparables (completed deals only).
  const comparables = selectComparables(subject, deals, valuationDate, index, cfg);
  const value =
    comparables.confidence === "insufficient"
      ? null
      : {
          point: round(comparables.ppsqmMedian * equivalentArea + fixedValueNis, 10_000),
          low: round(comparables.ppsqmP25 * equivalentArea + fixedValueNis, 10_000),
          high: round(comparables.ppsqmP75 * equivalentArea + fixedValueNis, 10_000),
        };

  // 3. Market context: asking prices, days on market, prior sales of this unit.
  // Market context uses a wider ring than the comparables so asking prices are meaningful.
  const marketRadius = Math.max(comparables.radiusM, 1000);
  const market = marketContext(subject.location, listings, deals, valuationDate, marketRadius, unitHistory);

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
    market,
    transport,
    renewal,
    warnings,
  };
}
