import { describe, expect, test } from "bun:test";
import { area91, levelArea91 } from "../src/engine/area";
import { DEFAULT_CONFIG, valueAddOn } from "../src/engine/coefficients";
import { adjustComparable } from "../src/engine/comparables";
import { analyseTransport } from "../src/engine/location";
import { nearbyProjects, renewalPotential } from "../src/engine/renewal";
import { offsetM } from "../src/engine/geo";
import { weightedQuantile } from "../src/engine/stats";
import { valuate } from "../src/engine/valuation";
import { DemoProvider, DEMO_ORIGIN, DEMO_VALUATION_DATE } from "../src/data/demo/demoProvider";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";
import type { Deal, RenewalSignal } from "../src/engine/types";

describe("Standard 9.1 area", () => {
  test("shared walls count half thickness, capped at 10 cm", () => {
    const thin = levelArea91({ name: "a", internalArea: 80, exteriorWallLengthM: 0, exteriorWallThicknessCm: 0, sharedWallLengthM: 10, sharedWallThicknessCm: 16 });
    expect(thin.area).toBeCloseTo(80 + 10 * 0.08, 5);
    const thick = levelArea91({ name: "a", internalArea: 80, exteriorWallLengthM: 0, exteriorWallThicknessCm: 0, sharedWallLengthM: 10, sharedWallThicknessCm: 40 });
    expect(thick.area).toBeCloseTo(80 + 10 * 0.1, 5); // safe-room wall 40 cm → capped at 10
  });

  test("exterior walls count to their outer face; laundry niche excluded", () => {
    const l = levelArea91({ name: "a", internalArea: 90, exteriorWallLengthM: 20, exteriorWallThicknessCm: 25, sharedWallLengthM: 0, sharedWallThicknessCm: 0, laundryNicheSqm: 1.5 });
    expect(l.area).toBeCloseTo(90 + 5 - 1.5, 5);
  });

  test("attic counts only from 1.80 m, multi-level summed and reported per level", () => {
    const r = area91({
      mode: "measured",
      levels: [
        { name: "lower", internalArea: 70, exteriorWallLengthM: 0, exteriorWallThicknessCm: 0, sharedWallLengthM: 0, sharedWallThicknessCm: 0 },
        { name: "upper", internalArea: 30, exteriorWallLengthM: 0, exteriorWallThicknessCm: 0, sharedWallLengthM: 0, sharedWallThicknessCm: 0, atticAreaAtLeast180: 10, atticAreaBelow180: 8, stairShaftSqm: 3 },
      ],
    });
    expect(r.levels).toHaveLength(2);
    expect(r.total).toBeCloseTo(70 + 30 + 10 - 3, 5);
  });
});

describe("add-on coefficients", () => {
  test("garden uses declining scale", () => {
    const l = valueAddOn({ type: "garden", area: 50, attachment: "attached", permitted: true }, DEFAULT_CONFIG);
    expect(l.equivalentSqm).toBeCloseTo(30 * 0.25 + 20 * 0.12, 5);
  });
  test("assigned and unpermitted areas are discounted", () => {
    const base = valueAddOn({ type: "storage", area: 10, attachment: "attached", permitted: true }, DEFAULT_CONFIG);
    const assigned = valueAddOn({ type: "storage", area: 10, attachment: "assigned", permitted: true }, DEFAULT_CONFIG);
    const illegal = valueAddOn({ type: "storage", area: 10, attachment: "attached", permitted: false }, DEFAULT_CONFIG);
    expect(assigned.equivalentSqm).toBeCloseTo(base.equivalentSqm * DEFAULT_CONFIG.assignedFactor, 5);
    expect(illegal.equivalentSqm).toBeCloseTo(base.equivalentSqm * DEFAULT_CONFIG.unpermittedFactor, 5);
  });
  test("parking is a fixed NIS value", () => {
    const l = valueAddOn({ type: "parking", count: 2, parkingKind: "underground", attachment: "attached", permitted: true }, DEFAULT_CONFIG);
    expect(l.fixedNis).toBe(2 * DEFAULT_CONFIG.parkingNis.underground);
    expect(l.equivalentSqm).toBe(0);
  });
});

describe("comparable adjustments", () => {
  const deal: Deal = {
    id: "d", evidence: "completed_deal", source: "t", date: "2025-11-15", price: 3_000_000,
    location: DEMO_ORIGIN, address: { city: "x", street: "y", number: "1" }, area: 100, rooms: 4,
    floor: 2, floorsInBuilding: 4, elevator: false, yearBuilt: 1975, newBuild: false, parkingSpaces: 0,
  };
  const index = [{ month: "2025-11", value: 100 }, { month: "2026-11", value: 103 }];

  test("identical comparable gets only time and assumed-condition lines", () => {
    const subj = { ...DEMO_SUBJECT, condition: "original" as const };
    const r = adjustComparable(subj, deal, "2026-11-01", index, DEFAULT_CONFIG);
    expect(r.rawPpsqm).toBe(30_000);
    expect(r.adjustedPpsqm).toBeCloseTo(30_900, 0);
    expect(r.adjustments.find((a) => a.key === "condition")?.assumed).toBe(true);
  });

  test("parking is removed before price per sqm", () => {
    const r = adjustComparable(DEMO_SUBJECT, { ...deal, parkingSpaces: 1 }, "2026-11-01", index, DEFAULT_CONFIG);
    expect(r.rawPpsqm).toBe((3_000_000 - DEFAULT_CONFIG.parkingNis.regular) / 100);
  });
});

