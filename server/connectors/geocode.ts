/**
 * Address search via GovMap's public autocomplete (Israeli addresses, Hebrew or English).
 *   POST https://www.govmap.gov.il/api/search-service/autocomplete
 * Undocumented: the request body and response shape are handled tolerantly; verify with the
 * probe script from an Israeli host.
 */
import { itmToWgs84 } from "../itm";
import { GOVMAP_HEADERS } from "../govmap";

export interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
  city?: string;
  street?: string;
  number?: string;
}

export function parseAddressLabel(label: string): { street?: string; number?: string; city?: string } {
  // "הדקל 14, קריית הדגמה" / "רחוב הדקל 14 קריית הדגמה"
  const m = label.match(/^(?:רחוב\s+)?(.+?)\s+(\d+[א-תa-z]?)\s*,?\s*(.*)$/i);
  return m ? { street: m[1]!.trim(), number: m[2], city: m[3]?.trim() || undefined } : {};
}

export function parseAutocomplete(json: any): GeocodeHit[] {
  const list: any[] = json?.results ?? json?.data ?? json?.Results ?? (Array.isArray(json) ? json : []);
  return list.flatMap((r) => {
    const label = String(r.displayName ?? r.text ?? r.ResultLable ?? r.label ?? "");
    let lat: number | undefined, lng: number | undefined;
    const p = r.point ?? r.shape ?? r;
    if (typeof p?.lat === "number" && typeof p?.lng === "number") ({ lat, lng } = p);
    else {
      let x = p?.x ?? p?.X, y = p?.y ?? p?.Y;
      if (typeof p === "string") {
        const m = p.match(/(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)/);
        if (m) { x = Number(m[1]); y = Number(m[2]); }
      }
      if (typeof x === "number" && typeof y === "number") {
        if (x > 1_000_000) return []; // web mercator not supported
        if (x > 100_000) ({ lat, lng } = itmToWgs84(x, y));
        else { lng = x; lat = y; }
      }
    }
    if (!label || lat === undefined || lng === undefined) return [];
    return [{ label, lat, lng, ...parseAddressLabel(label) }];
  });
}

export async function geocode(q: string, fetchImpl: typeof fetch = fetch): Promise<GeocodeHit[]> {
  const init: RequestInit & { proxy?: string } = {};
  if (process.env.DEALS_PROXY) init.proxy = process.env.DEALS_PROXY;
  const res = await fetchImpl("https://www.govmap.gov.il/api/search-service/autocomplete", {
    method: "POST",
    headers: { ...GOVMAP_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ searchText: q, language: "he", isAccurate: false, maxResults: 8 }),
    ...init,
  });
  if (!res.ok) throw new Error(`GovMap autocomplete ${res.status}`);
  return parseAutocomplete(await res.json());
}
