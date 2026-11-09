/**
 * The property dossier: what the applicant tells us, in a structure an appraiser can review.
 *
 * Principles:
 * - Ask only what moves the value and only the applicant can know. Condition, finishes,
 *   kitchen type, flooring, windows, light and view come from the video tour; registered area,
 *   liens and lease terms from documents; legality is the appraiser's call.
 * - Every uncertain answer can be "don't know" (`"unknown"`) or "later" (`"later"`).
 * - Answers are the applicant's statements. They are never presented as verified; documents
 *   and the appraiser verify them.
 */
import type { AddOn, Direction, Subject } from "../engine/types";

export type Unsure = "unknown" | "later";
/** A value, or "don't know / later". */
export type Maybe<T> = T | Unsure | undefined;
export const isKnown = <T,>(v: Maybe<T>): v is T => v !== undefined && v !== "unknown" && v !== "later";

export type Purpose = "sale" | "purchase" | "mortgage" | "refinance" | "market" | "inheritance" | "division" | "tax_legal" | "other";
export type Submitter = "owner" | "buyer" | "agent" | "attorney" | "mortgage_broker" | "family" | "other";
export type PropertyType = "apartment" | "garden_apartment" | "penthouse" | "duplex" | "detached" | "semi_detached" | "cottage" | "townhouse" | "house_on_plot" | "other";
export type AreaSource = "estimate" | "measured" | "arnona" | "registered" | "plan" | "other";
export type Registry = "tabu" | "ila" | "amidar" | "company" | "other";
export type RightsKind = "ownership" | "leasehold" | "long_lease" | "contractual" | "other";
export type Occupancy = "owner" | "tenant" | "vacant" | "family" | "mixed" | "other";
export type YesNo = "yes" | "no";
export type ParkingKind = "registered" | "assigned" | "shared" | "street";

export const RESTRICTIONS = ["mortgage", "lien", "warning_note", "attachment", "shared_ownership", "inheritance", "third_party", "easement", "litigation"] as const;
export const DEVIATIONS = ["additions", "enclosed_balcony", "divided_rooms", "moved_walls", "converted_area"] as const;
export type Restriction = (typeof RESTRICTIONS)[number];
export type Deviation = (typeof DEVIATIONS)[number];

export interface Balcony { size: Maybe<number>; sukkah: Maybe<YesNo> }

export interface Dossier {
  v: 1;
  /** Where the applicant was, to resume there. */
  at?: SectionId;
  setup: { purpose?: Purpose; submitter?: Submitter; purposeOther?: string };
  location: {
    city?: string; neighbourhood?: string; street?: string; number?: string;
    entrance?: string; apartment?: string; postal?: string;
    floor: Maybe<number>; floors: Maybe<number>;
    type?: PropertyType;
    pin?: { lat: number; lng: number }; pinConfirmed?: boolean;
    /** Block/parcel: suggested from the national parcel map, typed by the owner, or read from a document. */
    parcel?: { block: string; parcel: string; sub?: string; source: "suggested" | "owner" | "document" };
    street_kind: Maybe<"main" | "quiet">;
    orientation: Maybe<Direction[]>;
  };
  size: {
    interior: Maybe<number>; interiorSource?: AreaSource;
    /** Other areas the owner happens to know (registered, Arnona, plan…). */
    registered: Maybe<number>; arnona: Maybe<number>; plan: Maybe<number>;
    plot: Maybe<number>;
  };
  rooms: { rooms: Maybe<number>; bedrooms: Maybe<number>; bathrooms: Maybe<number>; toilets: Maybe<number>; custom: string[] };
  balconies: { count: Maybe<number>; items: Balcony[] };
  garden: { exists: Maybe<YesNo>; kind: Maybe<"private" | "exclusive" | "shared">; size: Maybe<number> };
  roof: { kind: Maybe<"private" | "exclusive" | "shared" | "none">; size: Maybe<number> };
  parking: { count: Maybe<number>; kind: Maybe<ParkingKind>; features: ("covered" | "underground" | "tandem" | "mechanical" | "ev")[] };
  storage: { exists: Maybe<YesNo>; size: Maybe<number>; registered: Maybe<YesNo> };
  building: { yearBuilt: Maybe<number>; elevator: Maybe<YesNo>; shabbatElevator: Maybe<YesNo>; mamad: Maybe<YesNo>; shelter: Maybe<YesNo> };
  legal: {
    registry: Maybe<Registry>; rights: Maybe<RightsKind>; capitalized: Maybe<YesNo>;
    restrictions: Maybe<Restriction[] | "none">;
    deviations: Maybe<Deviation[] | "none">;
    renewal: Maybe<"none" | "talks" | "signed" | "developer">;
    enforcement: Maybe<YesNo>;
  };
  occupancy: {
    kind?: Occupancy;
    rent: Maybe<number>; leaseEnd: Maybe<string>; indexed: Maybe<YesNo>;
    vaad: Maybe<number>; arnona: Maybe<number>; arnonaPeriod?: "month" | "two_months" | "year";
    special: Maybe<YesNo>;
  };
  sale: { asking: Maybe<number>; advertised: Maybe<YesNo>; since: Maybe<string>; reduced: Maybe<YesNo>; agent: Maybe<YesNo> };
  /** Document slots the applicant chose to provide later. */
  docsLater: string[];
  /** Tour shots skipped for now. */
  tourSkipped: string[];
}

