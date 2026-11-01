import type { LatLng } from "./types";

const R = 6371000; // metres

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Street-network walking distance approximated from straight-line distance. */
export const WALK_DETOUR_FACTOR = 1.3;
export const WALK_M_PER_MIN = 80;

export function walkMinutes(a: LatLng, b: LatLng): number {
  return (distanceM(a, b) * WALK_DETOUR_FACTOR) / WALK_M_PER_MIN;
}

/** Offset a point by metres east / north (used by the demo data generator and the map). */
export function offsetM(origin: LatLng, eastM: number, northM: number): LatLng {
  const dLat = northM / 111320;
  const dLng = eastM / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}

/** Project a point to metres east / north of an origin (inverse of offsetM). */
export function toLocalM(origin: LatLng, p: LatLng): { x: number; y: number } {
  return {
    x: (p.lng - origin.lng) * 111320 * Math.cos((origin.lat * Math.PI) / 180),
    y: (p.lat - origin.lat) * 111320,
  };
}
