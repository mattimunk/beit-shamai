/**
 * Live connector skeletons. Each method documents where the production data comes from and
 * throws NotConnectedError until the connector is implemented and licensed.
 *
 * Deployment note: the Tax Authority site answers only Israeli IPs, so the deals connector
 * must run server-side in an Israeli region. Listings require commercial licences with
 * Yad2 / Madlan (scraping breaches their terms of use).
 */
import type { ValuationConfig } from "../engine/coefficients";
import type { CityPolicy, Deal, FutureLine, Listing, PriceIndexPoint, RenewalSignal, TransitStop } from "../engine/types";
import { NotConnectedError, type AreaQuery, type DataProvider } from "./provider";

export class LiveProvider implements DataProvider {
  readonly id = "live";
  readonly isDemo = false;

  /** Israel Tax Authority real-estate database (nadlan.gov.il) / GovMap real-estate layer. */
  async getDeals(_q: AreaQuery & { sinceIso: string }): Promise<Deal[]> {
    throw new NotConnectedError("Tax Authority deals (nadlan.gov.il / GovMap)");
  }
  /** Same source, filtered by block-parcel-subParcel. */
  async getUnitHistory(_parcelKey: string): Promise<Deal[]> {
    throw new NotConnectedError("Tax Authority unit history");
  }
  /** Licensed listing feeds + own listing ledger (first seen, price changes, matches). */
  async getListings(_q: AreaQuery): Promise<Listing[]> {
    throw new NotConnectedError("Listings ledger (Yad2 / Madlan / agency feeds)");
  }
  /** CBS dwelling price index by district. */
  async getPriceIndex(_city: string): Promise<PriceIndexPoint[]> {
    throw new NotConnectedError("CBS price index");
  }
  /** National Public Transport Authority GTFS: gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip */
  async getTransitStops(_q: AreaQuery): Promise<TransitStop[]> {
    throw new NotConnectedError("GTFS (National Public Transport Authority)");
  }
  /** Statutory transport plans (Metro NIPs, light rail, TAMA 70 layer) from the Planning Administration / GovMap. */
  async getFutureLines(_city: string): Promise<FutureLine[]> {
    throw new NotConnectedError("Statutory transport plans");
  }
  /** Urban Renewal Authority declarations, plan system, section-149 notices, committee minutes, news. */
  async getRenewalSignals(_q: AreaQuery): Promise<RenewalSignal[]> {
    throw new NotConnectedError("Urban renewal signals");
  }
  /** Per-city policy table maintained by the methodology team. */
  async getCityPolicy(_city: string): Promise<CityPolicy | undefined> {
    return undefined;
  }
  /** Calibrated coefficients per city, maintained with partner appraisers. */
  async getCityConfig(_city: string): Promise<Partial<ValuationConfig> | undefined> {
    return undefined;
  }
}
