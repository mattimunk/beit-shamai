/**
 * DataProvider backed by the server database: real deals (Tax Authority via GovMap), the
 * listing ledger and the nightly matched pairs. Sources not connected yet (GTFS, plans,
 * renewal signals, CBS index) come from `fallback` – by default empty, so those report
 * sections are blank rather than invented.
 */
import type { Database } from "bun:sqlite";
import type { DataProvider, AreaQuery } from "../src/data/provider";
import { distanceM } from "../src/engine/geo";
import type { Deal, Listing, PriceIndexPoint } from "../src/engine/types";
import type { MatchedPair } from "../src/engine/matching";
import { dealsByParcel, dealsNear, listingsNear, pairsNear } from "./db";

type Fallback = Pick<
  DataProvider,
  "getPriceIndex" | "getTransitStops" | "getFutureLines" | "getRenewalSignals" | "getCityPolicy" | "getCityConfig"
>;

export const EMPTY_FALLBACK: Fallback = {
  async getPriceIndex() { return [] as PriceIndexPoint[]; },
  async getTransitStops() { return []; },
  async getFutureLines() { return []; },
  async getRenewalSignals() { return []; },
  async getCityPolicy() { return undefined; },
  async getCityConfig() { return undefined; },
};

export class SqliteProvider implements DataProvider {
  readonly id = "server";
  readonly isDemo = false;
  constructor(private db: Database, private fallback: Fallback = EMPTY_FALLBACK) {}

  private within<T extends { location: { lat: number; lng: number } }>(rows: T[], q: AreaQuery) {
    return rows.filter((r) => distanceM(q.center, r.location) <= q.radiusM);
  }
  async getDeals(q: AreaQuery & { sinceIso: string }): Promise<Deal[]> {
    return this.within(dealsNear(this.db, q.center.lat, q.center.lng, q.radiusM, q.sinceIso), q);
  }
  async getUnitHistory(key: string) { return dealsByParcel(this.db, key); }
  async getListings(q: AreaQuery): Promise<Listing[]> {
    return this.within(listingsNear(this.db, q.center.lat, q.center.lng, q.radiusM), q);
  }
  async getMatchedPairs(q: AreaQuery & { sinceIso: string }): Promise<MatchedPair[]> {
    // Calibration pools pairs from a wider ring than the comparables.
    const wide = { ...q, radiusM: Math.max(q.radiusM, 3000) };
    return pairsNear(this.db, q.center.lat, q.center.lng, wide.radiusM, q.sinceIso).filter(
      (p) => distanceM(q.center, p.deal.location) <= wide.radiusM,
    );
  }
  getPriceIndex = (city: string) => this.fallback.getPriceIndex(city);
  getTransitStops = (q: AreaQuery) => this.fallback.getTransitStops(q);
  getFutureLines = (city: string) => this.fallback.getFutureLines(city);
  getRenewalSignals = (q: AreaQuery) => this.fallback.getRenewalSignals(q);
  getCityPolicy = (city: string) => this.fallback.getCityPolicy(city);
  getCityConfig = (city: string) => this.fallback.getCityConfig(city);
}
