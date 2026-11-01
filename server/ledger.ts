/**
 * Listing ledger: imports adverts from licensed feeds (Yad2 / Madlan data licences, agency CRMs,
 * realtor uploads) and keeps each advert's history: first seen, last seen, every price change,
 * and removal. Scraping Yad2 or Madlan breaches their terms of use; this module only accepts
 * data delivered to it.
 *
 * Feed format (one item per advert, normalised by the feed adapter):
 *   { sourceId, askingPrice, city, street, number?, floor?, rooms, area, lat, lng,
 *     floorsInBuilding?, elevator?, yearBuilt?, newBuild?, block?, parcel?, subParcel?, url? }
 */
import type { Database } from "bun:sqlite";
import type { Listing } from "../src/engine/types";
import { getListingBySource, listingsForSourceCity, saveListing } from "./db";

export interface FeedItem {
  sourceId: string;
  askingPrice: number;
  city: string;
  street: string;
  number?: string;
  floor?: number;
  rooms: number;
  area: number;
  lat: number;
  lng: number;
  floorsInBuilding?: number;
  elevator?: boolean;
  yearBuilt?: number;
  newBuild?: boolean;
  block?: string;
  parcel?: string;
  subParcel?: string;
}

export interface ImportRequest {
  source: string;
  /** Date the feed was observed (ISO). Defaults to today. */
  observedAt?: string;
  /**
   * When true, the feed is a complete snapshot of the source for `city`: adverts not in it
   * are marked removed (sold, withdrawn or expired).
   */
  snapshot?: { city: string };
  items: FeedItem[];
}

export interface ImportResult {
  inserted: number;
  updated: number;
  priceChanges: number;
  removed: number;
  rejected: { sourceId: string; reason: string }[];
}

export function validateItem(i: FeedItem): string | null {
  if (!i.sourceId) return "missing sourceId";
  if (!(i.askingPrice > 100_000)) return "askingPrice missing or implausible";
  if (!(i.area > 10 && i.area < 1000)) return "area missing or implausible";
  if (!(i.rooms > 0)) return "rooms missing";
  if (!i.city || !i.street) return "city/street missing";
  if (!(Math.abs(i.lat - 31.5) < 3 && Math.abs(i.lng - 35) < 2)) return "coordinates outside Israel";
  return null;
}

export function importFeed(db: Database, req: ImportRequest): ImportResult {
  const observedAt = (req.observedAt ?? new Date().toISOString()).slice(0, 10);
  const res: ImportResult = { inserted: 0, updated: 0, priceChanges: 0, removed: 0, rejected: [] };
  const seen = new Set<string>();

  db.transaction(() => {
    for (const item of req.items) {
      const why = validateItem(item);
      if (why) {
        res.rejected.push({ sourceId: String(item.sourceId ?? ""), reason: why });
        continue;
      }
      seen.add(item.sourceId);
      const prev = getListingBySource(db, req.source, item.sourceId);
      const base = {
        address: { city: item.city, street: item.street, number: item.number ?? "" },
        location: { lat: item.lat, lng: item.lng },
        area: item.area,
        rooms: item.rooms,
        floor: item.floor,
        floorsInBuilding: item.floorsInBuilding,
        elevator: item.elevator,
        yearBuilt: item.yearBuilt,
        newBuild: item.newBuild,
        parcel: item.block && item.parcel ? { block: item.block, parcel: item.parcel, subParcel: item.subParcel } : undefined,
      };
      if (!prev) {
        saveListing(db, {
          id: `${req.source}-${item.sourceId}`,
          evidence: "asking_price",
          source: req.source,
          sourceId: item.sourceId,
          firstSeen: observedAt,
          lastSeen: observedAt,
          status: "active",
          askingPrice: item.askingPrice,
          priceHistory: [{ date: observedAt, price: item.askingPrice }],
          ...base,
        });
        res.inserted++;
      } else {
        const history = [...prev.priceHistory];
        if (history[history.length - 1]?.price !== item.askingPrice) {
          history.push({ date: observedAt, price: item.askingPrice });
          res.priceChanges++;
        }
        saveListing(db, {
          ...prev,
          ...base,
          // A relisted advert keeps its original first-seen date: exposure counts from the start.
          firstSeen: prev.firstSeen < observedAt ? prev.firstSeen : observedAt,
          lastSeen: observedAt > prev.lastSeen ? observedAt : prev.lastSeen,
          status: "active",
          askingPrice: item.askingPrice,
          priceHistory: history,
        });
        res.updated++;
      }
    }

    if (req.snapshot) {
      for (const l of listingsForSourceCity(db, req.source, req.snapshot.city)) {
        if (l.status === "active" && !seen.has(l.sourceId)) {
          saveListing(db, { ...l, status: "removed" });
          res.removed++;
        }
      }
    }
  })();
  return res;
}
