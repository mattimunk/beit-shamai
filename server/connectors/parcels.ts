/**
 * Parcel (גוש/חלקה) → map location, via a cadastre layer (ArcGIS), with a local cache.
 * The Tax Authority export identifies each sale only by block/parcel/sub-parcel, so this is
 * how sales get onto the map. The layer URL and field names are set in config once the
 * source check has found the cadastre layer.
 */
import type { Database } from "bun:sqlite";
import { centroid, type ArcgisLayer } from "./arcgis";
import { itmToWgs84 } from "../itm";

export interface ParcelLayer extends ArcgisLayer {
  blockField: string; // e.g. "GUSH_NUM"
  parcelField: string; // e.g. "PARCEL"
}

export function ensureParcelCache(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS parcel_cache (key TEXT PRIMARY KEY, lat REAL, lng REAL, approx INTEGER, at TEXT)`);
}

export async function locateParcel(
  db: Database,
  layer: ParcelLayer | undefined,
  block: string,
  parcel: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ lat: number; lng: number; approx: boolean } | null> {
  ensureParcelCache(db);
  const key = `${block}-${parcel}`;
  const hit: any = db.query(`SELECT lat, lng, approx FROM parcel_cache WHERE key = ?`).get(key);
  if (hit) return { lat: hit.lat, lng: hit.lng, approx: !!hit.approx };
  if (!layer) return null;

  const q = async (where: string) => {
    const params = new URLSearchParams({ f: "json", where, outFields: "*", returnGeometry: "true", outSR: String(layer.wkid) });
    const res = await fetchImpl(`${layer.url.replace(/\/$/, "")}/query?${params}`);
    if (!res.ok) throw new Error(`parcel layer ${res.status}`);
    const body = (await res.json()) as { features?: { attributes: Record<string, unknown>; geometry?: unknown }[]; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.features ?? [];
  };
  let approx = false;
  let feats = await q(`${layer.blockField} = ${Number(block)} AND ${layer.parcelField} = ${Number(parcel)}`);
  if (!feats.length) {
    // Fall back to the block's centre: same neighbourhood, flagged as approximate.
    feats = (await q(`${layer.blockField} = ${Number(block)}`)).slice(0, 50);
    approx = true;
  }
  const pts = feats.map((f) => centroid(f.geometry)).filter((p): p is { x: number; y: number } => !!p);
  if (!pts.length) return null;
  const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  const loc = layer.wkid === 2039 ? itmToWgs84(c.x, c.y) : { lat: c.y, lng: c.x };
  db.query(`INSERT OR REPLACE INTO parcel_cache (key, lat, lng, approx, at) VALUES (?, ?, ?, ?, ?)`).run(key, loc.lat, loc.lng, approx ? 1 : 0, new Date().toISOString());
  return { ...loc, approx };
}
