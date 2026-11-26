/**
 * Block and parcel of a property from Over's property lookup ("נדל״ן לעם", /api/nadlan).
 *
 * By address (city + street + number): Over places the address from the address register,
 * the local authority's layer or GovMap, and takes the parcel whose outline contains it
 * ("pip"). By point (radius 0): the parcel under the point. Both answer with the same
 * envelope; the shape below is from a real answer (Nahum Lipshitz 15, Jerusalem → 30002/34).
 *
 * The address gives the building's parcel. The sub-parcel (the flat) is not tied to an
 * address anywhere public; it comes from the registry extract.
 */
import type { OverApi } from "./over";

interface NadlanHit {
  parcel_key?: string;
  identity?: {
    gush?: number | string;
    gush_suffix?: number | string | null;
    helka?: number | string;
    point?: { lat?: number; lon?: number };
    addresses?: { house?: number | string | null; neighbourhood?: string | null; match?: string }[];
  };
  sources?: {
    parcels?: { fields?: { legal_area?: number | null; status?: string | null } };
    gazetteer?: { fields?: { n_subparcels?: number | null; floors_max?: number | null; building_year_min?: number | null; building_year_max?: number | null } };
  };
  match?: { method?: string; confidence?: string };
}

export interface ParcelLookup {
  block: string;
  parcel: string;
  subBlock?: string; // תת-גוש, when not 0
  method: "address" | "point";
  confidence?: string;
  /** Over's parcel layer: "מוסדר" for settled land. */
  status?: string;
  legalArea?: number;
  neighbourhood?: string;
  subParcels?: number;
  floorsMax?: number;
  buildingYear?: number;
}

const str = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : String(v).trim());

function toLookup(h: NadlanHit, method: ParcelLookup["method"]): ParcelLookup | null {
  const block = str(h.identity?.gush), parcel = str(h.identity?.helka);
  if (!block || !parcel || !/^\d+$/.test(block) || !/^\d+$/.test(parcel)) return null;
  const suffix = str(h.identity?.gush_suffix);
  const p = h.sources?.parcels?.fields, g = h.sources?.gazetteer?.fields;
  return {
    block, parcel,
    subBlock: suffix && suffix !== "0" ? suffix : undefined,
    method,
    confidence: h.match?.confidence,
    status: str(p?.status),
    legalArea: p?.legal_area ?? undefined,
    neighbourhood: str(h.identity?.addresses?.find((a) => a.neighbourhood)?.neighbourhood),
    subParcels: g?.n_subparcels ?? undefined,
    floorsMax: g?.floors_max ?? undefined,
    buildingYear: g?.building_year_min ?? undefined,
  };
}

/** House number without letters/entrance: "15א" → 15. */
const houseNo = (n?: string) => (n ? Number(String(n).match(/\d+/)?.[0]) : NaN);

/**
 * The property's block and parcel: by address first; by the map point when the address has no
 * single match. Null when Over can't place it (or can't be reached).
 */
export async function lookupParcel(
  api: Pick<OverApi, "get">,
  q: { city?: string; street?: string; number?: string; lat?: number; lng?: number },
): Promise<ParcelLookup | null> {
  if (q.city && q.street && Number.isFinite(houseNo(q.number))) {
    const res = await api.get<{ data?: NadlanHit[] }>("/nadlan/address", { city: q.city, street: q.street, number: houseNo(q.number) }).catch(() => null);
    const hits = res?.data ?? [];
    // Several parcels: keep the one that holds this very house number, if exactly one does.
    const exact = hits.filter((h) => h.identity?.addresses?.some((a) => Number(a.house) === houseNo(q.number)));
    const pick = hits.length === 1 ? hits[0] : exact.length === 1 ? exact[0] : undefined;
    const found = pick && toLookup(pick, "address");
    if (found) return found;
  }
  if (Number.isFinite(q.lat) && Number.isFinite(q.lng)) {
    const res = await api.get<{ data?: NadlanHit[] }>("/nadlan/lookup", { lat: q.lat, lon: q.lng, radius_m: 0 }).catch(() => null);
    const hit = res?.data?.[0];
    const found = hit && toLookup(hit, "point");
    if (found) return found;
  }
  return null;
}