describe("weighted quantile", () => {
  test("weights shift the median", () => {
    expect(weightedQuantile([1, 2, 3], [1, 1, 1], 0.5)).toBe(2);
    expect(weightedQuantile([1, 2, 3], [0.1, 0.1, 5], 0.5)).toBe(3);
  });
});

describe("transport", () => {
  test("future lines are tagged by maturity and Metro influence area", () => {
    const stops = [{ id: "b", name: "b", mode: "bus" as const, location: offsetM(DEMO_ORIGIN, 100, 0), peakDeparturesPerHour: 20 }];
    const lines = [{
      id: "m", name: "M", mode: "metro" as const, maturity: "approved" as const,
      stations: [{ id: "s", name: "s", location: offsetM(DEMO_ORIGIN, 500, 0) }],
      expropriationParcels: ["1-2"],
    }];
    const r = analyseTransport(DEMO_ORIGIN, stops, lines, "1-2");
    expect(r.nearest[0]!.mode).toBe("bus");
    expect(r.future[0]!.treatment).toBe("upside_no_adjustment");
    expect(r.future[0]!.inDensificationArea).toBe(true);
    expect(r.future[0]!.expropriationRisk).toBe(true);
    expect(r.future[0]!.band).toBe("walk_800");
  });
});

describe("renewal", () => {
  test("news alone never confirms a stage", () => {
    const s: RenewalSignal[] = [
      { id: "1", projectKey: "p", type: "news", stage: "plan_approved", date: "2026-01-01", location: offsetM(DEMO_ORIGIN, 100, 0), label: "x", source: { label: "n" } },
    ];
    const r = nearbyProjects(DEMO_ORIGIN, s);
    expect(r[0]!.stage).toBe("reported");
    expect(r[0]!.unconfirmed).toBe(true);
  });
  test("reliable signals set the highest stage", () => {
    const at = offsetM(DEMO_ORIGIN, 100, 0);
    const s: RenewalSignal[] = [
      { id: "1", projectKey: "p", type: "declared_complex", stage: "representation_signed", date: "2025-01-01", location: at, label: "x", source: { label: "a" } },
      { id: "2", projectKey: "p", type: "plan", stage: "plan_deposited", date: "2026-01-01", location: at, label: "x", source: { label: "b" } },
      { id: "3", projectKey: "p", type: "news", stage: "permit", date: "2026-02-01", location: at, label: "x", source: { label: "c" } },
    ];
    expect(nearbyProjects(DEMO_ORIGIN, s)[0]!.stage).toBe("plan_deposited");
  });
  test("old building with unused rights near Metro scores high", () => {
    const p = renewalPotential(DEMO_SUBJECT, 2026, { inDeclaredComplex: false, nearMetro: true });
    expect(p.level).toBe("high");
  });
  test("new building scores low", () => {
    const p = renewalPotential({ ...DEMO_SUBJECT, yearBuilt: 2020, newBuild: true }, 2026, { inDeclaredComplex: false, nearMetro: true });
    expect(p.level).toBe("low");
  });
});

describe("end-to-end on demo data", () => {
  test("produces an explainable value with a range", async () => {
    const r = await valuate(DEMO_SUBJECT, new DemoProvider(), DEMO_VALUATION_DATE);
    expect(r.dataSource.isDemo).toBe(true);
    expect(r.value).not.toBeNull();
    expect(r.value!.low).toBeLessThanOrEqual(r.value!.point);
    expect(r.value!.high).toBeGreaterThanOrEqual(r.value!.point);
    expect(r.comparables.used.length).toBeGreaterThanOrEqual(5);
    const shares = r.comparables.used.reduce((s, c) => s + c.weightShare, 0);
    expect(shares).toBeCloseTo(1, 5);
    // Demo generator truth: ~32,000 NIS/sqm at origin; renovated 1975 unit on floor 2 without elevator.
    expect(r.comparables.ppsqmMedian).toBeGreaterThan(26_000);
    expect(r.comparables.ppsqmMedian).toBeLessThan(38_000);
    expect(r.warnings.some((w) => w.key === "unpermitted_addons")).toBe(true);
    expect(r.market.priorSales).toHaveLength(2);
    expect(r.renewal.nearby.find((p) => p.projectKey === "p-far")).toBeUndefined();
  });
});

describe("street-map tiles", () => {
  test("cover the ±1.1 km square around Tel Aviv at zoom 15, positioned in map pixels", async () => {
    const { basemapTiles } = await import("../src/ui/basemap");
    const tiles = basemapTiles({ lat: 32.0775, lng: 34.7745 }, 1100, 520);
    expect(tiles[0]!.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/);
    // Tiles together cover the whole box.
    expect(Math.min(...tiles.map((t) => t.x))).toBeLessThanOrEqual(0);
    expect(Math.min(...tiles.map((t) => t.y))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.x + t.w))).toBeGreaterThanOrEqual(520);
    expect(Math.max(...tiles.map((t) => t.y + t.h))).toBeGreaterThanOrEqual(520);
    // A zoom-15 tile at this latitude is ~1,040 m ≈ 245 px here.
    expect(tiles[0]!.w).toBeGreaterThan(230);
    expect(tiles[0]!.w).toBeLessThan(260);
    expect(tiles.length).toBeLessThanOrEqual(16);
  });
});
