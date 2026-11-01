/**
 * Generic ArcGIS REST "query around a point" connector. Most Israeli government GIS layers
 * (Planning Administration plans, Urban Renewal Authority complexes, GovMap layers, municipal
 * GIS) are ArcGIS MapServer / FeatureServer layers, so one connector plus a per-layer field
 * map covers them. Layer URLs and field names live in server/config.ts.
 */
import { itmToWgs84, wgs84ToItm } from "../itm";

export interface ArcgisLayer {
  /** e.g. https://<host>/arcgis/rest/services/<folder>/<service>/MapServer/<layerId> */
  url: string;
  /** Spatial reference of the layer: 2039 = ITM (most Israeli layers), 4326 = WGS84. */
  wkid: 2039 | 4326;
  where?: string;
  outFields?: string;
}

export interface ArcgisFeature {
  attributes: Record<string, unknown>;
  /** Representative point (centroid of the polygon or the point itself), WGS84. */
  location: { lat: number; lng: number };
}

export async function queryAround(
  layer: ArcgisLayer,
  center: { lat: number; lng: number },
  radiusM: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ArcgisFeature[]> {
  const pt = layer.wkid === 2039 ? wgs84ToItm(center.lat, center.lng) : { x: center.lng, y: center.lat };
  const params = new URLSearchParams({
    f: "json",
    where: layer.where ?? "1=1",
    outFields: layer.outFields ?? "*",
    returnGeometry: "true",
    geometry: JSON.stringify({ x: pt.x, y: pt.y, spatialReference: { wkid: layer.wkid } }),
    geometryType: "esriGeometryPoint",
    inSR: String(layer.wkid),
    outSR: String(layer.wkid),
    spatialRel: "esriSpatialRelIntersects",
    distance: String(radiusM),
    units: "esriSRUnit_Meter",
  });
  const res = await fetchImpl(`${layer.url.replace(/\/$/, "")}/query?${params}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`ArcGIS ${res.status} for ${layer.url}`);
  const body = (await res.json()) as { features?: { attributes: Record<string, unknown>; geometry?: any }[]; error?: { message: string } };
  if (body.error) throw new Error(`ArcGIS error: ${body.error.message}`);
  return (body.features ?? []).flatMap((f) => {
    const c = centroid(f.geometry);
    if (!c) return [];
    const location = layer.wkid === 2039 ? itmToWgs84(c.x, c.y) : { lat: c.y, lng: c.x };
    return [{ attributes: f.attributes, location }];
  });
}

/** Point, polygon (rings) or polyline (paths) → a representative point. */
export function centroid(g: any): { x: number; y: number } | null {
  if (!g) return null;
  if (typeof g.x === "number" && typeof g.y === "number") return { x: g.x, y: g.y };
  const pts: number[][] = (g.rings ?? g.paths ?? []).flat();
  if (!pts.length) return null;
  const sx = pts.reduce((s, p) => s + p[0]!, 0);
  const sy = pts.reduce((s, p) => s + p[1]!, 0);
  return { x: sx / pts.length, y: sy / pts.length };
}

/** Read the first non-empty attribute among candidate names (case-insensitive). */
export function attr(a: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    const k = Object.keys(a).find((x) => x.toLowerCase() === n.toLowerCase());
    if (k && a[k] !== null && a[k] !== undefined && a[k] !== "") return a[k];
  }
  return undefined;
}

/** ArcGIS dates are epoch milliseconds; some layers use dd/mm/yyyy strings. */
export function arcgisDate(v: unknown): string | undefined {
  if (typeof v === "number" && v > 0) return new Date(v).toISOString().slice(0, 10);
  if (typeof v === "string") {
    const dmy = v.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
    const ymd = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymd) return ymd[0];
  }
  return undefined;
}
