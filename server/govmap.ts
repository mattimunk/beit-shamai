/**
 * Completed-deal connector: Israel Tax Authority deals as served by GovMap.
 *
 *   GET https://www.govmap.gov.il/api/real-estate/deals/{point}/{radius}
 *   GET https://www.govmap.gov.il/api/real-estate/street-deals/{polygonId}
 *   GET https://www.govmap.gov.il/api/real-estate/neighborhood-deals/{polygonId}
 *
 * These endpoints are public but undocumented, and they answer Israeli IPs only. Field names
 * have varied between versions, so mapDeal() accepts several spellings and records anything it
 * could not map. VERIFY against a live response with `bun run server/probe.ts` from an
 * Israeli host before relying on it, and keep fixtures of real responses in tests.
 */
import type { Deal, ParcelId } from "../src/engine/types";
import { itmToWgs84, wgs84ToItm } from "./itm";

export interface GovmapOptions {
  baseUrl: string;
  /** How the {point} path segment is written. Default "x,y" in ITM metres. */
  pointFormat: (itm: { x: number; y: number }) => string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /**
   * Optional HTTP proxy (DEALS_PROXY). The Tax Authority / GovMap may refuse data-centre IPs
   * even inside Israel; if the probe fails from the cloud server, route through an Israeli
   * ISP proxy or a small machine on an Israeli office line.
   */
  proxy?: string;
}

export const GOVMAP_DEFAULTS: GovmapOptions = {
  baseUrl: "https://www.govmap.gov.il/api",
  pointFormat: ({ x, y }) => `${Math.round(x)},${Math.round(y)}`,
  fetchImpl: fetch,
  timeoutMs: 20_000,
  proxy: process.env.DEALS_PROXY || undefined,
};

