/**
 * DataProvider backed by the server database: real deals (Tax Authority via GovMap), the
 * listing ledger, matched pairs, GTFS stops, CBS index and renewal signals. Future lines and
 * city policies come from the curated config. Anything not loaded yet returns empty, so the
 * report shows a blank section rather than invented data.
 */
import type { Database } from "bun:sqlite";
import type { DataProvider, AreaQuery } from "../src/data/provider";
import { distanceM } from "../src/engine/geo";
import type { CityPolicy, Deal, FutureLine, Listing, PriceIndexPoint, RenewalSignal, TransitStop } from "../src/engine/types";
import type { MatchedPair } from "../src/engine/matching";
import { normaliseCity } from "../src/engine/address";
import type { ValuationConfig } from "../src/engine/coefficients";
import { dealsByParcel, dealsNear, listingsNear, pairsNear, priceIndex, signalsNear, stopsNear } from "./db";
import { DEFAULT_SOURCES, type SourcesConfig } from "./config";

export class SqliteProvider implements DataProvider {
  readonly id = "server";
  readonly isDemo = false;
  constructor(private db: Database, private cfg: SourcesConfig = DEFAULT_SOURCES) {}

  private within<T extends { location: { lat: number; lng: number } }>(rows: T[], q: AreaQuery) {
    return rows.filter((r) => distanceM(q.center, r.location) <= q.radiusM);
  }
  private city(name: string) {
    const n = normaliseCity(name);
    return this.cfg.cities.find((c) => normaliseCity(c.name) === n);
  }

  async getDeals(q: AreaQuery & { sinceIso: string }): Promise<Deal[]> {
    return this.within(dealsNear(this.db, q.center.lat, q.center.lng, q.radiusM, q.sinceIso), q);
  }
  async getUnitHistory(key: string) {
    return dealsByParcel(this.db, key);
  }
  async getListings(q: AreaQuery): Promise<Listing[]> {
    return this.within(listingsNear(this.db, q.center.lat, q.center.lng, q.radiusM), q);
  }
  async getMatchedPairs(q: AreaQuery & { sinceIso: string }): Promise<MatchedPair[]> {
    // Calibration pools pairs from a wider ring than the comparables.
    const r = Math.max(q.radiusM, 3000);
    return pairsNear(this.db, q.center.lat, q.center.lng, r, q.sinceIso).filter((p) => distanceM(q.center, p.deal.location) <= r);
  }
  async getPriceIndex(city: string): Promise<PriceIndexPoint[]> {
    const c = this.city(city);
    return c ? priceIndex(this.db, c.district) : [];
  }
  async getTransitStops(q: AreaQuery): Promise<TransitStop[]> {
    return this.within(stopsNear(this.db, q.center.lat, q.center.lng, q.radiusM), q);
  }
  async getFutureLines(): Promise<FutureLine[]> {
    return this.cfg.futureLines;
  }
  async getRenewalSignals(q: AreaQuery): Promise<RenewalSignal[]> {
    return this.within(signalsNear(this.db, q.center.lat, q.center.lng, q.radiusM), q);
  }
  async getCityPolicy(city: string): Promise<CityPolicy | undefined> {
    const n = normaliseCity(city);
    return this.cfg.cityPolicies.find((p) => normaliseCity(p.city) === n);
  }
  async getCityConfig(): Promise<Partial<ValuationConfig> | undefined> {
    return undefined;
  }
}
