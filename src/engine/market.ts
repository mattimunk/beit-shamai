import { distanceM } from "./geo";
import { median, monthsBetween } from "./stats";
import type { Deal, LatLng, Listing } from "./types";

/**
 * Asking-price cross-check and the listing ledger metrics.
 * Asking prices never set value: they show the current ceiling and negotiating margin.
 */
export interface MarketContext {
  activeListings: Listing[];
  askingPpsqmMedian: number | null;
  /** Median of (sale price / last asking price - 1) for listings matched to completed deals. */
  saleToAskDiscount: number | null;
  /** Median days from first seen to deal / removal for matched listings. */
  medianDaysOnMarket: number | null;
  matchedCount: number;
  priorSales: Deal[];
}

export function marketContext(
  at: LatLng,
  listings: Listing[],
  deals: Deal[],
  valuationDate: string,
  radiusM: number,
  unitHistory: Deal[] = [],
): MarketContext {
  const near = listings.filter((l) => distanceM(at, l.location) <= radiusM);
  const active = near.filter((l) => !l.matchedDealId && monthsBetween(l.lastSeen, valuationDate) <= 1);
  const askingPpsqm = active.map((l) => l.askingPrice / l.area);

  const dealById = new Map(deals.map((d) => [d.id, d]));
  const matched = near.filter((l) => l.matchedDealId && dealById.has(l.matchedDealId));
  const discounts = matched.map((l) => dealById.get(l.matchedDealId!)!.price / l.askingPrice - 1);
  const dom = matched.map((l) => {
    const d = dealById.get(l.matchedDealId!)!;
    return (Date.parse(d.date) - Date.parse(l.firstSeen)) / 86_400_000;
  });

  const priorSales = [...unitHistory].sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    activeListings: active,
    askingPpsqmMedian: askingPpsqm.length ? median(askingPpsqm) : null,
    saleToAskDiscount: discounts.length ? median(discounts) : null,
    medianDaysOnMarket: dom.length ? Math.round(median(dom)) : null,
    matchedCount: matched.length,
    priorSales,
  };
}

export function parcelKeyOf(p: { block: string; parcel: string; subParcel?: string }): string {
  return `${p.block}-${p.parcel}${p.subParcel ? "-" + p.subParcel : ""}`;
}
