import { describe, expect, test } from "bun:test";
import { normaliseStreet, parseHouseNumber } from "../src/engine/address";
import { matchListingsToDeals, scoreCandidate } from "../src/engine/matching";
import { ageFactor, buildCalibration, calibrateListings } from "../src/engine/askCalibration";
import { offsetM } from "../src/engine/geo";
import { DemoProvider, DEMO_ORIGIN, DEMO_VALUATION_DATE } from "../src/data/demo/demoProvider";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";
import { valuate } from "../src/engine/valuation";
import type { Deal, Listing } from "../src/engine/types";

const deal = (over: Partial<Deal> = {}): Deal => ({
  id: "d1", evidence: "completed_deal", source: "tax", date: "2026-06-15", price: 2_850_000,
  location: DEMO_ORIGIN, address: { city: "חיפה", street: "שדרות הנשיא", number: "12" },
  area: 95, rooms: 4, floor: 3, floorsInBuilding: 6, elevator: true, yearBuilt: 1985, newBuild: false,
  ...over,
});
const listing = (over: Partial<Listing> = {}): Listing => ({
  id: "l1", evidence: "asking_price", source: "yad2", sourceId: "abc", firstSeen: "2026-03-01", lastSeen: "2026-06-10",
  status: "removed", askingPrice: 3_000_000, priceHistory: [{ date: "2026-03-01", price: 3_150_000 }, { date: "2026-05-01", price: 3_000_000 }],
  location: offsetM(DEMO_ORIGIN, 8, 5), address: { city: "חיפה", street: "שד' הנשיא", number: "12" }, area: 104, rooms: 4, floor: 3,
  ...over,
});

describe("address normalisation", () => {
  test("street prefixes and punctuation are ignored", () => {
    expect(normaliseStreet("שדרות הנשיא")).toBe(normaliseStreet("שד' הנשיא"));
    expect(normaliseStreet("רחוב בן-גוריון")).toBe(normaliseStreet("בן גוריון"));
  });
  test("house numbers with letters", () => {
    expect(parseHouseNumber("12א")).toEqual({ n: 12, suffix: "א" });
    expect(parseHouseNumber("")).toBeNull();
  });
});

