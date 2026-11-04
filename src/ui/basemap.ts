/**
 * Street-map tiles (OpenStreetMap, web-mercator) placed under the schematic map.
 *
 * The schematic works in local metres around the property; each tile's corners are converted
 * to those metres, so tiles and overlays line up (the error over ±1.1 km is well under a pixel).
 * OpenStreetMap's tile policy: show the attribution, keep usage light, no bulk downloading.
 */
import type { LatLng } from "../engine/types";
import { toLocalM } from "../engine/geo";

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const TILE_ATTRIBUTION = "© OpenStreetMap contributors";
export const TILE_COPYRIGHT_URL = "https://www.openstreetmap.org/copyright";

const lon2x = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const y2lat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

export interface PlacedTile { url: string; x: number; y: number; w: number; h: number }

/**
 * Tiles covering a square of ±halfM metres around `center`, drawn into a size×size box.
 * The zoom is picked so a tile pixel is about one screen pixel.
 */
export function basemapTiles(center: LatLng, halfM: number, size: number, url = TILE_URL): PlacedTile[] {
  const metresPerPx = (2 * halfM) / size;
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const z = Math.max(10, Math.min(18, Math.round(Math.log2((156543.03 * cosLat) / metresPerPx))));
  const dLat = halfM / 111320, dLng = halfM / (111320 * cosLat);
  const x0 = Math.floor(lon2x(center.lng - dLng, z)), x1 = Math.floor(lon2x(center.lng + dLng, z));
  const y0 = Math.floor(lat2y(center.lat + dLat, z)), y1 = Math.floor(lat2y(center.lat - dLat, z));
  const toPx = (p: LatLng) => {
    const m = toLocalM(center, p);
    return { x: size / 2 + (m.x / halfM) * (size / 2), y: size / 2 - (m.y / halfM) * (size / 2) };
  };
  const out: PlacedTile[] = [];
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const nw = toPx({ lat: y2lat(ty, z), lng: x2lon(tx, z) });
      const se = toPx({ lat: y2lat(ty + 1, z), lng: x2lon(tx + 1, z) });
      out.push({ url: url.replace("{z}", String(z)).replace("{x}", String(tx)).replace("{y}", String(ty)), x: nw.x, y: nw.y, w: se.x - nw.x, h: se.y - nw.y });
    }
  }
  return out;
}
