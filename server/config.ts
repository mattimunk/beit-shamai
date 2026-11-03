/**
 * Server configuration: which cities to keep fresh, and where each public source lives.
 * Defaults can be overridden by config/sources.json (copy config/sources.example.json).
 *
 * Layer URLs marked `verify: true` are best-known addresses that must be confirmed from an
 * Israeli host with `bun run server/probe.ts` before going live.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ArcgisLayer } from "./connectors/arcgis";
import type { ParcelLayer } from "./connectors/parcels";
import type { District } from "./connectors/cbs";
import type { CityPolicy, FutureLine } from "../src/engine/types";

export interface CityConfig {
  name: string; // as written in Tax Authority records, e.g. "תל אביב יפו"
  lat: number;
  lng: number;
  radiusM: number;
  district: District;
}

export interface SourcesConfig {
  cities: CityConfig[];
  gtfsUrl: string;
  cbs: { codes: Partial<Record<District, string>> };
  layers: {
    plans?: ArcgisLayer & { verify?: boolean };
    complexes?: ArcgisLayer & { verify?: boolean };
    /** Cadastre layer for locating Tax Authority deals by block/parcel. */
    parcels?: ParcelLayer & { verify?: boolean };
  };
  /** Curated by the methodology team: future lines with statutory status and stations. */
  futureLines: FutureLine[];
  /** Curated per-city renewal policy. */
  cityPolicies: CityPolicy[];
  schedule: {
    dealsHourUtc: number; // nightly deals sync + matching
    gtfsDay: number; // weekly, 0 = Sunday
    renewalDay: number;
    cbsDayOfMonth: number;
    backupHourUtc: number;
  };
}

export const DEFAULT_SOURCES: SourcesConfig = {
  cities: [],
  gtfsUrl: "https://gtfs.mot.gov.il/gtfsfiles/israel-public-transportation.zip",
  cbs: { codes: {} },
  layers: {
    plans: {
      // Planning Administration public plans layer (XPLAN). Verify layer id and fields.
      url: "https://ags.iplan.gov.il/arcgisiplan/rest/services/PlanningPublic/Xplan/MapServer/1",
      wkid: 2039,
      verify: true,
    },
    // Urban Renewal Authority complexes: set the layer URL once confirmed (GovMap / authority GIS).
    complexes: undefined,
  },
  futureLines: [],
  cityPolicies: [],
  schedule: { dealsHourUtc: 0, gtfsDay: 0, renewalDay: 1, cbsDayOfMonth: 17, backupHourUtc: 1 },
};

export function loadSources(path = process.env.SOURCES_PATH ?? "config/sources.json"): SourcesConfig {
  if (!existsSync(path)) return DEFAULT_SOURCES;
  const user = JSON.parse(readFileSync(path, "utf8")) as Partial<SourcesConfig>;
  return {
    ...DEFAULT_SOURCES,
    ...user,
    cbs: { codes: { ...DEFAULT_SOURCES.cbs.codes, ...(user.cbs?.codes ?? {}) } },
    layers: { ...DEFAULT_SOURCES.layers, ...(user.layers ?? {}) },
    schedule: { ...DEFAULT_SOURCES.schedule, ...(user.schedule ?? {}) },
  };
}
