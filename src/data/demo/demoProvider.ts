/**
 * DEMO DATA – a fictional town ("Demo Town" / "קריית הדגמה").
 * Every deal, listing, stop, line and renewal project here is synthetic, generated from a fixed
 * seed so results are reproducible. None of it describes a real property or transaction.
 * It exists so the engine and UI can be exercised before live connectors are licensed.
 */
import { offsetM, distanceM } from "../../engine/geo";
import { seededRandom } from "../../engine/stats";
import type {
  CityPolicy,
  Condition,
  Deal,
  FutureLine,
  LatLng,
  Listing,
  PriceIndexPoint,
  RenewalSignal,
  TransitStop,
  ViewQuality,
} from "../../engine/types";
import { DEFAULT_CONFIG, type ValuationConfig } from "../../engine/coefficients";
import type { AreaQuery, DataProvider } from "../provider";

export const DEMO_CITY = "קריית הדגמה";
export const DEMO_ORIGIN: LatLng = { lat: 32.0, lng: 34.8 };
export const DEMO_VALUATION_DATE = "2026-11-01";

const STREETS = ["הדקל", "האלון", "השקד", "הגפן", "התאנה", "הזית", "הרימון", "הברוש", "האורן", "הצאלון"];
const NEIGHBORHOODS = ["מרכז", "צפון", "מזרח"];

const BASE_PPSQM_NOW = 32_000; // NIS per equivalent sqm at the valuation date, demo only
const MONTHLY_GROWTH = 0.0025;

function monthIso(offsetMonths: number): string {
  const d = new Date(Date.UTC(2026, 10, 1));
  d.setUTCMonth(d.getUTCMonth() + offsetMonths);
  return d.toISOString().slice(0, 7);
}

function buildIndex(): PriceIndexPoint[] {
  const pts: PriceIndexPoint[] = [];
  for (let m = -60; m <= 0; m++) pts.push({ month: monthIso(m), value: 100 * Math.pow(1 + MONTHLY_GROWTH, m + 60) });
  return pts;
}

function hiddenPremium(
  floor: number,
  elevator: boolean,
  yearBuilt: number,
  cond: Condition,
  view: ViewQuality,
  newBuild: boolean,
): number {
  const a = DEFAULT_CONFIG.adjustments;
  const fl = floor <= 0 ? a.groundFloor : elevator ? a.perFloorWithElevator * Math.min(floor, a.floorCap) : floor > 2 ? a.perFloorNoElevatorAbove2 * (floor - 2) : 0;
  return fl + ((yearBuilt - 1980) / 10) * a.perDecadeAge + a.condition[cond] + a.view[view] + (newBuild ? a.newBuildPremium : 0);
}