describe("listing ↔ deal matching", () => {
  test("same unit matches with metrics", () => {
    const { pairs } = matchListingsToDeals([deal()], [listing()]);
    expect(pairs).toHaveLength(1);
    const p = pairs[0]!;
    expect(p.saleToLastAsk).toBeCloseTo(0.95, 3);
    expect(p.saleToFirstAsk).toBeCloseTo(2_850_000 / 3_150_000, 3);
    expect(p.priceCuts).toBe(1);
    expect(p.daysOnMarket).toBe(106);
    expect(p.areaRatio).toBeCloseTo(95 / 104, 3);
  });
  test("different house number or floor is rejected", () => {
    expect(scoreCandidate(deal(), listing({ address: { city: "חיפה", street: "הנשיא", number: "14" } }))).toBeNull();
    expect(scoreCandidate(deal(), listing({ floor: 2 }))).toBeNull();
  });
  test("advert without a number matches only when very close", () => {
    const noNum = listing({ address: { city: "חיפה", street: "הנשיא", number: "" } });
    expect(scoreCandidate(deal(), noNum)).not.toBeNull();
    expect(scoreCandidate(deal(), { ...noNum, location: offsetM(DEMO_ORIGIN, 200, 0) })).toBeNull();
  });
  test("implausible price or stale advert is rejected", () => {
    expect(scoreCandidate(deal(), listing({ askingPrice: 4_500_000 }))).toBeNull();
    expect(scoreCandidate(deal(), listing({ lastSeen: "2025-10-01" }))).toBeNull();
  });
  test("Yad2 + Madlan adverts of one unit → one pair, counted from the earliest advert", () => {
    const { pairs } = matchListingsToDeals([deal()], [
      listing(),
      listing({ id: "l2", source: "madlan", sourceId: "m1", firstSeen: "2026-02-01" }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.listing.id).toBe("l2");
  });
  test("two different units equally plausible → ambiguous, no match", () => {
    const noNumA = listing({ address: { city: "חיפה", street: "הנשיא", number: "" }, floor: undefined });
    const other = { ...noNumA, id: "l3", sourceId: "z", rooms: 4.5 };
    const { pairs } = matchListingsToDeals([deal()], [noNumA, other]);
    expect(pairs).toHaveLength(0);
  });
  test("demo ledger: high precision", async () => {
    const p = new DemoProvider();
    const q = { center: DEMO_ORIGIN, radiusM: 2000, city: DEMO_SUBJECT.address.city, sinceIso: "2000-01-01" };
    const { pairs } = matchListingsToDeals(await p.getDeals(q), await p.getListings(q));
    const wrong = pairs.filter((pr) => {
      const m = pr.listing.id.match(/demo-l-(\d+)-/);
      return !m || `demo-deal-${Number(m[1]) + 1}` !== pr.deal.id;
    });
    expect(pairs.length).toBeGreaterThan(30);
    expect(wrong).toHaveLength(0);
  });
});

describe("asking-price calibration", () => {
  const pairsFrom = async () => {
    const p = new DemoProvider();
    const q = { center: DEMO_ORIGIN, radiusM: 2000, city: DEMO_SUBJECT.address.city, sinceIso: "2000-01-01" };
    return { p, q, pairs: matchListingsToDeals(await p.getDeals(q), await p.getListings(q)).pairs };
  };
  test("learns sale-to-ask and area ratio close to the generator's truth", async () => {
    const { pairs } = await pairsFrom();
    const m = buildCalibration(DEMO_ORIGIN, pairs, DEMO_VALUATION_DATE)!;
    expect(m.saleToAsk).toBeGreaterThan(0.9);
    expect(m.saleToAsk).toBeLessThan(0.98);
    expect(m.areaRatio).toBeGreaterThan(0.88); // adverts inflate area by 3–13%
    expect(m.areaRatio).toBeLessThan(0.97);
  });
  test("calibrated price = ask × ratio; area shrinks to registered", async () => {
    const { pairs, p, q } = await pairsFrom();
    const m = buildCalibration(DEMO_ORIGIN, pairs, DEMO_VALUATION_DATE)!;
    const active = (await p.getListings(q)).filter((l) => l.status === "active").slice(0, 3);
    for (const c of calibrateListings(m, active, DEMO_VALUATION_DATE)) {
      expect(c.expectedPrice).toBeLessThan(c.listing.askingPrice);
      expect(c.expectedArea).toBeLessThan(c.listing.area);
      expect(c.ratioUsed).toBeCloseTo(m.saleToAsk * ageFactor(m, c.daysListed), 6);
    }
  });
  test("thin local data shrinks towards the pool", () => {
    const mk = (i: number, ratio: number, far: boolean): any => ({
      deal: deal({ id: "d" + i, location: far ? offsetM(DEMO_ORIGIN, 5000, 0) : DEMO_ORIGIN, date: "2026-09-01" }),
      listing: listing(), saleToLastAsk: ratio, daysOnMarket: 60, areaRatio: 0.92,
    });
    const pool = [...Array.from({ length: 20 }, (_, i) => mk(i, 0.95, true)), mk(99, 0.85, false)];
    const m = buildCalibration(DEMO_ORIGIN, pool, "2026-11-01")!;
    expect(m.localN).toBe(1);
    expect(m.saleToAsk).toBeGreaterThan(0.94); // one local outlier barely moves it
  });
});

describe("blended valuation", () => {
  test("calibrated adverts get a capped weight and both values are reported", async () => {
    const r = await valuate(DEMO_SUBJECT, new DemoProvider(), DEMO_VALUATION_DATE);
    expect(r.valueDealsOnly).not.toBeNull();
    expect(r.listingEvidence).not.toBeNull();
    expect(r.listingEvidence!.blendWeight).toBeGreaterThan(0);
    expect(r.listingEvidence!.blendWeight).toBeLessThanOrEqual(0.4);
    expect(r.market.saleToAskDiscount).toBeLessThan(0);
    expect(r.market.medianDaysOnMarket).toBeGreaterThan(0);
  });
});
