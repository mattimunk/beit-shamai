import { distanceM, walkMinutes } from "./geo";
import type { FutureLine, LatLng, LineMaturity, TransitMode, TransitStop } from "./types";

export interface NearestStop {
  mode: TransitMode;
  stop: TransitStop;
  walkMin: number;
  distanceM: number;
}

export interface FutureLineImpact {
  line: FutureLine;
  station: FutureLine["stations"][number];
  distanceM: number;
  band: "walk_400" | "walk_800" | "near_1500" | "far";
  /** How the report treats it, by maturity (see spec: only firm stages move value). */
  treatment: "in_comparables" | "small_upside" | "upside_no_adjustment" | "information" | "text_only";
  /** Inside the station's densification influence area (TAMA 70 for Metro). */
  inDensificationArea: boolean;
  /** Parcel listed inside the plan's expropriation line. */
  expropriationRisk: boolean;
}

export interface TransportResult {
  nearest: NearestStop[];
  /** Stops within 1.2 km, for the map. */
  stopsNearby: TransitStop[];
  /** Weighted departures/hour within a 10-minute walk. */
  frequencyScore: number;
  score: number; // 0..100
  future: FutureLineImpact[];
}

const TREATMENT: Record<LineMaturity, FutureLineImpact["treatment"]> = {
  operating: "in_comparables",
  under_construction: "small_upside",
  approved: "upside_no_adjustment",
  in_planning: "information",
  proposed: "text_only",
};

/**
 * Approximate densification radius around Metro stations until the official TAMA 70
 * influence-area layer is connected (the plan's own boundary must replace this).
 */
export const METRO_INFLUENCE_RADIUS_M = 800;

const MODE_WEIGHT: Record<TransitMode, number> = { bus: 1, light_rail: 2.5, rail: 3, metro: 3.5 };

export function analyseTransport(
  at: LatLng,
  stops: TransitStop[],
  futureLines: FutureLine[],
  parcelKey?: string,
): TransportResult {
  const modes: TransitMode[] = ["bus", "light_rail", "rail", "metro"];
  const nearest: NearestStop[] = [];
  for (const mode of modes) {
    const best = stops
      .filter((s) => s.mode === mode)
      .map((s) => ({ s, d: distanceM(at, s.location) }))
      .sort((a, b) => a.d - b.d)[0];
    if (best) {
      nearest.push({ mode, stop: best.s, distanceM: best.d, walkMin: walkMinutes(at, best.s.location) });
    }
  }

  const within10 = stops.filter((s) => walkMinutes(at, s.location) <= 10);
  const frequencyScore = within10.reduce(
    (sum, s) => sum + s.peakDeparturesPerHour * MODE_WEIGHT[s.mode],
    0,
  );
  // 0..100: saturates around 150 weighted departures/hour within a 10-minute walk.
  const score = Math.round(100 * (1 - Math.exp(-frequencyScore / 60)));

  const future: FutureLineImpact[] = futureLines
    .filter((l) => l.maturity !== "operating")
    .map((line) => {
      const best = line.stations
        .map((st) => ({ st, d: distanceM(at, st.location) }))
        .sort((a, b) => a.d - b.d)[0]!;
      const d = best.d;
      const band: FutureLineImpact["band"] =
        d <= 400 ? "walk_400" : d <= 800 ? "walk_800" : d <= 1500 ? "near_1500" : "far";
      return {
        line,
        station: best.st,
        distanceM: d,
        band,
        treatment: TREATMENT[line.maturity],
        inDensificationArea: line.mode === "metro" && d <= METRO_INFLUENCE_RADIUS_M,
        expropriationRisk: !!parcelKey && (line.expropriationParcels ?? []).includes(parcelKey),
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM);

  const stopsNearby = stops.filter((s) => distanceM(at, s.location) <= 1200);
  return { nearest, stopsNearby, frequencyScore, score, future };
}
