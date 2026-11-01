import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseCsvLine, parseGtfs, referenceWeekday, routeMode } from "../server/connectors/gtfs";
import { centroid, queryAround } from "../server/connectors/arcgis";
import { complexToSignal, planStage, planToSignal, fetchRenewalSignals } from "../server/connectors/renewal";
import { collectSeries, parseIndexData, pickDistrictCode, fetchDistrictIndex } from "../server/connectors/cbs";
import { parseAddressLabel, parseAutocomplete } from "../server/connectors/geocode";
import { wgs84ToItm } from "../server/itm";
import { isDue, tick } from "../server/scheduler";
import { openDb, lastRun, priceIndex, replaceStops, savePriceIndex, upsertSignals } from "../server/db";
import { health } from "../server/main";
import { SqliteProvider } from "../server/sqliteProvider";
import { DEFAULT_SOURCES } from "../server/config";

const FIX = "tests/fixtures/gtfs-mini.zip";

describe("GTFS", () => {
  test("weekday peak departures per stop, Saturday and cancelled days excluded", async () => {
    const r = await parseGtfs(FIX, { fromIso: "2026-11-04" });
    expect(r.referenceDate).toBe("20261110");
    const by = Object.fromEntries(r.stops.map((s) => [s.id, s]));
    expect(by.S1!.mode).toBe("bus");
    expect(by.S1!.peakDeparturesPerHour).toBe(1); // 07:10 and 08:40; Saturday trip ignored
    expect(by.S2!.mode).toBe("light_rail"); // served by bus and light rail → strongest mode
    expect(by.S2!.peakDeparturesPerHour).toBe(1); // 09:30 is outside the peak
    expect(by.S4!.mode).toBe("rail"); // after-midnight trip still sets the mode
    expect(by.S5).toBeUndefined(); // no service that day
    expect(by.P1).toBeUndefined(); // parent station
  });
  test("a cancelled service date yields no trips", async () => {
    const r = await parseGtfs(FIX, { fromIso: "2026-11-01" }); // → Tue 2026-11-03, cancelled in calendar_dates
    expect(r.trips).toBe(0);
  });
  test("helpers", () => {
    expect(parseCsvLine('a,"b, c","d ""q"""')).toEqual(["a", "b, c", 'd "q"']);
    expect(routeMode(0)).toBe("light_rail");
    expect(routeMode(2)).toBe("rail");
    expect(routeMode(715)).toBe("bus");
    expect(referenceWeekday("2026-11-10").ymd).toBe("20261110");
  });
});

