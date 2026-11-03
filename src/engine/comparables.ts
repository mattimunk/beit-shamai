import type { ValuationConfig } from "./coefficients";
import { distanceM } from "./geo";
import { monthsBetween, weightedQuantile } from "./stats";
import type { Condition, Deal, PriceIndexPoint, Subject, ViewQuality } from "./types";

export type AdjustmentKey = "time" | "floor" | "age" | "condition" | "view" | "new_build" | "rights";

export interface AdjustmentLine {
  key: AdjustmentKey;
  /** Fractional adjustment applied to the comparable's price per sqm (0.03 = +3%). */
  pct: number;
  /** True when the comparable's attribute was not in the source data and a default was assumed. */
  assumed?: boolean;
}

export interface ComparableResult {
  deal: Deal;
  distanceM: number;
  ageMonths: number;
  /** Price per equivalent sqm before adjustments (parking removed). */
  rawPpsqm: number;
  /** After time indexation and attribute adjustments. */
  adjustedPpsqm: number;
  adjustments: AdjustmentLine[];
  grossAdjustment: number;
  weight: number;
  /** Share of total weight (0..1). */
  weightShare: number;
  radiusUsedM: number;
}

export interface ComparablesOutcome {
  used: ComparableResult[];
  rejected: { deal: Deal; reason: "too_far" | "too_old" | "over_adjusted" | "outlier" | "beyond_max" | "partial_sale" }[];
  radiusM: number;
  ppsqmMedian: number;
  ppsqmP25: number;
  ppsqmP75: number;
  confidence: "high" | "medium" | "low" | "insufficient";
}

function floorValue(floor: number, elevator: boolean, cfg: ValuationConfig): number {
  const a = cfg.adjustments;
  if (floor <= 0) return a.groundFloor;
  if (elevator) return a.perFloorWithElevator * Math.min(floor, a.floorCap);
  return floor > 2 ? a.perFloorNoElevatorAbove2 * (floor - 2) : 0;
}

function indexAt(index: PriceIndexPoint[], iso: string): number | undefined {
  const month = iso.slice(0, 7);
  const exact = index.find((p) => p.month === month);
  if (exact) return exact.value;
  // nearest earlier month
  const earlier = index.filter((p) => p.month <= month).sort((a, b) => (a.month < b.month ? 1 : -1));
  return earlier[0]?.value ?? index[0]?.value;
}

export function adjustComparable(
  subject: Subject,
  deal: Deal,
  valuationDate: string,
  index: PriceIndexPoint[],
  cfg: ValuationConfig,
): { adjustments: AdjustmentLine[]; rawPpsqm: number; adjustedPpsqm: number; gross: number } {
  const a = cfg.adjustments;
  const parkingNis = (deal.parkingSpaces ?? 0) * cfg.parkingNis.regular;
  const eqArea = deal.area + (deal.addOnEquivalentSqm ?? 0);
  const rawPpsqm = (deal.price - parkingNis) / eqArea;

  const lines: AdjustmentLine[] = [];

  // Time: index the deal to the valuation date.
  const iDeal = indexAt(index, deal.date);
  const iNow = indexAt(index, valuationDate);
  if (iDeal && iNow) lines.push({ key: "time", pct: iNow / iDeal - 1 });

  // Floor & elevator (registry rows lack the elevator and the Tax Authority export lacks the
  // floor: assume as the subject and flag it).
  const floorKnown = deal.floor !== undefined && deal.elevator !== undefined;
  const fl =
    floorValue(subject.floor, subject.elevator, cfg) - floorValue(deal.floor ?? subject.floor, deal.elevator ?? subject.elevator, cfg);
  if (fl !== 0 || !floorKnown) lines.push({ key: "floor", pct: fl, assumed: !floorKnown || undefined });

  // Building age (new-build premium handled separately). Unknown year → no adjustment, flagged.
  if (deal.yearBuilt && deal.yearBuilt > 1800) {
    const ageDiff = Math.max(-50, Math.min(50, subject.yearBuilt - deal.yearBuilt));
    if (ageDiff !== 0) lines.push({ key: "age", pct: (ageDiff / 10) * a.perDecadeAge });
  } else {
    lines.push({ key: "age", pct: 0, assumed: true });
  }

  // Unit condition. Tax Authority records carry no condition: assume "original" and flag it.
  const dealCond: Condition = deal.condition ?? (deal.newBuild ? "new" : "original");
  const cond = a.condition[subject.condition] - a.condition[dealCond];
  if (cond !== 0 || !deal.condition) {
    lines.push({ key: "condition", pct: cond, assumed: !deal.condition });
  }

  // View.
  const dealView: ViewQuality = deal.view ?? "regular";
  const v = a.view[subject.view] - a.view[dealView];
  if (v !== 0) lines.push({ key: "view", pct: v, assumed: !deal.view });

  // New build vs resale.
  const nb = (subject.newBuild ? a.newBuildPremium : 0) - (deal.newBuild ? a.newBuildPremium : 0);
  if (nb !== 0) lines.push({ key: "new_build", pct: nb });

  // Rights type.
  const r =
    (subject.rights === "leasehold" ? a.leaseholdDiscount : 0) -
    ((deal.rights ?? "ownership") === "leasehold" ? a.leaseholdDiscount : 0);
  if (r !== 0) lines.push({ key: "rights", pct: r });

  const timeFactor = 1 + (lines.find((l) => l.key === "time")?.pct ?? 0);
  const attr = lines.filter((l) => l.key !== "time");
  const attrSum = attr.reduce((s, l) => s + l.pct, 0);
  const gross = attr.reduce((s, l) => s + Math.abs(l.pct), 0);
  const adjustedPpsqm = rawPpsqm * timeFactor * (1 + attrSum);
  return { adjustments: lines, rawPpsqm, adjustedPpsqm, gross };
}

