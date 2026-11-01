/**
 * Turns calibrated unsold adverts into adjusted price-per-sqm evidence and blends it with the
 * completed-deal comparables.
 *
 * Why blend: completed deals are the legal and professional anchor, but they lag the market.
 * Calibrated adverts are current. The blend weight is small, grows with the number of matched
 * pairs that support the calibration, grows when the deal comparables are old, and shrinks when
 * sale-to-ask ratios in the area are scattered. It is capped so deals always dominate.
 */
import type { CalibratedListing, CalibrationModel } from "./askCalibration";
import type { ValuationConfig } from "./coefficients";
import { adjustComparable, type AdjustmentLine, type ComparablesOutcome } from "./comparables";
import { distanceM } from "./geo";
import { median, weightedQuantile } from "./stats";
import type { Deal, PriceIndexPoint, Subject } from "./types";

export const MAX_LISTING_WEIGHT = 0.4;

export interface CalibratedEvidence {
  item: CalibratedListing;
  distanceM: number;
  adjustedPpsqm: number;
  adjustments: AdjustmentLine[];
  weight: number;
}

export interface ListingEvidence {
  model: CalibrationModel;
  items: CalibratedEvidence[];
  ppsqmMedian: number;
  ppsqmP25: number;
  ppsqmP75: number;
  /** Share of the blended estimate taken from calibrated adverts (0..MAX_LISTING_WEIGHT). */
  blendWeight: number;
  blendReasons: { pairsSupport: number; countFactor: number; freshness: number; dispersionPenalty: number };
  /** Agreement between deals and calibrated adverts (calibrated / deals − 1). */
  gapVsDeals: number;
}

/** Build evidence from already-calibrated active adverts near the property. */
export function buildListingEvidence(
  subject: Subject,
  model: CalibrationModel,
  activeInRadius: CalibratedListing[],
  comps: ComparablesOutcome,
  valuationDate: string,
  index: PriceIndexPoint[],
  cfg: ValuationConfig,
): ListingEvidence | null {
  if (activeInRadius.length < 3 || !comps.used.length) return null;

  const items: CalibratedEvidence[] = activeInRadius.map((c) => {
    const l = c.listing;
    // Adverts often lack year built / elevator: assume the subject's and flag it.
    const pseudo: Deal = {
      id: l.id,
      evidence: "completed_deal",
      source: l.source,
      date: valuationDate,
      price: c.expectedPrice,
      location: l.location,
      address: l.address,
      area: c.expectedArea,
      rooms: l.rooms,
      floor: l.floor ?? subject.floor,
      floorsInBuilding: l.floorsInBuilding ?? subject.floorsInBuilding,
      elevator: l.elevator ?? subject.elevator,
      yearBuilt: l.yearBuilt ?? subject.yearBuilt,
      newBuild: l.newBuild ?? false,
    };
    const adj = adjustComparable(subject, pseudo, valuationDate, index, cfg);
    const assumedFloor = l.floor === undefined;
    const adjustments = adj.adjustments
      .filter((a) => a.key !== "time")
      .map((a) => (a.key === "floor" && assumedFloor ? { ...a, assumed: true } : a));
    // Make assumptions visible even when they produce no adjustment.
    if (assumedFloor && !adjustments.some((a) => a.key === "floor")) adjustments.unshift({ key: "floor", pct: 0, assumed: true });
    if (l.yearBuilt === undefined && !adjustments.some((a) => a.key === "age")) adjustments.push({ key: "age", pct: 0, assumed: true });
    const d = distanceM(subject.location, l.location);
    const weight = Math.pow(0.5, d / cfg.comparables.distanceHalfM) * (1 - Math.min(adj.gross, 0.3) / 0.3 * 0.7);
    return { item: c, distanceM: d, adjustedPpsqm: adj.adjustedPpsqm, adjustments, weight };
  });

  const vals = items.map((x) => x.adjustedPpsqm);
  const ws = items.map((x) => x.weight);
  const ppsqmMedian = weightedQuantile(vals, ws, 0.5);
  const ppsqmP25 = weightedQuantile(vals, ws, 0.25);
  const ppsqmP75 = weightedQuantile(vals, ws, 0.75);

  // Blend weight.
  const pairsSupport = model.localN / (model.localN + 20); // 20 local pairs → 0.5
  const countFactor = Math.min(1, items.length / 6);
  const dealAgeMonths = median(comps.used.map((c) => c.ageMonths));
  const freshness = Math.max(0.6, Math.min(1.3, 0.6 + dealAgeMonths / 12)); // older deals → lean on adverts more
  const dispersionPenalty = model.spread > 0.12 ? 0.5 : 1;
  const blendWeight = Math.min(MAX_LISTING_WEIGHT, MAX_LISTING_WEIGHT * 2 * pairsSupport * countFactor * freshness * dispersionPenalty);

  return {
    model,
    items: items.sort((a, b) => a.distanceM - b.distanceM),
    ppsqmMedian,
    ppsqmP25,
    ppsqmP75,
    blendWeight,
    blendReasons: { pairsSupport, countFactor, freshness, dispersionPenalty },
    gapVsDeals: ppsqmMedian / comps.ppsqmMedian - 1,
  };
}