function generate() {
  const rnd = seededRandom(20261101);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]!;
  const index = buildIndex();
  const deals: Deal[] = [];
  const listings: Listing[] = [];

  for (let i = 0; i < 90; i++) {
    const angle = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 1600;
    const east = Math.cos(angle) * r;
    const north = Math.sin(angle) * r;
    const location = offsetM(DEMO_ORIGIN, east, north);
    const monthsAgo = Math.floor(rnd() * 30);
    const day = 1 + Math.floor(rnd() * 27);
    const date = `${monthIso(-monthsAgo)}-${String(day).padStart(2, "0")}`;
    const newBuild = rnd() < 0.15;
    const yearBuilt = newBuild ? 2024 + Math.floor(rnd() * 3) : 1960 + Math.floor(rnd() * 55);
    const floorsInBuilding = newBuild ? 8 + Math.floor(rnd() * 12) : 3 + Math.floor(rnd() * 6);
    const elevator = newBuild || floorsInBuilding > 4 || rnd() < 0.3;
    const floor = Math.floor(rnd() * floorsInBuilding);
    const rooms = pick([2, 3, 3, 4, 4, 4, 5, 5, 6]);
    const area = Math.round(rooms * 22 + 8 + rnd() * 18);
    const cond: Condition = newBuild ? "new" : pick(["renovated", "original", "original", "needs_work", "renovated"]);
    const view: ViewQuality = pick(["regular", "regular", "regular", "open", "blocked"]);
    const addOnEq = Math.round((newBuild ? 12 : rnd() * 8) * 0.3 * 10) / 10;
    const parking = newBuild ? 1 : rnd() < 0.4 ? 1 : 0;
    // Location gradient: +4% per km east (fictional), plus noise.
    const locFactor = 1 + 0.04 * (east / 1000);
    const premium = hiddenPremium(floor, elevator, yearBuilt, cond, view, newBuild);
    const idx = index.find((p) => p.month === date.slice(0, 7))!.value / index[index.length - 1]!.value;
    const noise = 1 + (rnd() - 0.5) * 0.12;
    const ppsqm = BASE_PPSQM_NOW * idx * locFactor * (1 + premium) * noise;
    const price = Math.round((ppsqm * (area + addOnEq) + parking * 150_000) / 1000) * 1000;
    const block = String(6780 + Math.floor((east + 1600) / 400));
    const parcelNo = String(1 + Math.floor((north + 1600) / 100));
    const deal: Deal = {
      id: `demo-deal-${i + 1}`,
      evidence: "completed_deal",
      source: "demo",
      date,
      price,
      location,
      address: { city: DEMO_CITY, street: pick(STREETS), number: String(1 + Math.floor(rnd() * 60)), neighborhood: pick(NEIGHBORHOODS) },
      parcel: { block, parcel: parcelNo, subParcel: String(1 + Math.floor(rnd() * 20)) },
      area,
      rooms,
      floor,
      floorsInBuilding,
      elevator,
      yearBuilt,
      newBuild,
      // Like Tax Authority records, condition and view are NOT included.
      addOnEquivalentSqm: addOnEq,
      parkingSpaces: parking,
    };
    deals.push(deal);

    // ~45% of deals were seen as listings first (listing ledger match).
    if (rnd() < 0.45) {
      const dom = 25 + Math.floor(rnd() * 160);
      const first = new Date(Date.parse(date) - dom * 86_400_000).toISOString().slice(0, 10);
      const ask = Math.round((price * (1.05 + rnd() * 0.06)) / 1000) * 1000;
      listings.push({
        id: `demo-listing-m${i + 1}`,
        evidence: "asking_price",
        source: pick(["yad2", "madlan", "agency"]),
        firstSeen: first,
        lastSeen: date,
        askingPrice: ask,
        priceHistory: [{ date: first, price: Math.round(ask * 1.03) }, { date, price: ask }],
        location,
        address: deal.address,
        area,
        rooms,
        floor,
        matchedDealId: deal.id,
      });
    }
  }

  // Active listings (asking prices today).
  for (let i = 0; i < 28; i++) {
    const angle = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 1500;
    const east = Math.cos(angle) * r;
    const location = offsetM(DEMO_ORIGIN, east, Math.sin(angle) * r);
    const rooms = pick([3, 4, 4, 5]);
    const area = Math.round(rooms * 22 + 8 + rnd() * 18);
    const ppsqm = BASE_PPSQM_NOW * (1 + 0.04 * (east / 1000)) * (1.04 + rnd() * 0.1);
    const firstSeen = `${monthIso(-Math.floor(rnd() * 6))}-${String(1 + Math.floor(rnd() * 27)).padStart(2, "0")}`;
    const askingPrice = Math.round((ppsqm * area) / 1000) * 1000;
    listings.push({
      id: `demo-listing-a${i + 1}`,
      evidence: "asking_price",
      source: pick(["yad2", "madlan", "agency"]),
      firstSeen,
      lastSeen: DEMO_VALUATION_DATE,
      askingPrice,
      priceHistory: [{ date: firstSeen, price: askingPrice }],
      location,
      address: { city: DEMO_CITY, street: pick(STREETS), number: String(1 + Math.floor(rnd() * 60)) },
      area,
      rooms,
      floor: Math.floor(rnd() * 6),
    });
  }

  // Prior sales of the demo subject unit (6789-12-8).
  const unitHistory: Deal[] = [
    { date: "2012-03-14", price: 1_180_000 },
    { date: "2019-07-02", price: 1_890_000 },
  ].map((s, k) => ({
    id: `demo-unit-${k}`,
    evidence: "completed_deal" as const,
    source: "demo",
    date: s.date,
    price: s.price,
    location: DEMO_ORIGIN,
    address: { city: DEMO_CITY, street: "הדקל", number: "14" },
    parcel: { block: "6789", parcel: "12", subParcel: "8" },
    area: 92,
    rooms: 4,
    floor: 2,
    floorsInBuilding: 4,
    elevator: false,
    yearBuilt: 1975,
    newBuild: false,
  }));

  const stop = (id: string, name: string, mode: TransitStop["mode"], e: number, n: number, freq: number): TransitStop => ({
    id,
    name,
    mode,
    location: offsetM(DEMO_ORIGIN, e, n),
    peakDeparturesPerHour: freq,
  });
  const stops: TransitStop[] = [
    stop("b1", "הדקל / האלון", "bus", 90, 40, 14),
    stop("b2", "שד' העצמאות", "bus", -220, 160, 32),
    stop("b3", "כיכר העירייה", "bus", 380, -120, 24),
    stop("b4", "הגפן", "bus", -60, -340, 6),
    stop("b5", "מסוף מזרח", "bus", 900, 300, 40),
    stop("lr1", "תחנת הקו האדום – העצמאות", "light_rail", -520, 420, 12),
    stop("r1", "תחנת רכבת קריית הדגמה", "rail", 1150, -650, 6),
  ];

  const station = (id: string, name: string, e: number, n: number) => ({ id, name, location: offsetM(DEMO_ORIGIN, e, n) });
  const futureLines: FutureLine[] = [
    {
      id: "demo-red",
      name: "Red line (demo)",
      mode: "light_rail",
      maturity: "operating",
      stations: [station("lr1", "העצמאות", -520, 420)],
    },
    {
      id: "demo-purple",
      name: "Purple line (demo)",
      mode: "light_rail",
      maturity: "under_construction",
      expectedOpening: "2028 (demo)",
      stations: [station("p1", "האלון", 260, 210), station("p2", "מזרח", 1100, 260)],
    },
    {
      id: "demo-m1",
      name: "Metro M-Demo",
      mode: "metro",
      maturity: "approved",
      expectedOpening: "2030s (demo)",
      stations: [station("m1", "מרכז העיר", -380, -420), station("m2", "צפון", 200, 1400)],
      expropriationParcels: ["6788-12", "6787-11"],
    },
    {
      id: "demo-brt",
      name: "BRT corridor (demo)",
      mode: "bus",
      maturity: "in_planning",
      stations: [station("t1", "השקד", -700, -80)],
    },
  ];

  const sig = (
    id: string,
    projectKey: string,
    type: RenewalSignal["type"],
    stage: RenewalSignal["stage"],
    date: string,
    e: number,
    n: number,
    label: string,
    extra: Partial<RenewalSignal> = {},
  ): RenewalSignal => ({
    id,
    projectKey,
    type,
    stage,
    date,
    location: offsetM(DEMO_ORIGIN, e, n),
    label,
    source: { label: "Demo source" },
    ...extra,
  });
  const signals: RenewalSignal[] = [
    sig("s1", "p-alon", "declared_complex", "representation_signed", "2025-06-10", 180, 120, "מתחם האלון – פינוי בינוי", { unitsExisting: 96, unitsPlanned: 310, source: { label: "Urban Renewal Authority declaration (demo)" } }),
    sig("s2", "p-alon", "plan", "plan_deposited", "2026-08-20", 180, 120, "מתחם האלון – פינוי בינוי", { unitsExisting: 96, unitsPlanned: 310, plannedFloors: 22, source: { label: "Plan system (demo)" } }),
    sig("s3", "p-alon", "news", "plan_deposited", "2026-08-25", 180, 120, "מתחם האלון", { source: { label: "Local news (demo)" } }),
    sig("s4", "p-gefen", "permit_application", "permit_application", "2026-09-30", -110, -150, "הגפן 7 – הריסה ובנייה (תיקון 139)", { unitsExisting: 12, unitsPlanned: 30, plannedFloors: 8, source: { label: "Section 149 notice (demo)" } }),
    sig("s5", "p-tamar", "news", "developer_selected", "2026-10-12", 380, -230, "רחוב התמר – דיירים בחרו יזם", { source: { label: "Real estate news (demo)" } }),
    sig("s6", "p-zayit", "committee_minutes", "plan_submitted", "2026-07-15", -330, 300, "מתחם הזית", { unitsExisting: 48, unitsPlanned: 180, plannedFloors: 16, source: { label: "Local committee minutes (demo)" } }),
    sig("s7", "p-far", "plan", "plan_approved", "2026-03-01", 900, 700, "מתחם מזרח (מחוץ לרדיוס)", { unitsExisting: 200, unitsPlanned: 640, source: { label: "Plan system (demo)" } }),
  ];

  const policy: CityPolicy = {
    city: DEMO_CITY,
    hasBuildingRenewalPlan: false,
    hasRenewalPolicy: true,
    renewalLevyPercent: 25,
  };

  return { index, deals, listings, unitHistory, stops, futureLines, signals, policy };
}

