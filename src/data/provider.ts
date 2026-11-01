import type {
  CityPolicy,
  Deal,
  FutureLine,
  LatLng,
  Listing,
  PriceIndexPoint,
  RenewalSignal,
  TransitStop,
} from "../engine/types";
import type { ValuationConfig } from "../engine/coefficients";

/**
 * Every external source sits behind this interface, so the engine never knows where data
 * comes from. Each method returns data tagged with its evidence class and source.
 *
 * Planned production connectors (see docs/DATA_SOURCES.md):
 *  - Completed deals: Israel Tax Authority real-estate database (nadlan.gov.il / GovMap API).
 *    Must run server-side from an Israeli IP; deals appear weeks after signing.
 *  - Listings: licensed feeds from Yad2 / Madlan / agencies (no scraping – terms of use).
 *  - Price index: CBS dwelling price index by district.
 *  - Transit: National Public Transport Authority GTFS (gtfs.mot.gov.il), daily.
 *  - Future lines: statutory plans (Planning Administration, GovMap layers), NTA.
 *  - Renewal signals: Urban Renewal Authority declarations, plan system, section-149 permit
 *    notices per municipality, committee minutes, news monitoring.
 */
export interface AreaQuery {
  center: LatLng;
  radiusM: number;
  city: string;
}

export interface DataProvider {
  readonly id: string;
  readonly isDemo: boolean;
  getDeals(q: AreaQuery & { sinceIso: string }): Promise<Deal[]>;
  /** All recorded sales of one unit (block-parcel-subParcel), any date. */
  getUnitHistory(parcelKey: string): Promise<Deal[]>;
  getListings(q: AreaQuery): Promise<Listing[]>;
  getPriceIndex(city: string): Promise<PriceIndexPoint[]>;
  getTransitStops(q: AreaQuery): Promise<TransitStop[]>;
  getFutureLines(city: string): Promise<FutureLine[]>;
  getRenewalSignals(q: AreaQuery): Promise<RenewalSignal[]>;
  getCityPolicy(city: string): Promise<CityPolicy | undefined>;
  getCityConfig(city: string): Promise<Partial<ValuationConfig> | undefined>;
}

export class NotConnectedError extends Error {
  constructor(source: string) {
    super(`Data source not connected yet: ${source}`);
  }
}
