import type { AreaInput, AreaLevel } from "./types";

/**
 * Apartment area per Standard 9.1 ("שטח דירה").
 *
 * The standard defines the area as the polygon along the outer faces of the exterior walls.
 * For walls shared with common space or another unit only half the thickness counts, capped
 * at 10 cm. Laundry niches are excluded; attic parts count only where the height is at least
 * 1.80 m; on multi-level units the area above the upper staircase is a shaft and is not counted
 * twice. Each level is reported separately.
 *
 * This implementation approximates the polygon from measured components (internal area plus
 * wall strips). Corner overlaps of wall strips are ignored (< 0.2% on typical units).
 */
export const SHARED_WALL_CAP_CM = 10;
export const ATTIC_MIN_HEIGHT_M = 1.8;

export interface LevelAreaLine {
  key:
    | "internal"
    | "exterior_walls"
    | "shared_walls"
    | "attic_counted"
    | "laundry_niche_excluded"
    | "attic_below_180_excluded"
    | "stair_shaft_excluded";
  sqm: number;
  counted: boolean;
}

export interface LevelArea {
  name: string;
  area: number;
  lines: LevelAreaLine[];
}

export interface Area91Result {
  total: number;
  levels: LevelArea[];
  method: "declared" | "measured";
  declaredSource?: string;
}

export function levelArea91(level: AreaLevel): LevelArea {
  const ext = level.exteriorWallLengthM * (level.exteriorWallThicknessCm / 100);
  const sharedCountedCm = Math.min(level.sharedWallThicknessCm / 2, SHARED_WALL_CAP_CM);
  const shared = level.sharedWallLengthM * (sharedCountedCm / 100);
  const attic = level.atticAreaAtLeast180 ?? 0;
  const laundry = level.laundryNicheSqm ?? 0;
  const atticLow = level.atticAreaBelow180 ?? 0;
  const shaft = level.stairShaftSqm ?? 0;

  // Laundry niches and stair shafts are measured inside the polygon in the field, so they are
  // subtracted if the surveyor included them in internalArea.
  const area = level.internalArea + ext + shared + attic - laundry - shaft;
  const lines: LevelAreaLine[] = [
    { key: "internal", sqm: level.internalArea, counted: true },
    { key: "exterior_walls", sqm: ext, counted: true },
    { key: "shared_walls", sqm: shared, counted: true },
  ];
  if (attic) lines.push({ key: "attic_counted", sqm: attic, counted: true });
  if (laundry) lines.push({ key: "laundry_niche_excluded", sqm: -laundry, counted: false });
  if (atticLow) lines.push({ key: "attic_below_180_excluded", sqm: 0, counted: false });
  if (shaft) lines.push({ key: "stair_shaft_excluded", sqm: -shaft, counted: false });
  return { name: level.name, area: round2(area), lines };
}

export function area91(input: AreaInput): Area91Result {
  if (input.mode === "declared") {
    return {
      total: input.area,
      levels: [{ name: "declared", area: input.area, lines: [] }],
      method: "declared",
      declaredSource: input.source,
    };
  }
  const levels = input.levels.map(levelArea91);
  return {
    total: round2(levels.reduce((s, l) => s + l.area, 0)),
    levels,
    method: "measured",
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