export function emptyDossier(): Dossier {
  return {
    v: 1,
    setup: {},
    location: { floor: undefined, floors: undefined, street_kind: undefined, orientation: undefined },
    size: { interior: undefined, registered: undefined, arnona: undefined, plan: undefined, plot: undefined },
    rooms: { rooms: undefined, bedrooms: undefined, bathrooms: undefined, toilets: undefined, custom: [] },
    balconies: { count: undefined, items: [] },
    garden: { exists: undefined, kind: undefined, size: undefined },
    roof: { kind: undefined, size: undefined },
    parking: { count: undefined, kind: undefined, features: [] },
    storage: { exists: undefined, size: undefined, registered: undefined },
    building: { yearBuilt: undefined, elevator: undefined, shabbatElevator: undefined, mamad: undefined, shelter: undefined },
    legal: { registry: undefined, rights: undefined, capitalized: undefined, restrictions: undefined, deviations: undefined, renewal: undefined, enforcement: undefined },
    occupancy: { rent: undefined, leaseEnd: undefined, indexed: undefined, vaad: undefined, arnona: undefined, special: undefined },
    sale: { asking: undefined, advertised: undefined, since: undefined, reduced: undefined, agent: undefined },
    docsLater: [],
    tourSkipped: [],
  };
}

/** Fill in fields missing from an older saved dossier. */
export function upgradeDossier(d: Partial<Dossier> | null | undefined): Dossier {
  const e = emptyDossier();
  if (!d) return e;
  const out: any = { ...e, ...d };
  for (const k of Object.keys(e) as (keyof Dossier)[]) {
    const ev = (e as any)[k];
    if (ev && typeof ev === "object" && !Array.isArray(ev)) out[k] = { ...ev, ...((d as any)[k] ?? {}) };
  }
  return out as Dossier;
}

// ---- Which questions apply ---------------------------------------------------------------------

const HOUSES: PropertyType[] = ["detached", "semi_detached", "cottage", "townhouse", "house_on_plot"];
export const isHouse = (d: Dossier) => !!d.location.type && HOUSES.includes(d.location.type);
/** Garden questions: garden flats and houses (others may still say yes on the balcony card). */
export const asksGarden = (d: Dossier) => d.location.type === "garden_apartment" || isHouse(d);
/** Roof questions: penthouses, duplexes and houses. */
export const asksRoof = (d: Dossier) => d.location.type === "penthouse" || d.location.type === "duplex" || isHouse(d);
/** Floor questions don't apply to houses. */
export const asksFloor = (d: Dossier) => !isHouse(d);
export const asksPlot = (d: Dossier) => isHouse(d);
export const isRented = (d: Dossier) => d.occupancy.kind === "tenant" || d.occupancy.kind === "mixed";
export const isSale = (d: Dossier) => d.setup.purpose === "sale";
/** Capitalised lease applies to Israel Land Authority leaseholds. */
export const asksCapitalized = (d: Dossier) => d.legal.registry === "ila" && (d.legal.rights === "leasehold" || d.legal.rights === "long_lease");

