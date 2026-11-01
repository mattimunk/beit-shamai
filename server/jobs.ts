import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { matchListingsToDeals } from "../src/engine/matching";
import { fetchDealsByRadius, type GovmapOptions } from "./govmap";
import {
  dealsNear, listingsNear, recordJob, replacePairs, replaceStops, savePriceIndex, upsertDeals, upsertSignals,
} from "./db";
import { downloadGtfs, parseGtfs } from "./connectors/gtfs";
import { fetchDistrictIndex, type District } from "./connectors/cbs";
import { fetchRenewalSignals } from "./connectors/renewal";
import type { CityConfig, SourcesConfig } from "./config";

/** Run a job and record its outcome in job_runs (used by /health for data freshness). */
export async function runJob<T>(db: Database, job: string, scope: string, fn: () => Promise<T> | T): Promise<T> {
  const started = new Date().toISOString();
  try {
    const out = await fn();
    recordJob(db, job, scope, started, true, out);
    return out;
  } catch (e) {
    recordJob(db, job, scope, started, false, { error: (e as Error).message });
    throw e;
  }
}

/** Pull completed deals around a point from GovMap and store them. */
export async function syncDeals(
  db: Database,
  area: { lat: number; lng: number; radiusM: number },
  opt: Partial<GovmapOptions> = {},
) {
  // GovMap radius queries are capped server-side; tile large areas into 1 km cells.
  const step = 1000;
  const cells: { lat: number; lng: number }[] = [];
  const n = Math.max(1, Math.ceil(area.radiusM / step));
  for (let i = -n + 1; i < n; i++) {
    for (let j = -n + 1; j < n; j++) {
      if (Math.hypot(i, j) * step > area.radiusM + step) continue;
      cells.push({
        lat: area.lat + (j * step) / 111_320,
        lng: area.lng + (i * step) / (111_320 * Math.cos((area.lat * Math.PI) / 180)),
      });
    }
  }
  let stored = 0;
  let unmapped = 0;
  for (const c of area.radiusM <= step ? [{ lat: area.lat, lng: area.lng }] : cells) {
    const r = await fetchDealsByRadius(c, Math.min(area.radiusM, step * 0.75), opt);
    upsertDeals(db, r.deals);
    stored += r.deals.length;
    unmapped += r.unmapped;
  }
  return { stored, unmapped, cells: cells.length };
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

/** Weekly: download the national GTFS and recompute stops with peak frequencies. */
export async function syncGtfs(db: Database, url: string, dir = process.env.DATA_DIR ?? "data") {
  const path = await downloadGtfs(`${dir}/gtfs`, url);
  const r = await parseGtfs(path);
  replaceStops(db, r.stops);
  return { stops: r.stops.length, trips: r.trips, referenceDate: r.referenceDate };
}

/** Monthly: CBS dwelling price index for each configured district. */
export async function syncCbs(db: Database, districts: District[], codes: Partial<Record<District, string>>) {
  const out: Record<string, { code: string; points: number }> = {};
  for (const d of new Set(districts)) {
    const r = await fetchDistrictIndex(d, { code: codes[d] });
    savePriceIndex(db, d, r.points);
    out[d] = { code: r.code, points: r.points.length };
  }
  return out;
}

/** Weekly: renewal complexes and renewal-related plans around each city. */
export async function syncRenewal(db: Database, city: CityConfig, layers: SourcesConfig["layers"]) {
  const { signals, errors } = await fetchRenewalSignals(layers, { lat: city.lat, lng: city.lng }, city.radiusM);
  upsertSignals(db, signals, new Date().toISOString());
  if (errors.length && !signals.length) throw new Error(errors.join("; "));
  return { signals: signals.length, errors };
}

/** Daily: consistent SQLite backup into data/backups, keeping the newest `keep`. */
export function backup(db: Database, dir = `${process.env.DATA_DIR ?? "data"}/backups`, keep = 14) {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/beit-shamai-${new Date().toISOString().slice(0, 10)}.sqlite`;
  rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = readdirSync(dir).filter((f) => f.endsWith(".sqlite")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(`${dir}/${old}`);
  return { file, kept: Math.min(all.length, keep) };
}