export async function fetchDealsByRadius(
  center: { lat: number; lng: number },
  radiusM: number,
  opt: Partial<GovmapOptions> = {},
): Promise<{ deals: Deal[]; unmapped: number; raw: unknown }> {
  const o = { ...GOVMAP_DEFAULTS, ...opt };
  const url = `${o.baseUrl}/real-estate/deals/${o.pointFormat(wgs84ToItm(center.lat, center.lng))}/${Math.round(radiusM)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
  try {
    const init: RequestInit & { proxy?: string } = { headers: { accept: "application/json" }, signal: ctrl.signal };
    if (o.proxy) init.proxy = o.proxy; // Bun fetch supports a per-request proxy
    const res = await o.fetchImpl(url, init);
    if (!res.ok) throw new Error(`GovMap ${res.status} for ${url}`);
    const raw = await res.json();
    const rows = extractRows(raw);
    const deals: Deal[] = [];
    let unmapped = 0;
    for (const r of rows) {
      const d = mapDeal(r);
      if (d) deals.push(d);
      else unmapped++;
    }
    return { deals, unmapped, raw };
  } finally {
    clearTimeout(timer);
  }
}

/** The payload may be an array, or wrap it in data / items / deals / results. */
export function extractRows(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    for (const k of ["data", "items", "deals", "results", "Results"]) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
      if (v && typeof v === "object") {
        const inner = extractRows(v);
        if (inner.length) return inner;
      }
    }
  }
  return [];
}

function pick(r: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (r[k] !== undefined && r[k] !== null && r[k] !== "") return r[k];
    const lower = Object.keys(r).find((x) => x.toLowerCase() === k.toLowerCase());
    if (lower && r[lower] !== undefined && r[lower] !== null && r[lower] !== "") return r[lower];
  }
  return undefined;
}
const num = (v: unknown) => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,₪\s]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/** Floors are often Hebrew words in the registry ("קרקע", "שלישית", "מרתף"). */
const FLOOR_WORDS: Record<string, number> = {
  "מרתף": -1, "קרקע": 0, "ראשונה": 1, "שניה": 2, "שנייה": 2, "שלישית": 3, "רביעית": 4, "חמישית": 5,
  "שישית": 6, "שביעית": 7, "שמינית": 8, "תשיעית": 9, "עשירית": 10, "אחת עשרה": 11, "שתים עשרה": 12,
  "שלוש עשרה": 13, "ארבע עשרה": 14, "חמש עשרה": 15, "שש עשרה": 16, "שבע עשרה": 17, "שמונה עשרה": 18,
  "תשע עשרה": 19, "עשרים": 20,
};
export function parseFloor(v: unknown): number | undefined {
  const n = num(v);
  if (n !== undefined) return n;
  if (typeof v !== "string") return undefined;
  const s = v.replace(/קומה/g, "").trim();
  const m = s.match(/-?\d+/);
  if (m) return Number(m[0]);
  // longest word first so "אחת עשרה" beats "עשרה"
  const hit = Object.keys(FLOOR_WORDS).sort((a, b) => b.length - a.length).find((w) => s.includes(w));
  return hit !== undefined ? FLOOR_WORDS[hit] : undefined;
}

/** "6789-12-8", "006789-0012-008", "6789/12/8" → ParcelId. */
export function parseGush(v: unknown): ParcelId | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const parts = String(v).split(/[-/\s]+/).filter(Boolean).map((p) => String(Number(p)));
  if (parts.length < 2 || parts.some((p) => p === "NaN")) return undefined;
  return { block: parts[0]!, parcel: parts[1]!, subParcel: parts[2] && parts[2] !== "0" ? parts[2] : undefined };
}

function isoDate(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v);
  // Take calendar dates literally: parsing "2026-05-17T00:00:00" as local time would shift it.
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

/** Map one raw row to a Deal; null if a required field is missing. */
export function mapDeal(r: Record<string, unknown>): Deal | null {
  const price = num(pick(r, ["dealAmount", "deal_amount", "DEALAMOUNT", "price", "dealSum"]));
  const date = isoDate(pick(r, ["dealDate", "deal_date", "DEALDATETIME", "DEALDATE", "saleDate"]));
  const area = num(pick(r, ["assetArea", "asset_area", "ASSETAREA", "area", "squareMeters", "DEALNATURE_AREA"]));
  if (!price || !date || !area) return null;

  let location: { lat: number; lng: number } | undefined;
  const lat = num(pick(r, ["lat", "latitude"]));
  const lng = num(pick(r, ["lng", "lon", "longitude"]));
  const x = num(pick(r, ["x", "X", "itmX", "coordX"]));
  const y = num(pick(r, ["y", "Y", "itmY", "coordY"]));
  if (lat !== undefined && lng !== undefined) location = { lat, lng };
  else if (x !== undefined && y !== undefined) location = itmToWgs84(x, y);
  if (!location) return null;

  const parcel = parseGush(pick(r, ["gush", "GUSH", "gushHelka", "blockParcel"]))
    ?? (() => {
      const b = pick(r, ["block", "gushNum"]);
      const p = pick(r, ["parcel", "helka", "helkaNum"]);
      const s = pick(r, ["subParcel", "tatHelka", "tat_helka"]);
      return b && p ? { block: String(Number(b)), parcel: String(Number(p)), subParcel: s ? String(Number(s)) : undefined } : undefined;
    })();

  const addressText = String(pick(r, ["address", "address_description", "fullAddress", "displayAdress"]) ?? "");
  const street = String(pick(r, ["streetName", "streetNameHeb", "street"]) ?? addressText.replace(/\s*\d+\S*\s*$/, ""));
  const number = String(pick(r, ["houseNum", "houseNumber", "HOUSENUM"]) ?? (addressText.match(/(\d+\S*)\s*$/)?.[1] ?? ""));
  const city = String(pick(r, ["settlementNameHeb", "cityName", "city", "settlement"]) ?? "");

  const yearBuilt = num(pick(r, ["buildingYear", "yearBuilt", "BUILDINGYEAR", "buildYear"]));
  const floors = num(pick(r, ["buildingFloors", "BUILDINGFLOORS", "floorsInBuilding"]));
  const nature = String(pick(r, ["dealNature", "DEALNATUREDESCRIPTION", "assetType"]) ?? "");
  const newBuild = /קבלן|חדש|new/i.test(String(pick(r, ["isNewProject", "newProject", "sellerType"]) ?? "")) ;

  const id = String(
    pick(r, ["objectid", "OBJECTID", "id", "dealId"]) ??
      `${parcel ? `${parcel.block}-${parcel.parcel}-${parcel.subParcel ?? ""}` : `${street}${number}`}-${date}-${price}`,
  );

  return {
    id: `tax-${id}`,
    evidence: "completed_deal",
    source: "tax_authority",
    date,
    price,
    location,
    address: { city, street, number },
    parcel,
    area,
    rooms: num(pick(r, ["assetRoomNum", "rooms", "ASSETROOMNUM", "roomNum"])) ?? 0,
    floor: parseFloor(pick(r, ["floorNo", "floor", "FLOORNO", "floorNumber"])) ?? 0,
    floorsInBuilding: floors ?? 0,
    elevator: (floors ?? 0) > 4,
    yearBuilt: yearBuilt ?? 0,
    newBuild: newBuild || /מקבלן/.test(nature),
  };
}