// ---- Sections and progress ----------------------------------------------------------------------

export const SECTIONS = ["setup", "location", "property", "legal", "occupancy", "tour", "review"] as const;
export type SectionId = (typeof SECTIONS)[number];

const answered = (v: unknown) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

/** The questions of each section that count towards progress (only those that apply). */
export function sectionQuestions(d: Dossier, s: SectionId): unknown[] {
  switch (s) {
    case "setup": return [d.setup.purpose, d.setup.submitter];
    case "location": return [d.location.street, d.location.city, d.location.type, ...(asksFloor(d) ? [d.location.floor, d.location.floors] : []), d.location.pinConfirmed || undefined];
    case "property": return [
      d.size.interior, d.rooms.rooms, d.rooms.bedrooms, d.rooms.bathrooms, d.balconies.count,
      ...(asksGarden(d) ? [d.garden.exists] : []), ...(asksRoof(d) ? [d.roof.kind] : []),
      d.parking.count, d.storage.exists, d.building.yearBuilt, ...(asksFloor(d) ? [d.building.elevator] : []), d.building.mamad,
    ];
    case "legal": return [d.legal.registry, d.legal.rights, d.legal.restrictions, d.legal.deviations, d.legal.renewal];
    case "occupancy": return [d.occupancy.kind, ...(isRented(d) ? [d.occupancy.rent] : []), d.occupancy.vaad, ...(isSale(d) ? [d.sale.asking] : [])];
    default: return [];
  }
}

export function sectionProgress(d: Dossier, s: SectionId): { done: number; total: number } {
  const q = sectionQuestions(d, s);
  return { done: q.filter(answered).length, total: q.length };
}

export function overallProgress(d: Dossier, shots: { done: number; total: number }): number {
  const parts = (["setup", "location", "property", "legal", "occupancy"] as SectionId[]).map((s) => sectionProgress(d, s));
  const done = parts.reduce((a, p) => a + p.done, 0) + shots.done;
  const total = parts.reduce((a, p) => a + p.total, 0) + shots.total;
  return total ? Math.round((done / total) * 100) : 0;
}

// ---- Rooms for the tour ----------------------------------------------------------------------

export interface TourLayout { bedrooms: number; bathrooms: number; toilets: number; balconies: number; garden: boolean; storage: boolean; parking: boolean; extra: string[] }

export function tourLayout(d: Dossier): TourLayout {
  const n = (v: Maybe<number>, dflt: number) => (isKnown(v) ? Math.max(0, Math.round(v)) : dflt);
  const rooms = n(d.rooms.rooms, 3);
  return {
    bedrooms: n(d.rooms.bedrooms, Math.max(1, Math.floor(rooms) - 1)),
    bathrooms: n(d.rooms.bathrooms, 1),
    toilets: n(d.rooms.toilets, 0),
    balconies: n(d.balconies.count, 0),
    garden: d.garden.exists === "yes",
    storage: d.storage.exists === "yes",
    parking: n(d.parking.count, 0) > 0,
    extra: d.rooms.custom.map((x) => x.trim()).filter(Boolean),
  };
}

// ---- Things for the appraiser to look at -----------------------------------------------------

export interface Flag { kind: "area_registered" | "area_arnona" | "deviation_reported" | "enforcement"; a?: number; b?: number }

