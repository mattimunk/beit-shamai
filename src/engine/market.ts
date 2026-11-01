import { distanceM } from "./geo";
import type { CalibrationModel } from "./askCalibration";
import type { MatchedPair } from "./matching";
import { median } from "./stats";
import type { Deal, LatLng, Listing } from "./types";

/**
 * Market context for the report. Asking prices never set value on their own: raw asking
 * prices are shown for reference, and the sale-to-ask gap and days on market come from
 * matched pairs (advert → completed deal of the same unit).
 */
export interface MarketContext {
  activeListings: Listing[];
  askingPpsqmMedian: number | null;
  /** Median sale / last-ask − 1 from matched pairs near the property. */
  saleToAskDiscount: number | null;
  /** Median days from first advert to contract, matched pairs. */
  medianDaysOnMarket: number | null;
  matchedCount: number;
  /** Nearest matched pairs, newest first (for the report table). */
  recentPairs: MatchedPair[];
  priorSales: Deal[];
}

export function marketContext(
  at: LatLng,
  listings: Listing[],
  valuationDate: string,
  radiusM: number,
  model: CalibrationModel | null,
  unitHistory: Deal[] = [],
): MarketContext {
  const active = listings.filter(
    (l) => l.status === "active" && distanceM(at, l.location) <= radiusM && l.lastSeen >= addDays(valuationDate, -30),
  );
  const askingPpsqm = active.map((l) => l.askingPrice / l.area);
  return {
    activeListings: active,
    askingPpsqmMedian: askingPpsqm.length ? median(askingPpsqm) : null,
    saleToAskDiscount: model ? model.saleToAsk - 1 : null,
    medianDaysOnMarket: model?.medianDaysOnMarket ?? null,
    matchedCount: model?.localN ?? 0,
    recentPairs: model ? [...model.pairs].sort((a, b) => (a.deal.date < b.deal.date ? 1 : -1)).slice(0, 8) : [],
    priorSales: [...unitHistory].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

function addDays(iso: string, d: number): string {
  return new Date(Date.parse(iso) + d * 86_400_000).toISOString().slice(0, 10);
}

export function parcelKeyOf(p: { block: string; parcel: string; subParcel?: string }): string {
  return `${p.block}-${p.parcel}${p.subParcel ? "-" + p.subParcel : ""}`;
}
