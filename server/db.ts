/**
 * Storage for deals, the listing ledger and matched pairs (SQLite via bun:sqlite).
 * Rows keep the full JSON plus indexed columns for area queries. Swap for Postgres/PostGIS
 * when volume requires it; the interface stays the same.
 */
import { Database } from "bun:sqlite";
import type { Deal, Listing, PriceIndexPoint, RenewalSignal, TransitStop } from "../src/engine/types";
import type { MatchedPair } from "../src/engine/matching";
import { parcelKeyOf } from "../src/engine/market";

export function openDb(path = process.env.DB_PATH ?? "beit-shamai.sqlite"): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY, city TEXT, lat REAL, lng REAL, date TEXT, parcel_key TEXT, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deals_geo ON deals(lat, lng);
    CREATE INDEX IF NOT EXISTS deals_parcel ON deals(parcel_key);
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY, source TEXT, source_id TEXT, city TEXT, lat REAL, lng REAL,
      status TEXT, first_seen TEXT, last_seen TEXT, json TEXT NOT NULL,
      UNIQUE(source, source_id)
    );
    CREATE INDEX IF NOT EXISTS listings_geo ON listings(lat, lng);
    CREATE TABLE IF NOT EXISTS pairs (
      deal_id TEXT PRIMARY KEY, listing_id TEXT, lat REAL, lng REAL, date TEXT, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pairs_geo ON pairs(lat, lng);
    CREATE TABLE IF NOT EXISTS stops (
      id TEXT PRIMARY KEY, lat REAL, lng REAL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stops_geo ON stops(lat, lng);
    CREATE TABLE IF NOT EXISTS price_index (
      district TEXT, month TEXT, value REAL, PRIMARY KEY (district, month)
    );
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY, lat REAL, lng REAL, json TEXT NOT NULL, fetched_at TEXT
    );
    CREATE INDEX IF NOT EXISTS signals_geo ON signals(lat, lng);
    CREATE TABLE IF NOT EXISTS job_runs (
      job TEXT, scope TEXT, started_at TEXT, finished_at TEXT, ok INTEGER, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job, scope, started_at);
  `);
  return db;
}

/** Bounding box in degrees around a point (pre-filter before exact distance). */
export function bbox(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

export function upsertDeals(db: Database, deals: Deal[]): number {
  const stmt = db.prepare(
    `INSERT INTO deals (id, city, lat, lng, date, parcel_key, json) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
  );
  const tx = db.transaction((rows: Deal[]) => {
    for (const d of rows) {
      stmt.run(d.id, d.address.city, d.location.lat, d.location.lng, d.date, d.parcel ? parcelKeyOf(d.parcel) : null, JSON.stringify(d));
    }
  });
  tx(deals);
  return deals.length;
}

export function dealsNear(db: Database, lat: number, lng: number, radiusM: number, sinceIso = "0000"): Deal[] {
  const b = bbox(lat, lng, radiusM);
  return db
    .query(`SELECT json FROM deals WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND date >= ?`)
    .all(b.minLat, b.maxLat, b.minLng, b.maxLng, sinceIso)
    .map((r: any) => JSON.parse(r.json) as Deal);
}

export function dealsByParcel(db: Database, key: string): Deal[] {
  return db.query(`SELECT json FROM deals WHERE parcel_key = ?`).all(key).map((r: any) => JSON.parse(r.json) as Deal);
}

export function getListingBySource(db: Database, source: string, sourceId: string): Listing | null {
  const r: any = db.query(`SELECT json FROM listings WHERE source = ? AND source_id = ?`).get(source, sourceId);
  return r ? (JSON.parse(r.json) as Listing) : null;
}

export function saveListing(db: Database, l: Listing) {
  db.query(
    `INSERT INTO listings (id, source, source_id, city, lat, lng, status, first_seen, last_seen, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, source_id) DO UPDATE SET
       city = excluded.city, lat = excluded.lat, lng = excluded.lng, status = excluded.status,
       first_seen = excluded.first_seen, last_seen = excluded.last_seen, json = excluded.json`,
  ).run(l.id, l.source, l.sourceId, l.address.city, l.location.lat, l.location.lng, l.status, l.firstSeen, l.lastSeen, JSON.stringify(l));
}

