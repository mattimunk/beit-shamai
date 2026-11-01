/**
 * Listing ↔ deal matching.
 *
 * Links each completed deal (Tax Authority) to the same unit's earlier advert(s) on Yad2 /
 * Madlan / agency feeds. Each matched pair tells us what the seller asked, what the buyer
 * actually paid, how long it took, and how the advertised area relates to the registered one.
 * Those pairs calibrate today's unsold adverts (see askCalibration.ts).
 */
import { normaliseCity, normaliseStreet, parseHouseNumber } from "./address";
import { distanceM } from "./geo";
import type { Deal, Listing } from "./types";

export interface MatchConfig {
  /** Advert must have been first seen at most this many days before the deal. */
  maxDaysBeforeDeal: number;
  /** Advert may still be seen this many days after the contract date (adverts linger). */
  maxDaysAfterDeal: number;
  /** Advert must have been last seen no earlier than this many days before the deal. */
  maxGapBeforeDeal: number;
  /** Sale / last ask must fall inside this band, or it is probably not the same unit. */
  ratioBand: [number, number];
  /** Registered area / advertised area must fall inside this band. */
  areaBand: [number, number];
  /** Without a house number, coordinates must be this close. */
  maxDistanceNoNumberM: number;
  minScore: number;
  /** Best candidate must beat the runner-up by this many points. */
  minLead: number;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  maxDaysBeforeDeal: 540,
  maxDaysAfterDeal: 60,
  maxGapBeforeDeal: 150,
  ratioBand: [0.7, 1.08],
  areaBand: [0.78, 1.08],
  maxDistanceNoNumberM: 40,
  minScore: 70,
  minLead: 8,
};

export interface MatchedPair {
  deal: Deal;
  listing: Listing;
  score: number;
  confidence: "high" | "medium";
  firstAsk: number;
  lastAsk: number;
  salePrice: number;
  /** sale / last asking price */
  saleToLastAsk: number;
  /** sale / first asking price */
  saleToFirstAsk: number;
  /** days from first seen to the deal date */
  daysOnMarket: number;
  priceCuts: number;
  /** registered (deal) area / advertised area */
  areaRatio: number;
  reasons: string[];
}

const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;

/** Score one candidate; null when it is ruled out. */
export function scoreCandidate(
  deal: Deal,
  l: Listing,
  cfg: MatchConfig = DEFAULT_MATCH_CONFIG,
): { score: number; reasons: string[] } | null {
  const reasons: string[] = [];

  // City must agree.
  if (normaliseCity(deal.address.city) !== normaliseCity(l.address.city)) return null;

  // Timing: advert must precede the deal and not have gone stale long before it.
  const firstToDeal = days(l.firstSeen, deal.date);
  const lastToDeal = days(l.lastSeen, deal.date); // >0: advert gone before the deal
  if (firstToDeal < -cfg.maxDaysAfterDeal || firstToDeal > cfg.maxDaysBeforeDeal) return null;
  if (lastToDeal > cfg.maxGapBeforeDeal || lastToDeal < -cfg.maxDaysAfterDeal) return null;

  // Price plausibility.
  const ratio = deal.price / l.askingPrice;
  if (ratio < cfg.ratioBand[0] || ratio > cfg.ratioBand[1]) return null;

  // Rooms within half a room.
  if (Math.abs(deal.rooms - l.rooms) > 0.5) return null;

  // Floor must agree when both are known.
  if (l.floor !== undefined && l.floor !== deal.floor) return null;

  // Area: registered area is usually equal or smaller than advertised.
  const areaRatio = deal.area / l.area;
  if (areaRatio < cfg.areaBand[0] || areaRatio > cfg.areaBand[1]) return null;

  let score = 0;

  // Parcel identity beats everything when the advert carries it (some Madlan adverts do).
  if (l.parcel && deal.parcel && l.parcel.block === deal.parcel.block && l.parcel.parcel === deal.parcel.parcel) {
    score += l.parcel.subParcel && l.parcel.subParcel === deal.parcel.subParcel ? 60 : 45;
    reasons.push("parcel");
  }

  // Street and number.
  const sameStreet = normaliseStreet(deal.address.street) === normaliseStreet(l.address.street);
  const dn = parseHouseNumber(deal.address.number);
  const ln = parseHouseNumber(l.address.number);
  const dist = distanceM(deal.location, l.location);
  if (sameStreet) {
    score += 30;
    reasons.push("street");
    if (dn && ln) {
      if (dn.n !== ln.n) return null;
      score += dn.suffix === ln.suffix ? 20 : 12;
      reasons.push("number");
    } else if (dist <= cfg.maxDistanceNoNumberM) {
      score += 10;
      reasons.push("near");
    } else {
      return null;
    }
  } else if (!reasons.includes("parcel")) {
    return null;
  }

  if (l.floor !== undefined) {
    score += 20;
    reasons.push("floor");
  }
  if (deal.rooms === l.rooms) {
    score += 8;
    reasons.push("rooms");
  }
  // Area closeness: full points between 0.88 and 1.0 (typical gross → registered gap).
  score += areaRatio >= 0.88 && areaRatio <= 1.0 ? 10 : 4;
  // Timing closeness: advert removed within ~45 days of the contract.
  score += Math.abs(lastToDeal) <= 45 ? 10 : Math.abs(lastToDeal) <= 90 ? 5 : 0;

  return { score, reasons };
}

