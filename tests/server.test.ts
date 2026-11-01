import { afterAll, describe, expect, test } from "bun:test";
import { itmToWgs84, wgs84ToItm } from "../server/itm";
import { extractRows, fetchDealsByRadius, mapDeal, parseFloor, parseGush } from "../server/govmap";
import { openDb, saveListing, upsertDeals } from "../server/db";
import { importFeed } from "../server/ledger";
import { rematch } from "../server/jobs";
import { createServer } from "../server/main";
import { DemoProvider, DEMO_ORIGIN, DEMO_VALUATION_DATE } from "../src/data/demo/demoProvider";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";

describe("ITM projection", () => {
  test("projection origin maps to the false easting / northing", () => {
    const o = wgs84ToItm(31 + 44 / 60 + 3.817 / 3600, 35 + 12 / 60 + 16.261 / 3600);
    expect(o.x).toBeCloseTo(219529.584, 1);
    expect(o.y).toBeCloseTo(626907.39, 1);
  });
  test("round trip is sub-centimetre", () => {
    const p = { lat: 32.0853, lng: 34.7818 };
    const xy = wgs84ToItm(p.lat, p.lng);
    const back = itmToWgs84(xy.x, xy.y);
    expect(back.lat).toBeCloseTo(p.lat, 7);
    expect(back.lng).toBeCloseTo(p.lng, 7);
    // Tel Aviv lies roughly 40 km west and 37 km north of the ITM origin
    expect(xy.x).toBeGreaterThan(175_000);
    expect(xy.x).toBeLessThan(185_000);
    expect(xy.y).toBeGreaterThan(660_000);
    expect(xy.y).toBeLessThan(670_000);
  });
});

describe("GovMap deal mapping (synthetic fixture – replace with a live one from server/probe.ts)", () => {
  const xy = wgs84ToItm(32.0853, 34.7818);
  const rows = [
    { objectid: 11, dealAmount: "2,950,000", dealDate: "2026-05-17T00:00:00", assetArea: 92, assetRoomNum: 4, floorNo: "שלישית",
      settlementNameHeb: "תל אביב -יפו", streetName: "הירקון", houseNum: "120", gush: "006950-0042-012", x: xy.x, y: xy.y, buildingYear: 1972, buildingFloors: 5 },
    { deal_amount: 4100000, deal_date: "17/03/2026", area: 110, rooms: 5, floor: 7, address_description: "דיזנגוף 200", cityName: "תל אביב יפו", lat: 32.08, lng: 34.77 },
    { dealAmount: 1000000 }, // missing fields → unmapped
  ];
  test("tolerates field-name variants, Hebrew floors, padded gush and ITM coordinates", () => {
    const a = mapDeal(rows[0]!)!;
    expect(a.price).toBe(2_950_000);
    expect(a.date).toBe("2026-05-17");
    expect(a.floor).toBe(3);
    expect(a.parcel).toEqual({ block: "6950", parcel: "42", subParcel: "12" });
    expect(a.location.lat).toBeCloseTo(32.0853, 5);
    expect(a.yearBuilt).toBe(1972);
    const b = mapDeal(rows[1]!)!;
    expect(b.date).toBe("2026-03-17");
    expect(b.address.street).toBe("דיזנגוף");
    expect(b.address.number).toBe("200");
    expect(b.yearBuilt).toBe(0);
    expect(mapDeal(rows[2]!)).toBeNull();
  });
  test("helpers", () => {
    expect(parseFloor("קרקע")).toBe(0);
    expect(parseFloor("אחת עשרה")).toBe(11);
    expect(parseFloor("קומה 4")).toBe(4);
    expect(parseGush("6789/12")).toEqual({ block: "6789", parcel: "12", subParcel: undefined });
    expect(extractRows({ data: { items: [{ a: 1 }] } })).toHaveLength(1);
  });
  test("fetch builds the ITM radius URL and maps the payload", async () => {
    let called = "";
    const fakeFetch = (async (u: string) => {
      called = u;
      return new Response(JSON.stringify({ data: rows }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchDealsByRadius({ lat: 32.0853, lng: 34.7818 }, 300, { fetchImpl: fakeFetch });
    expect(called).toMatch(/\/real-estate\/deals\/\d+,\d+\/300$/);
    expect(r.deals).toHaveLength(2);
    expect(r.unmapped).toBe(1);
  });
});

describe("listing ledger", () => {
  const db = openDb(":memory:");
  const item = { sourceId: "y1", askingPrice: 3_000_000, city: "חיפה", street: "הנשיא", number: "12", floor: 3, rooms: 4, area: 100, lat: 32.8, lng: 35.0 };
  test("first import inserts; later price drop is recorded", () => {
    expect(importFeed(db, { source: "yad2", observedAt: "2026-03-01", items: [item] }).inserted).toBe(1);
    const r = importFeed(db, { source: "yad2", observedAt: "2026-04-01", items: [{ ...item, askingPrice: 2_900_000 }] });
    expect(r.updated).toBe(1);
    expect(r.priceChanges).toBe(1);
  });
  test("snapshot marks missing adverts removed; implausible rows rejected", () => {
    const r = importFeed(db, {
      source: "yad2",
      observedAt: "2026-05-01",
      snapshot: { city: "חיפה" },
      items: [{ ...item, sourceId: "y2", askingPrice: 50 }],
    });
    expect(r.removed).toBe(1);
    expect(r.rejected).toHaveLength(1);
    const row: any = db.query("SELECT json FROM listings WHERE source_id = 'y1'").get();
    const l = JSON.parse(row.json);
    expect(l.status).toBe("removed");
    expect(l.firstSeen).toBe("2026-03-01");
    expect(l.priceHistory).toHaveLength(2);
  });
});

describe("API end-to-end (demo data loaded into the server database)", () => {
  const { server, db } = createServer({ dbPath: ":memory:", adminToken: "t", port: 0 });
  afterAll(() => server.stop(true));

  test("rematch + valuate uses stored pairs and calibrated adverts", async () => {
    const p = new DemoProvider();
    const q = { center: DEMO_ORIGIN, radiusM: 3000, city: DEMO_SUBJECT.address.city, sinceIso: "2000-01-01" };
    upsertDeals(db, await p.getDeals(q));
    for (const l of await p.getListings(q)) saveListing(db, l);

    const base = `http://localhost:${server.port}`;
    const unauth = await fetch(`${base}/api/jobs/match`, { method: "POST", body: "{}" });
    expect(unauth.status).toBe(401);

    const m = await fetch(`${base}/api/jobs/match`, {
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: JSON.stringify({ lat: DEMO_ORIGIN.lat, lng: DEMO_ORIGIN.lng, radiusM: 3000, sinceIso: "2024-01-01" }),
    }).then((r) => r.json());
    expect(m.pairs).toBeGreaterThan(30);

    const v = await fetch(`${base}/api/valuate`, {
      method: "POST",
      body: JSON.stringify({ subject: DEMO_SUBJECT, date: DEMO_VALUATION_DATE }),
    }).then((r) => r.json());
    expect(v.dataSource.isDemo).toBe(false);
    expect(v.value.point).toBeGreaterThan(2_000_000);
    expect(v.listingEvidence.model.localN).toBeGreaterThan(5);
    expect(v.transport.nearest).toHaveLength(0); // GTFS not connected: empty, not invented
  });
});