/** Differences worth the appraiser's attention. A difference is never called illegal here. */
export function flags(d: Dossier): Flag[] {
  const out: Flag[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) <= 0.05;
  if (isKnown(d.size.interior) && isKnown(d.size.registered) && !near(d.size.interior, d.size.registered))
    out.push({ kind: "area_registered", a: d.size.registered, b: d.size.interior });
  if (isKnown(d.size.interior) && isKnown(d.size.arnona) && !near(d.size.interior, d.size.arnona))
    out.push({ kind: "area_arnona", a: d.size.arnona, b: d.size.interior });
  if (Array.isArray(d.legal.deviations) && d.legal.deviations.length) out.push({ kind: "deviation_reported" });
  if (d.legal.enforcement === "yes") out.push({ kind: "enforcement" });
  return out;
}

// ---- To the valuation engine -----------------------------------------------------------------

/** The valuation inputs implied by the dossier, on top of an existing subject (keeps what is unknown). */
export function toSubject(d: Dossier, base: Subject): Subject {
  const L = d.location;
  const num = (v: Maybe<number>, dflt: number) => (isKnown(v) ? v : dflt);
  const addOns: AddOn[] = [];
  d.balconies.items.slice(0, isKnown(d.balconies.count) ? d.balconies.count : 0).forEach((b) =>
    addOns.push({ type: "sun_balcony", area: isKnown(b.size) ? b.size : 8, attachment: "attached", permitted: true }));
  if (d.garden.exists === "yes") addOns.push({ type: "garden", area: num(d.garden.size, 30), attachment: d.garden.kind === "shared" ? "assigned" : "attached", permitted: true });
  if (asksRoof(d) && (d.roof.kind === "private" || d.roof.kind === "exclusive")) addOns.push({ type: "roof_terrace", area: num(d.roof.size, 20), attachment: d.roof.kind === "private" ? "attached" : "assigned", permitted: true });
  if (d.storage.exists === "yes") addOns.push({ type: "storage", area: num(d.storage.size, 5), attachment: d.storage.registered === "yes" ? "attached" : "assigned", permitted: true });
  if (isKnown(d.parking.count) && d.parking.count > 0 && d.parking.kind !== "street")
    addOns.push({ type: "parking", count: d.parking.count, parkingKind: d.parking.features.includes("mechanical") ? "mechanical" : d.parking.features.includes("tandem") ? "tandem" : d.parking.features.includes("underground") ? "underground" : d.parking.features.includes("covered") ? "covered" : "regular", attachment: d.parking.kind === "registered" ? "attached" : "assigned", permitted: true });
  const yb = num(d.building.yearBuilt, base.yearBuilt);
  return {
    ...base,
    address: { city: L.city ?? "", street: L.street ?? "", number: L.number ?? "", ...(L.neighbourhood ? { neighborhood: L.neighbourhood } : {}) } as Subject["address"],
    location: L.pin ?? base.location,
    parcel: L.parcel ? { block: L.parcel.block, parcel: L.parcel.parcel, subParcel: L.parcel.sub } : base.parcel,
    rights: d.legal.rights === "leasehold" || d.legal.rights === "long_lease" ? "leasehold" : d.legal.rights === "ownership" ? "ownership" : base.rights,
    floor: asksFloor(d) ? num(L.floor, base.floor) : 0,
    floorsInBuilding: asksFloor(d) ? num(L.floors, base.floorsInBuilding) : Math.max(1, num(L.floors, 2)),
    elevator: asksFloor(d) ? d.building.elevator === "yes" : false,
    yearBuilt: yb,
    rooms: num(d.rooms.rooms, base.rooms),
    area: isKnown(d.size.interior)
      ? { mode: "declared", area: d.size.interior, source: d.size.interiorSource === "arnona" ? "arnona" : d.size.interiorSource === "registered" ? "tabu" : "user" }
      : base.area,
    addOns,
    directions: Array.isArray(L.orientation) ? L.orientation : [],
    hasSafeRoom: d.building.mamad === "yes",
    newBuild: yb >= new Date().getFullYear() - 1,
  };
}

/** A short number to quote on the phone or in email, e.g. BS-26-04817. */
export function applicationNumber(seq: number, year = new Date().getFullYear()): string {
  return `BS-${String(year % 100).padStart(2, "0")}-${String(seq).padStart(5, "0")}`;
}