/**
 * Greedy one-to-one assignment: highest scores first, each deal and each advert used once.
 * Several adverts of the same unit (Yad2 + Madlan) can all match one deal: only the earliest
 * first-seen advert is kept as the pair, so days on market counts from the first exposure.
 */
export function matchListingsToDeals(
  deals: Deal[],
  listings: Listing[],
  cfg: MatchConfig = DEFAULT_MATCH_CONFIG,
): { pairs: MatchedPair[]; unmatchedDeals: Deal[] } {
  type Cand = { deal: Deal; listing: Listing; score: number; reasons: string[] };
  const byDeal = new Map<string, Cand[]>();
  for (const deal of deals) {
    const cands: Cand[] = [];
    for (const l of listings) {
      const s = scoreCandidate(deal, l, cfg);
      if (s && s.score >= cfg.minScore) cands.push({ deal, listing: l, ...s });
    }
    if (cands.length) byDeal.set(deal.id, cands.sort((a, b) => b.score - a.score));
  }

  // Group adverts of one unit (same source price path aside): candidates within 5 points of the
  // best on the same deal and with identical street/number/floor are treated as duplicates.
  const all: Cand[] = [];
  for (const cands of byDeal.values()) {
    const best = cands[0]!;
    const competitors = cands.filter((c) => !isSameUnit(c.listing, best.listing));
    const runnerUp = competitors[0];
    if (runnerUp && best.score - runnerUp.score < cfg.minLead) continue; // ambiguous
    const dupes = cands.filter((c) => isSameUnit(c.listing, best.listing));
    const earliest = dupes.sort((a, b) => (a.listing.firstSeen < b.listing.firstSeen ? -1 : 1))[0]!;
    all.push({ ...earliest, score: best.score, reasons: best.reasons });
  }
  all.sort((a, b) => b.score - a.score);

  const usedListings = new Set<string>();
  const usedDeals = new Set<string>();
  const pairs: MatchedPair[] = [];
  for (const c of all) {
    if (usedDeals.has(c.deal.id) || usedListings.has(c.listing.id)) continue;
    usedDeals.add(c.deal.id);
    usedListings.add(c.listing.id);
    const history = c.listing.priceHistory.length
      ? c.listing.priceHistory
      : [{ date: c.listing.firstSeen, price: c.listing.askingPrice }];
    const firstAsk = history[0]!.price;
    const lastAsk = c.listing.askingPrice;
    let cuts = 0;
    for (let i = 1; i < history.length; i++) if (history[i]!.price < history[i - 1]!.price) cuts++;
    pairs.push({
      deal: c.deal,
      listing: c.listing,
      score: c.score,
      confidence: c.score >= 85 ? "high" : "medium",
      firstAsk,
      lastAsk,
      salePrice: c.deal.price,
      saleToLastAsk: c.deal.price / lastAsk,
      saleToFirstAsk: c.deal.price / firstAsk,
      daysOnMarket: Math.max(0, Math.round(days(c.listing.firstSeen, c.deal.date))),
      priceCuts: cuts,
      areaRatio: c.deal.area / c.listing.area,
      reasons: c.reasons,
    });
  }
  return { pairs, unmatchedDeals: deals.filter((d) => !usedDeals.has(d.id)) };
}

function isSameUnit(a: Listing, b: Listing): boolean {
  const na = parseHouseNumber(a.address.number)?.n;
  const nb = parseHouseNumber(b.address.number)?.n;
  return (
    normaliseStreet(a.address.street) === normaliseStreet(b.address.street) &&
    (na === undefined || nb === undefined || na === nb) &&
    a.floor === b.floor &&
    a.rooms === b.rooms
  );
}
