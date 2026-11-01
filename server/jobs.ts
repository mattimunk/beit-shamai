import type { Database } from "bun:sqlite";
import { matchListingsToDeals } from "../src/engine/matching";
import { fetchDealsByRadius, type GovmapOptions } from "./govmap";
import { dealsNear, listingsNear, replacePairs, upsertDeals } from "./db";

/** Pull completed deals around a point from GovMap and store them. */
export async function syncDeals(
  db: Database,
  area: { lat: number; lng: number; radiusM: number },
  opt: Partial<GovmapOptions> = {},
) {
  const { deals, unmapped } = await fetchDealsByRadius({ lat: area.lat, lng: area.lng }, area.radiusM, opt);
  upsertDeals(db, deals);
  return { stored: deals.length, unmapped };
}

/**
 * Re-match adverts to deals in an area. Run nightly after the deals sync and the feed imports.
 * Adverts up to 18 months before a deal are considered, so the window reaches back that far.
 */
export function rematch(db: Database, area: { lat: number; lng: number; radiusM: number }, sinceIso: string) {
  const deals = dealsNear(db, area.lat, area.lng, area.radiusM, sinceIso);
  const listings = listingsNear(db, area.lat, area.lng, area.radiusM + 200);
  const { pairs, unmatchedDeals } = matchListingsToDeals(deals, listings);
  replacePairs(db, pairs, deals.map((d) => d.id));
  return { deals: deals.length, listings: listings.length, pairs: pairs.length, unmatched: unmatchedDeals.length };
}
