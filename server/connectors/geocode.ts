/**
 * Address search for Israeli addresses.
 *
 * GovMap's own search is protected by reCAPTCHA and is not used. Providers:
 *  - Google Geocoding API when GOOGLE_MAPS_API_KEY is set (paid, best Hebrew coverage)
 *  - otherwise OpenStreetMap Nominatim (free; usage policy: identify the app, at most
 *    1 request per second, cache results, show "© OpenStreetMap contributors")
 */
import { itmToWgs84 } from "../itm";

export interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
  city?: string;
  street?: string;
  number?: string;
  attribution?: string;
}

export function parseAddressLabel(label: string): { street?: string; number?: string; city?: string } {
  // "הדקל 14, קריית הדגמה" / "רחוב הדקל 14 קריית הדגמה"
  const m = label.match(/^(?:רחוב\s+)?(.+?)\s+(\d+[א-תa-z]?)\s*,?\s*(.*)$/i);
  return m ? { street: m[1]!.trim(), number: m[2], city: m[3]?.trim() || undefined } : {};
}

/** GovMap autocomplete payloads (kept for the official, token-based API if adopted later). */
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
        if (x > 1_000_000) return [];
        if (x > 100_000) ({ lat, lng } = itmToWgs84(x, y));
        else { lng = x; lat = y; }
      }
    }
    if (!label || lat === undefined || lng === undefined) return [];
    return [{ label, lat, lng, ...parseAddressLabel(label) }];
  });
}

/** Nominatim jsonv2 with addressdetails=1. */
export function parseNominatim(json: any): GeocodeHit[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((r: any) => {
    const lat = Number(r.lat), lng = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const a = r.address ?? {};
    const city = a.city ?? a.town ?? a.village ?? a.municipality;
    const street = a.road ?? a.pedestrian ?? a.street;
    const number = a.house_number;
    const label = street ? `${street}${number ? ` ${number}` : ""}${city ? `, ${city}` : ""}` : String(r.display_name ?? "");
    return [{ label, lat, lng, city, street, number, attribution: "© OpenStreetMap contributors" }];
  });
}

/** Google Geocoding API results. */
export function parseGoogle(json: any): GeocodeHit[] {
  return (json?.results ?? []).flatMap((r: any) => {
    const loc = r.geometry?.location;
    if (!loc) return [];
    const comp = (t: string) => r.address_components?.find((c: any) => c.types?.includes(t))?.long_name;
    return [{ label: r.formatted_address, lat: loc.lat, lng: loc.lng, city: comp("locality"), street: comp("route"), number: comp("street_number") }];
  });
}

const cache = new Map<string, { at: number; hits: GeocodeHit[] }>();
let lastNominatim = 0;

export async function geocode(q: string, fetchImpl: typeof fetch = fetch): Promise<GeocodeHit[]> {
  const key = q.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 7 * 86_400_000) return hit.hits;

  let hits: GeocodeHit[];
  const gkey = process.env.GOOGLE_MAPS_API_KEY;
  if (gkey) {
    const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=il&language=he&components=country:IL&key=${gkey}`;
    const res = await fetchImpl(u);
    if (!res.ok) throw new Error(`Google geocoding ${res.status}`);
    hits = parseGoogle(await res.json());
  } else {
    // Nominatim refuses anonymous callers: its policy asks for a real contact.
    const contact = process.env.CONTACT_EMAIL?.trim();
    if (!contact || !contact.includes("@")) throw new Error("address search needs CONTACT_EMAIL (or GOOGLE_MAPS_API_KEY) in .env");
    // Respect Nominatim's 1 request/second policy.
    const wait = 1100 - (Date.now() - lastNominatim);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatim = Date.now();
    const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&countrycodes=il&limit=6&addressdetails=1&accept-language=he`;
    const res = await fetchImpl(u, {
      headers: { "user-agent": `BeitShamai/0.1 (${contact})`, "from": contact, accept: "application/json" },
    });
    if (res.status === 403) throw new Error("Nominatim 403: blocked – check CONTACT_EMAIL in .env; blocks lift by themselves within a day");
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    hits = parseNominatim(await res.json());
  }
  cache.set(key, { at: Date.now(), hits });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return hits;
}
