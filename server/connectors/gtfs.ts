/**
 * National public-transport GTFS (National Public Transport Authority, Ministry of Transport):
 *   https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip  (refreshed daily)
 *
 * Produces one TransitStop per stop with weekday morning-peak departures per hour, computed
 * from the actual timetable: services running on a reference weekday (Tuesday), departures
 * between 07:00 and 09:00. GTFS is a public standard, so this connector is well-defined;
 * only the download URL could change.
 */
import { mkdirSync } from "node:fs";
import type { TransitMode, TransitStop } from "../../src/engine/types";
import { listZip, zipLines, type ZipEntry } from "./zip";

export const GTFS_URL = "https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip";

/** GTFS route_type → our mode (basic and extended types). */
export function routeMode(routeType: number): TransitMode {
  if (routeType === 0 || (routeType >= 900 && routeType < 1000)) return "light_rail";
  if (routeType === 1 || (routeType >= 400 && routeType < 500)) return "metro";
  if (routeType === 2 || (routeType >= 100 && routeType < 200)) return "rail";
  return "bus";
}

/** CSV line parser for GTFS (quoted fields, doubled quotes; no embedded newlines). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function* rows(path: string, entry: ZipEntry): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  for await (const line of zipLines(path, entry)) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    if (!header) { header = cells.map((h) => h.replace(/^﻿/, "").trim()); continue; }
    const r: Record<string, string> = {};
    header.forEach((h, i) => (r[h] = cells[i] ?? ""));
    yield r;
  }
}

const toSec = (t: string) => {
  const [h, m, s] = t.split(":").map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
};

/** Next Tuesday (a normal Israeli working day) on or after `fromIso`, as YYYYMMDD. */
export function referenceWeekday(fromIso: string): { ymd: string; dow: number } {
  const d = new Date(fromIso + "T12:00:00Z");
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return { ymd: d.toISOString().slice(0, 10).replace(/-/g, ""), dow: 2 };
}

export interface GtfsResult {
  stops: TransitStop[];
  referenceDate: string;
  trips: number;
  stopTimesRead: number;
}

export async function parseGtfs(zipPath: string, opts: { fromIso?: string; peakFrom?: string; peakTo?: string } = {}): Promise<GtfsResult> {
  const entries = await listZip(zipPath);
  const get = (n: string) => entries.find((e) => e.name.endsWith(n));
  const need = (n: string) => { const e = get(n); if (!e) throw new Error(`GTFS missing ${n}`); return e; };

  const { ymd, dow } = referenceWeekday(opts.fromIso ?? new Date().toISOString().slice(0, 10));
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  // 1. Services active on the reference day.
  const active = new Set<string>();
  const cal = get("calendar.txt");
  if (cal) for await (const r of rows(zipPath, cal)) {
    if (r[days[dow]!] === "1" && r.start_date! <= ymd && r.end_date! >= ymd) active.add(r.service_id!);
  }
  const calDates = get("calendar_dates.txt");
  if (calDates) for await (const r of rows(zipPath, calDates)) {
    if (r.date !== ymd) continue;
    if (r.exception_type === "1") active.add(r.service_id!);
    if (r.exception_type === "2") active.delete(r.service_id!);
  }

  // 2. Route modes and trips that run that day.
  const routeModeById = new Map<string, TransitMode>();
  for await (const r of rows(zipPath, need("routes.txt"))) routeModeById.set(r.route_id!, routeMode(Number(r.route_type)));
  const tripMode = new Map<string, TransitMode>();
  for await (const r of rows(zipPath, need("trips.txt"))) {
    if (active.has(r.service_id!)) tripMode.set(r.trip_id!, routeModeById.get(r.route_id!) ?? "bus");
  }

  // 3. Stream stop_times: count peak departures per stop and the stop's best mode.
  const from = toSec(opts.peakFrom ?? "07:00:00");
  const to = toSec(opts.peakTo ?? "09:00:00");
  const count = new Map<string, number>();
  const modeRank: Record<TransitMode, number> = { bus: 0, light_rail: 1, rail: 2, metro: 3 };
  const stopMode = new Map<string, TransitMode>();
  let n = 0;
  for await (const r of rows(zipPath, need("stop_times.txt"))) {
    n++;
    const m = tripMode.get(r.trip_id!);
    if (!m) continue;
    const t = toSec(r.departure_time || r.arrival_time || "0:0:0");
    const sid = r.stop_id!;
    const prev = stopMode.get(sid);
    if (!prev || modeRank[m] > modeRank[prev]) stopMode.set(sid, m);
    if (t >= from && t < to) count.set(sid, (count.get(sid) ?? 0) + 1);
  }

  // 4. Stops.
  const hours = (to - from) / 3600;
  const stops: TransitStop[] = [];
  for await (const r of rows(zipPath, need("stops.txt"))) {
    const lat = Number(r.stop_lat);
    const lng = Number(r.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || r.location_type === "1") continue;
    const mode = stopMode.get(r.stop_id!);
    if (!mode) continue; // no service on the reference day
    stops.push({
      id: r.stop_id!,
      name: r.stop_name ?? "",
      mode,
      location: { lat, lng },
      peakDeparturesPerHour: Math.round(((count.get(r.stop_id!) ?? 0) / hours) * 10) / 10,
    });
  }
  return { stops, referenceDate: ymd, trips: tripMode.size, stopTimesRead: n };
}

/** Download the national feed to `dir` and return the file path. */
export async function downloadGtfs(dir: string, url = GTFS_URL): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GTFS download ${res.status}`);
  const path = `${dir}/israel-public-transportation.zip`;
  await Bun.write(path, res);
  return path;
}