export function selectComparables(
  subject: Subject,
  deals: Deal[],
  valuationDate: string,
  index: PriceIndexPoint[],
  cfg: ValuationConfig,
): ComparablesOutcome {
  const c = cfg.comparables;
  const rejected: ComparablesOutcome["rejected"] = [];

  const enriched = deals.map((deal) => ({
    deal,
    distanceM: distanceM(subject.location, deal.location),
    ageMonths: monthsBetween(deal.date, valuationDate),
  }));

  const fresh = enriched.filter((e) => {
    if (e.deal.fractionSold !== undefined && e.deal.fractionSold < 0.999) {
      rejected.push({ deal: e.deal, reason: "partial_sale" });
      return false;
    }
    if (e.ageMonths > c.maxMonths || e.ageMonths < 0) {
      rejected.push({ deal: e.deal, reason: "too_old" });
      return false;
    }
    return true;
  });

  // Widen the radius until enough comparables qualify.
  let radiusM = c.radiiM[c.radiiM.length - 1]!;
  for (const r of c.radiiM) {
    const n = fresh.filter((e) => e.distanceM <= r).length;
    if (n >= c.minComparables) {
      radiusM = r;
      break;
    }
  }

  let candidates: ComparableResult[] = [];
  for (const e of fresh) {
    if (e.distanceM > radiusM) {
      rejected.push({ deal: e.deal, reason: "too_far" });
      continue;
    }
    const adj = adjustComparable(subject, e.deal, valuationDate, index, cfg);
    if (adj.gross > c.maxGrossAdjustment) {
      rejected.push({ deal: e.deal, reason: "over_adjusted" });
      continue;
    }
    const weight =
      Math.pow(0.5, e.distanceM / c.distanceHalfM) *
      Math.pow(0.5, e.ageMonths / c.recencyHalfMonths) *
      (1 - adj.gross / c.maxGrossAdjustment) *
      // similarity in size: penalise comps far from the subject's size
      sizeSimilarity(e.deal.area, subjectAreaHint(subject)) *
      // pre-completion developer sales are a different market from an existing flat
      (e.deal.offPlan && !subject.newBuild ? 0.4 : 1);
    candidates.push({
      deal: e.deal,
      distanceM: e.distanceM,
      ageMonths: e.ageMonths,
      rawPpsqm: adj.rawPpsqm,
      adjustedPpsqm: adj.adjustedPpsqm,
      adjustments: adj.adjustments,
      grossAdjustment: adj.gross,
      weight,
      weightShare: 0,
      radiusUsedM: radiusM,
    });
  }

  // Outlier filter: drop comps more than 35% from the unweighted median (data-quality guard;
  // the State Comptroller flagged completeness and accuracy issues in the transactions file).
  if (candidates.length >= 4) {
    const sorted = candidates.map((x) => x.adjustedPpsqm).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)]!;
    candidates = candidates.filter((x) => {
      const ok = Math.abs(x.adjustedPpsqm / med - 1) <= 0.35;
      if (!ok) rejected.push({ deal: x.deal, reason: "outlier" });
      return ok;
    });
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const used = candidates.slice(0, c.maxComparables);
  for (const x of candidates.slice(c.maxComparables)) rejected.push({ deal: x.deal, reason: "beyond_max" });

  const totalW = used.reduce((s, x) => s + x.weight, 0);
  for (const x of used) x.weightShare = totalW > 0 ? x.weight / totalW : 0;

  const vals = used.map((x) => x.adjustedPpsqm);
  const ws = used.map((x) => x.weight);
  const ppsqmMedian = weightedQuantile(vals, ws, 0.5);
  const ppsqmP25 = weightedQuantile(vals, ws, 0.25);
  const ppsqmP75 = weightedQuantile(vals, ws, 0.75);

  const spread = (ppsqmP75 - ppsqmP25) / ppsqmMedian;
  let confidence: ComparablesOutcome["confidence"];
  if (used.length < 3) confidence = "insufficient";
  else if (used.length >= 8 && spread <= 0.12 && radiusM <= 600) confidence = "high";
  else if (used.length >= c.minComparables && spread <= 0.2) confidence = "medium";
  else confidence = "low";

  return { used, rejected, radiusM, ppsqmMedian, ppsqmP25, ppsqmP75, confidence };
}

function subjectAreaHint(subject: Subject): number {
  return subject.area.mode === "declared"
    ? subject.area.area
    : subject.area.levels.reduce((s, l) => s + l.internalArea, 0) * 1.12;
}

function sizeSimilarity(a: number, b: number): number {
  const ratio = Math.abs(Math.log(a / b));
  return Math.pow(0.5, ratio / 0.35); // a comp 35% larger/smaller gets half weight
}