describe("ArcGIS layers → renewal signals", () => {
  const xy = wgs84ToItm(32.0, 34.8);
  const ring = [[xy.x - 50, xy.y - 50], [xy.x + 50, xy.y - 50], [xy.x + 50, xy.y + 50], [xy.x - 50, xy.y + 50]];
  const planFeatures = {
    features: [
      { attributes: { pl_number: "502-1234567", pl_name: "התחדשות עירונית מתחם הדקל", station_desc: "הופקדה", last_update_date: Date.UTC(2026, 6, 1), quantity_delta_120: 240 }, geometry: { rings: [ring] } },
      { attributes: { pl_number: "502-7654321", pl_name: "הרחבת דרך", station_desc: "אושרה" }, geometry: { rings: [ring] } },
      { attributes: { pl_number: "502-1111111", pl_name: "פינוי בינוי הגפן", station_desc: "נדחתה" }, geometry: { rings: [ring] } },
    ],
  };
  test("query URL carries ITM point and metre radius; polygons become centroids", async () => {
    let url = "";
    const f = (async (u: string) => { url = u; return new Response(JSON.stringify(planFeatures)); }) as unknown as typeof fetch;
    const feats = await queryAround({ url: "https://x/arcgis/rest/services/P/MapServer/1", wkid: 2039 }, { lat: 32, lng: 34.8 }, 500, f);
    expect(url).toContain("/MapServer/1/query?");
    expect(url).toContain("distance=500");
    expect(url).toContain("inSR=2039");
    expect(feats[0]!.location.lat).toBeCloseTo(32, 4);
    expect(centroid({ x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });
  test("only renewal plans are kept; rejected plans dropped; stage from status", async () => {
    const f = (async () => new Response(JSON.stringify(planFeatures))) as unknown as typeof fetch;
    const { signals } = await fetchRenewalSignals({ plans: { url: "https://x/1", wkid: 2039 } }, { lat: 32, lng: 34.8 }, 500, f);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.stage).toBe("plan_deposited");
    expect(signals[0]!.unitsPlanned).toBe(240);
    expect(signals[0]!.date).toBe("2026-07-01");
    expect(planStage("בתוקף")).toBe("plan_approved");
    expect(planToSignal({ attributes: { pl_name: "מגורים" }, location: { lat: 0, lng: 0 } }, "x")).toBeNull();
  });
  test("declared complex", () => {
    const s = complexToSignal({ attributes: { OBJECTID: 7, name: "מתחם האלון", existing_units: 96, planned_units: 310 }, location: { lat: 32, lng: 34.8 } }, "URA");
    expect(s.type).toBe("declared_complex");
    expect(s.unitsExisting).toBe(96);
  });
  test("layer error surfaces as error, not as silence", async () => {
    const f = (async () => new Response(JSON.stringify({ error: { message: "Invalid layer" } }))) as unknown as typeof fetch;
    const r = await fetchRenewalSignals({ plans: { url: "https://x/1", wkid: 2039 } }, { lat: 32, lng: 34.8 }, 500, f);
    expect(r.errors[0]).toContain("Invalid layer");
  });
});

describe("CBS dwelling price index", () => {
  const catalog = { chapters: [{ subjects: [
    { code: 40010, name: "מדד מחירי דירות - מחוז תל אביב" },
    { code: 40020, name: "מדד מחירי דירות - מחוז ירושלים" },
    { code: 40090, name: "מדד מחירי דירות חדשות - מחוז תל אביב" },
  ] }] };
  const data = { month: [{ code: 40010, date: [
    { year: 2026, month: 8, currBase: { value: 104.2 } },
    { year: 2026, month: 9, currBase: { value: 104.9 } },
  ] }] };
  test("discovers the district series and parses observations", async () => {
    expect(pickDistrictCode(collectSeries(catalog), "tel_aviv")).toBe("40010");
    expect(parseIndexData(data)).toEqual([{ month: "2026-08", value: 104.2 }, { month: "2026-09", value: 104.9 }]);
    const calls: string[] = [];
    const f = (async (u: string) => { calls.push(u); return new Response(JSON.stringify(u.includes("catalog") ? catalog : data)); }) as unknown as typeof fetch;
    const r = await fetchDistrictIndex("jerusalem", { fetchImpl: f });
    expect(r.code).toBe("40020");
    expect(calls[1]).toContain("id=40020");
  });
});

describe("geocoding", () => {
  test("ITM points and labels", () => {
    const xy = wgs84ToItm(32.0853, 34.7818);
    const hits = parseAutocomplete({ results: [{ displayName: "הירקון 120, תל אביב-יפו", point: { x: xy.x, y: xy.y } }, { displayName: "bad" }] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.lat).toBeCloseTo(32.0853, 5);
    expect(hits[0]!.street).toBe("הירקון");
    expect(hits[0]!.number).toBe("120");
    expect(parseAddressLabel("רחוב הדקל 14 קריית הדגמה").city).toBe("קריית הדגמה");
  });
});

describe("scheduler and freshness", () => {
  test("due rules", () => {
    const now = new Date("2026-11-03T02:00:00Z"); // Tuesday
    expect(isDue(null, now, { everyHours: 24, atHourUtc: 0 })).toBe(true);
    expect(isDue("2026-11-02T23:00:00Z", now, { everyHours: 24, atHourUtc: 0 })).toBe(false);
    expect(isDue(null, now, { everyHours: 168, weekday: 0 })).toBe(false);
    expect(isDue(null, now, { everyHours: 24 * 27, dayOfMonth: 17 })).toBe(false);
  });
  test("tick runs due local jobs, records them, and /health reports freshness", async () => {
    const dir = mkdtempSync(`${tmpdir()}/bs-`);
    process.env.DATA_DIR = dir;
    const db = openDb(":memory:");
    const cfg = { ...DEFAULT_SOURCES, cities: [] };
    const now = new Date("2026-11-03T02:00:00Z");
    const logs: string[] = [];
    await tick(db, cfg, now, (m) => logs.push(m));
    expect(lastRun(db, "backup")).not.toBeNull();
    expect(readdirSync(`${dir}/backups`)).toHaveLength(1);
    const h = health(db, cfg, now);
    expect(h.sources.backup!.stale).toBe(false);
    expect(h.sources.gtfs!.stale).toBe(true); // never ran
    delete process.env.DATA_DIR;
  });
  test("provider serves stops, index and signals from the database", async () => {
    const db = openDb(":memory:");
    replaceStops(db, [{ id: "s", name: "x", mode: "bus", location: { lat: 32, lng: 34.8 }, peakDeparturesPerHour: 12 }]);
    savePriceIndex(db, "tel_aviv", [{ month: "2026-09", value: 104.9 }]);
    upsertSignals(db, [{ id: "a", projectKey: "a", type: "plan", stage: "plan_deposited", date: "2026-01-01", location: { lat: 32.001, lng: 34.8 }, label: "x", source: { label: "p" } }], "2026-11-01");
    const p = new SqliteProvider(db, { ...DEFAULT_SOURCES, cities: [{ name: "תל אביב יפו", lat: 32, lng: 34.8, radiusM: 3000, district: "tel_aviv" }] });
    const q = { center: { lat: 32, lng: 34.8 }, radiusM: 500, city: "תל אביב-יפו" };
    expect(await p.getTransitStops(q)).toHaveLength(1);
    expect(await p.getPriceIndex("תל אביב - יפו")).toHaveLength(1);
    expect(await p.getRenewalSignals(q)).toHaveLength(1);
    expect(priceIndex(db, "tel_aviv")[0]!.value).toBe(104.9);
  });
});