export function listingsNear(db: Database, lat: number, lng: number, radiusM: number): Listing[] {
  const b = bbox(lat, lng, radiusM);
  return db
    .query(`SELECT json FROM listings WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`)
    .all(b.minLat, b.maxLat, b.minLng, b.maxLng)
    .map((r: any) => JSON.parse(r.json) as Listing);
}

export function listingsForSourceCity(db: Database, source: string, city: string): Listing[] {
  return db
    .query(`SELECT json FROM listings WHERE source = ? AND city = ?`)
    .all(source, city)
    .map((r: any) => JSON.parse(r.json) as Listing);
}

export function replacePairs(db: Database, pairs: MatchedPair[], dealIds: string[]) {
  const del = db.prepare(`DELETE FROM pairs WHERE deal_id = ?`);
  const ins = db.prepare(`INSERT OR REPLACE INTO pairs (deal_id, listing_id, lat, lng, date, json) VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const id of dealIds) del.run(id);
    for (const p of pairs) ins.run(p.deal.id, p.listing.id, p.deal.location.lat, p.deal.location.lng, p.deal.date, JSON.stringify(p));
  })();
}

export function pairsNear(db: Database, lat: number, lng: number, radiusM: number, sinceIso = "0000"): MatchedPair[] {
  const b = bbox(lat, lng, radiusM);
  return db
    .query(`SELECT json FROM pairs WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND date >= ?`)
    .all(b.minLat, b.maxLat, b.minLng, b.maxLng, sinceIso)
    .map((r: any) => JSON.parse(r.json) as MatchedPair);
}

export function replaceStops(db: Database, stops: TransitStop[]) {
  const ins = db.prepare(`INSERT INTO stops (id, lat, lng, json) VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    db.exec("DELETE FROM stops");
    for (const s of stops) ins.run(s.id, s.location.lat, s.location.lng, JSON.stringify(s));
  })();
}

export function stopsNear(db: Database, lat: number, lng: number, radiusM: number): TransitStop[] {
  const b = bbox(lat, lng, radiusM);
  return db
    .query(`SELECT json FROM stops WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`)
    .all(b.minLat, b.maxLat, b.minLng, b.maxLng)
    .map((r: any) => JSON.parse(r.json) as TransitStop);
}

export function savePriceIndex(db: Database, district: string, pts: PriceIndexPoint[]) {
  const ins = db.prepare(`INSERT OR REPLACE INTO price_index (district, month, value) VALUES (?, ?, ?)`);
  db.transaction(() => { for (const p of pts) ins.run(district, p.month, p.value); })();
}

export function priceIndex(db: Database, district: string): PriceIndexPoint[] {
  return db.query(`SELECT month, value FROM price_index WHERE district = ? ORDER BY month`).all(district) as PriceIndexPoint[];
}

export function upsertSignals(db: Database, signals: RenewalSignal[], fetchedAt: string) {
  const ins = db.prepare(`INSERT OR REPLACE INTO signals (id, lat, lng, json, fetched_at) VALUES (?, ?, ?, ?, ?)`);
  db.transaction(() => { for (const s of signals) ins.run(s.id, s.location.lat, s.location.lng, JSON.stringify(s), fetchedAt); })();
}

export function signalsNear(db: Database, lat: number, lng: number, radiusM: number): RenewalSignal[] {
  const b = bbox(lat, lng, radiusM);
  return db
    .query(`SELECT json FROM signals WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`)
    .all(b.minLat, b.maxLat, b.minLng, b.maxLng)
    .map((r: any) => JSON.parse(r.json) as RenewalSignal);
}

export function recordJob(db: Database, job: string, scope: string, startedAt: string, ok: boolean, detail: unknown) {
  db.query(`INSERT INTO job_runs (job, scope, started_at, finished_at, ok, detail) VALUES (?, ?, ?, ?, ?, ?)`).run(
    job, scope, startedAt, new Date().toISOString(), ok ? 1 : 0, JSON.stringify(detail),
  );
}

export function lastRun(db: Database, job: string, scope = "*", okOnly = true): { started_at: string; finished_at: string; ok: number; detail: string } | null {
  return db
    .query(`SELECT started_at, finished_at, ok, detail FROM job_runs WHERE job = ? AND scope = ? ${okOnly ? "AND ok = 1" : ""} ORDER BY started_at DESC LIMIT 1`)
    .get(job, scope) as any;
}