export class DemoProvider implements DataProvider {
  readonly id = "demo";
  readonly isDemo = true;
  private data = generate();

  private within<T extends { location: LatLng }>(items: T[], q: AreaQuery) {
    return items.filter((x) => distanceM(q.center, x.location) <= q.radiusM);
  }
  async getDeals(q: AreaQuery & { sinceIso: string }) {
    return this.within(this.data.deals, q).filter((d) => d.date >= q.sinceIso);
  }
  async getUnitHistory(parcelKey: string) {
    return parcelKey === "6789-12-8" ? this.data.unitHistory : [];
  }
  async getListings(q: AreaQuery) {
    return this.within(this.data.listings, q);
  }
  async getPriceIndex() {
    return this.data.index;
  }
  async getTransitStops(q: AreaQuery) {
    return this.within(this.data.stops, q);
  }
  async getFutureLines() {
    return this.data.futureLines;
  }
  async getRenewalSignals(q: AreaQuery) {
    return this.within(this.data.signals, q);
  }
  async getCityPolicy(city: string) {
    return city === DEMO_CITY ? this.data.policy : undefined;
  }
  async getCityConfig(): Promise<Partial<ValuationConfig> | undefined> {
    return undefined; // defaults (uncalibrated)
  }
  /** For the map: everything around the demo origin. */
  allSignals() {
    return this.data.signals;
  }
}
