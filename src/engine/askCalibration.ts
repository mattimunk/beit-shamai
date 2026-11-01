/**
 * Asking-price calibration.
 *
 * Completed deals are the truth but they lag: contracts reach the Tax Authority weeks later and
 * the comparables can be months old. Unsold adverts are current but they are asking prices.
 * Matched pairs (advert → sale of the same unit) tell us, for this area and right now, how far
 * sale prices sit below asking prices and how advertised area relates to registered area.
 * Applying that to today's unsold adverts turns them into fresh, calibrated evidence.
 */
import type { MatchedPair } from "./matching";
import { distanceM } from "./geo";
import { median, monthsBetween, weightedQuantile } from "./stats";
import type { LatLng, Listing } from "./types";

export type DomBucket = "0-30" | "31-90" | "91-180" | "180+";
export const DOM_BUCKETS: DomBucket[] = ["0-30", "31-90", "91-180", "180+"];

export function domBucket(days: number): DomBucket {
  return days <= 30 ? "0-30" : days <= 90 ? "31-90" : days <= 180 ? "91-180" : "180+";
}

export interface CalibrationModel {
  /** Pairs used (within radius and window). */
  pairs: MatchedPair[];
  /** Pairs in the wider pool (city) used for shrinkage and bucket shapes. */
  poolSize: number;
  localN: number;
  /** Local sale/last-ask median, shrunk towards the pool when local data is thin. */
  saleToAsk: number;
  saleToAskLocalRaw: number | null;
  saleToAskPool: number;
  /** Sale/last-ask relative to the pool, per days-on-market bucket (for display). */
  bucketFactor: Record<DomBucket, number>;
  /** Pool pairs (DOM, ratio) used for the survival-conditioned factor. */
  domRatios: { dom: number; ratio: number }[];
  bucketN: Record<DomBucket, number>;
  /** Registered area / advertised area. */
  areaRatio: number;
  medianDaysOnMarket: number | null;
  /** Share of pairs that sold at or above the last asking price. */
  shareAtOrAboveAsk: number;
  /** Interquartile spread of sale/last-ask among local pairs. */
  spread: number;
}

export interface CalibrationOptions {
  radiusM: number;
  windowMonths: number;
  /** Prior strength (pairs) for shrinking local ratios towards the pool. */
  shrinkK: number;
}

export const DEFAULT_CALIBRATION: CalibrationOptions = { radiusM: 1500, windowMonths: 18, shrinkK: 12 };

export function buildCalibration(
  at: LatLng,
  pool: MatchedPair[],
  valuationDate: string,
  opt: CalibrationOptions = DEFAULT_CALIBRATION,
): CalibrationModel | null {
  const recent = pool.filter((p) => monthsBetween(p.deal.date, valuationDate) <= opt.windowMonths);
  if (recent.length < 5) return null;

  // Recency weights: half-life 9 months, so the ratio follows the market.
  const w = (p: MatchedPair) => Math.pow(0.5, monthsBetween(p.deal.date, valuationDate) / 9);
  const poolRatio = weightedQuantile(recent.map((p) => p.saleToLastAsk), recent.map(w), 0.5);

  const local = recent.filter((p) => distanceM(at, p.deal.location) <= opt.radiusM);
  const localRaw = local.length ? weightedQuantile(local.map((p) => p.saleToLastAsk), local.map(w), 0.5) : null;
  const n = local.length;
  const saleToAsk = localRaw === null ? poolRatio : (n * localRaw + opt.shrinkK * poolRatio) / (n + opt.shrinkK);

  const bucketFactor = {} as Record<DomBucket, number>;
  const bucketN = {} as Record<DomBucket, number>;
  for (const b of DOM_BUCKETS) {
    const inB = recent.filter((p) => domBucket(p.daysOnMarket) === b);
    bucketN[b] = inB.length;
    // Shrink each bucket towards 1 so thin buckets do not swing the estimate.
    const raw = inB.length ? median(inB.map((p) => p.saleToLastAsk)) / poolRatio : 1;
    bucketFactor[b] = (inB.length * raw + 8 * 1) / (inB.length + 8);
  }

  const basis = local.length >= 5 ? local : recent;
  const areaRatio = median(basis.map((p) => p.areaRatio));
  const doms = basis.map((p) => p.daysOnMarket);
  const ratios = basis.map((p) => p.saleToLastAsk);
  const q = (x: number) => weightedQuantile(ratios, ratios.map(() => 1), x);

  return {
    domRatios: recent.map((p) => ({ dom: p.daysOnMarket, ratio: p.saleToLastAsk })),
    pairs: local,
    poolSize: recent.length,
    localN: n,
    saleToAsk,
    saleToAskLocalRaw: localRaw,
    saleToAskPool: poolRatio,
    bucketFactor,
    bucketN,
    areaRatio,
    medianDaysOnMarket: doms.length ? Math.round(median(doms)) : null,
    shareAtOrAboveAsk: basis.filter((p) => p.saleToLastAsk >= 0.999).length / basis.length,
    spread: q(0.75) - q(0.25),
  };
}

export interface CalibratedListing {
  listing: Listing;
  daysListed: number;
  bucket: DomBucket;
  ratioUsed: number;
  /** Expected sale price = asking × ratio. */
  expectedPrice: number;
  /** Advertised area × area ratio ≈ registered area. */
  expectedArea: number;
}

/**
 * Survival-conditioned factor: an advert still unsold after d days can only sell after d days,
 * so compare it with pairs whose days on market were at least d. Thin tails borrow the
 * longest-listed pairs and are shrunk towards 1.
 */
export function ageFactor(model: CalibrationModel, daysListed: number): number {
  const sorted = [...model.domRatios].sort((a, b) => b.dom - a.dom);
  let cond = sorted.filter((x) => x.dom >= daysListed);
  if (cond.length < 8) cond = sorted.slice(0, Math.min(8, sorted.length));
  if (!cond.length) return 1;
  const f = median(cond.map((x) => x.ratio)) / model.saleToAskPool;
  const n = cond.length;
  return (n * f + 8) / (n + 8);
}

/** Apply the model to currently active adverts. */
export function calibrateListings(
  model: CalibrationModel,
  active: Listing[],
  valuationDate: string,
): CalibratedListing[] {
  return active.map((l) => {
    const daysListed = Math.max(0, Math.round((Date.parse(valuationDate) - Date.parse(l.firstSeen)) / 86_400_000));
    const bucket = domBucket(daysListed);
    const ratioUsed = model.saleToAsk * ageFactor(model, daysListed);
    return {
      listing: l,
      daysListed,
      bucket,
      ratioUsed,
      expectedPrice: Math.round((l.askingPrice * ratioUsed) / 1000) * 1000,
      expectedArea: Math.round(l.area * model.areaRatio * 10) / 10,
    };
  });
}
