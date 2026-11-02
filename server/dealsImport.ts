/**
 * Import completed deals from a file: CSV (Hebrew or English headers) or JSON rows.
 * For sales data obtained through a legitimate channel (a Tax Authority data arrangement,
 * a licensed data vendor, or an appraiser's own records) while automated access is not available.
 *
 * Recognised columns: date/תאריך, price/מחיר/סכום, city/עיר/ישוב, street/רחוב, number/מספר בית,
 * block/גוש, parcel/חלקה, subParcel/תת חלקה (or gush "6789-12-8"), area/שטח, rooms/חדרים,
 * floor/קומה, floorsInBuilding/קומות בבניין, yearBuilt/שנת בנייה, newBuild/חדש, lat, lng.
 */
import type { Database } from "bun:sqlite";
import type { Deal } from "../src/engine/types";
import { parseCsvLine } from "./connectors/gtfs";
import { parseFloor, parseGush } from "./govmap";
import { geocode } from "./connectors/geocode";
import { upsertDeals } from "./db";

const ALIASES: Record<string, string[]> = {
  date: ["date", "dealdate", "תאריך", "תאריך עסקה", "יום מכירה"],
  price: ["price", "dealamount", "מחיר", "סכום", "שווי", "מחיר מוצהר", "שווי מכירה"],
  city: ["city", "settlement", "עיר", "ישוב", "יישוב"],
  street: ["street", "רחוב"],
  number: ["number", "housenumber", "מספר", "מספר בית", "בית"],
  gush: ["gush", "גוש חלקה", "גוש/חלקה"],
  block: ["block", "גוש"],
  parcel: ["parcel", "חלקה"],
  subParcel: ["subparcel", "תת חלקה", "תת-חלקה"],
  area: ["area", "sqm", "שטח", "שטח דירה", "שטח במ\"ר"],
  rooms: ["rooms", "חדרים", "מספר חדרים"],
  floor: ["floor", "קומה"],
  floorsInBuilding: ["floorsinbuilding", "floors", "קומות", "קומות בבניין", "מספר קומות"],
  yearBuilt: ["yearbuilt", "שנת בנייה", "שנת בניה"],
  newBuild: ["newbuild", "new", "חדש", "מקבלן"],
  lat: ["lat", "latitude"],
  lng: ["lng", "lon", "longitude"],
};

function canonical(h: string): string | undefined {
  const k = h.replace(/^﻿/, "").trim().toLowerCase().replace(/[_]/g, " ");
  for (const [key, names] of Object.entries(ALIASES)) if (names.some((n) => n.toLowerCase() === k)) return key;
  return undefined;
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]!).map((h) => canonical(h) ?? h);
  return lines.slice(1).map((l) => {
    const cells = parseCsvLine(l);
    const r: Record<string, string> = {};
    header.forEach((h, i) => (r[h] = (cells[i] ?? "").trim()));
    return r;
  });
}

const num = (v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || !v.trim()) return undefined;
  const n = Number(v.replace(/[,₪\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
function isoDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const ymd = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return ymd[0];
  const dmy = v.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  return dmy ? `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}` : undefined;
}

export interface DealsImportResult {
  stored: number;
  geocoded: number;
  rejected: { row: number; reason: string }[];
}

export async function importDeals(
  db: Database,
  rows: Record<string, unknown>[],
  source: string,
  geocodeImpl: typeof geocode = geocode,
): Promise<DealsImportResult> {
  const res: DealsImportResult = { stored: 0, geocoded: 0, rejected: [] };
  const deals: Deal[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const s = (k: string) => (r[k] === undefined || r[k] === null ? undefined : String(r[k]).trim() || undefined);
    const date = isoDate(s("date"));
    const price = num(r.price);
    const area = num(r.area);
    const city = s("city");
    const street = s("street");
    if (!date || !price || !area) { res.rejected.push({ row: i + 2, reason: "date, price and area are required" }); continue; }
    if (!city || !street) { res.rejected.push({ row: i + 2, reason: "city and street are required" }); continue; }
    let lat = num(r.lat), lng = num(r.lng);
    if (lat === undefined || lng === undefined) {
      try {
        const hit = (await geocodeImpl(`${street} ${s("number") ?? ""} ${city}`))[0];
        if (hit) { lat = hit.lat; lng = hit.lng; res.geocoded++; }
      } catch { /* fall through */ }
    }
    if (lat === undefined || lng === undefined) { res.rejected.push({ row: i + 2, reason: "address could not be located" }); continue; }
    const parcel = parseGush(s("gush")) ?? (s("block") && s("parcel") ? { block: String(Number(s("block"))), parcel: String(Number(s("parcel"))), subParcel: s("subParcel") ? String(Number(s("subParcel"))) : undefined } : undefined);
    const yearBuilt = num(r.yearBuilt);
    const floors = num(r.floorsInBuilding);
    deals.push({
      id: `${source}-${parcel ? `${parcel.block}-${parcel.parcel}-${parcel.subParcel ?? ""}` : `${street}${s("number") ?? ""}`}-${date}-${price}`,
      evidence: "completed_deal",
      source,
      date,
      price,
      location: { lat, lng },
      address: { city, street, number: s("number") ?? "" },
      parcel,
      area,
      rooms: num(r.rooms) ?? 0,
      floor: parseFloor(r.floor) ?? 0,
      floorsInBuilding: floors,
      elevator: floors !== undefined ? floors > 4 : undefined,
      yearBuilt,
      newBuild: /^(1|true|yes|כן|חדש|מקבלן)$/i.test(s("newBuild") ?? ""),
    });
  }
  upsertDeals(db, deals);
  res.stored = deals.length;
  return res;
}
