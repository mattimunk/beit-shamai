// Core domain types for the Beit Shamai valuation engine.
// Terminology follows the Appraisal Standards Committee's professional dictionary (2025)
// and Standard 9.1 (definition of "apartment area", approved by the Council 15/9/2026).

export type LatLng = { lat: number; lng: number };

export type RightsType = "ownership" | "leasehold";
export type Condition = "new" | "renovated" | "original" | "needs_work";
export type ViewQuality = "blocked" | "regular" | "open" | "sea";
export type Direction = "N" | "S" | "E" | "W";

export interface Address {
  city: string;
  street: string;
  number: string;
  neighborhood?: string;
}

/** Property identification per Standard 4.2 (block / parcel / sub-parcel). */
export interface ParcelId {
  block: string; // גוש (or "גוש שומא" for unsettled land)
  parcel: string; // חלקה
  subParcel?: string; // תת-חלקה
  unsettled?: boolean; // מקרקעין לא מוסדרים
  unregistered?: boolean; // מקרקעין לא רשומים
}

/** One level of an apartment, measured per Standard 9.1 (boundary-based polygon). */
export interface AreaLevel {
  name: string;
  /** Floor area inside the rooms and internal partitions (sqm). */
  internalArea: number;
  /** Exterior walls: counted to their outer face (full thickness). */
  exteriorWallLengthM: number;
  exteriorWallThicknessCm: number;
  /** Walls shared with common space or another unit: half thickness, capped at 10 cm. */
  sharedWallLengthM: number;
  sharedWallThicknessCm: number;
  /** Laundry niches (מסתור כביסה) – excluded from apartment area. */
  laundryNicheSqm?: number;
  /** Attic / sloped parts: only area with height >= 1.80 m counts. */
  atticAreaAtLeast180?: number;
  atticAreaBelow180?: number;
  /** Area above the staircase on the upper level, treated as a shaft (פיר) to avoid double counting. */
  stairShaftSqm?: number;
}

export type AreaInput =
  | { mode: "declared"; area: number; source: "tabu" | "contract" | "arnona" | "user" }
  | { mode: "measured"; levels: AreaLevel[] };

export type AddOnType =
  | "sun_balcony"
  | "covered_balcony"
  | "roof_terrace"
  | "garden"
  | "storage"
  | "parking";

export type ParkingKind = "regular" | "covered" | "underground" | "tandem" | "mechanical";

export interface AddOn {
  type: AddOnType;
  /** sqm for area-based add-ons; ignored for parking. */
  area?: number;
  /** number of spaces for parking. */
  count?: number;
  parkingKind?: ParkingKind;
  /** Attached (צמוד) in the registry vs assigned (משויך) by agreement only. */
  attachment: "attached" | "assigned";
  /** False when the add-on is not in the permit (e.g. enclosed balcony). */
  permitted: boolean;
}

export interface Subject {
  address: Address;
  location: LatLng;
  parcel?: ParcelId;
  rights: RightsType;
  floor: number;
  floorsInBuilding: number;
  elevator: boolean;
  yearBuilt: number;
  rooms: number;
  area: AreaInput;
  addOns: AddOn[];
  condition: Condition;
  view: ViewQuality;
  directions: Direction[];
  hasSafeRoom: boolean; // ממ"ד
  newBuild: boolean;
  /** Renewal inputs for the building itself (optional). */
  building?: BuildingInfo;
}

export interface BuildingInfo {
  unitsInBuilding: number;
  plotSqm: number;
  existingBuiltSqm: number;
  /** Total building rights in the applicable plan, as % of plot (e.g. 150). */
  planRightsPercent?: number;
  ownRenewalProjectStage?: RenewalStage;
}

// ---------- Market data ----------

export type EvidenceClass = "completed_deal" | "asking_price" | "professional_opinion";

export interface Deal {
  id: string;
  evidence: "completed_deal";
  source: string; // e.g. "tax_authority"
  date: string; // ISO date of the transaction
  price: number; // NIS
  location: LatLng;
  address: Address;
  parcel?: ParcelId;
  /** Area as registered / reported. Normalised to Standard 9.1 where possible. */
  area: number;
  rooms: number;
  /** Not in the Tax Authority export: assumed like the subject and flagged. */
  floor?: number;
  /** Unknown in some registry rows. */
  floorsInBuilding?: number;
  /** Unknown in registry rows: assumed like the subject and flagged. */
  elevator?: boolean;
  /** Unknown in some registry rows: no age adjustment, flagged. */
  yearBuilt?: number;
  newBuild: boolean;
  /** Sold by a developer before completion (year built after the sale year). */
  offPlan?: boolean;
  /** Share of the unit sold (Tax Authority "חלק נמכר"); below 1 = partial sale. */
  fractionSold?: number;
  /** Registry deal type ("מהות"), e.g. "דירה בבית קומות", "דירת גן". */
  kind?: string;
  condition?: Condition;
  rights?: RightsType;
  view?: ViewQuality;
  /** Equivalent add-on area if known (sqm after coefficients), else 0. */
  addOnEquivalentSqm?: number;
  parkingSpaces?: number;
}

/**
 * One unit's advert as tracked by the listing ledger. The same flat on Yad2 and Madlan is two
 * Listing rows (different source/sourceId); the matcher links either to the later deal.
 */
export interface Listing {
  id: string;
  evidence: "asking_price";
  source: string; // e.g. "yad2", "madlan", "agency"
  sourceId: string; // the advert's id on its source
  firstSeen: string;
  lastSeen: string;
  /** "removed" once the advert disappears from the feed (sold, withdrawn or expired). */
  status: "active" | "removed";
  /** Latest asking price. */
  askingPrice: number;
  /** Every observed price, oldest first. */
  priceHistory: { date: string; price: number }[];
  location: LatLng;
  /** Adverts often omit the house number; leave it "" when unknown. */
  address: Address;
  /** Advertised area – often gross / marketing area, larger than the registered area. */
  area: number;
  rooms: number;
  floor?: number;
  floorsInBuilding?: number;
  elevator?: boolean;
  yearBuilt?: number;
  newBuild?: boolean;
  parcel?: ParcelId;
}

export interface PriceIndexPoint {
  month: string; // YYYY-MM
  value: number;
}

// ---------- Location & renewal ----------

export type TransitMode = "bus" | "rail" | "light_rail" | "metro";

export interface TransitStop {
  id: string;
  name: string;
  mode: TransitMode;
  location: LatLng;
  /** Departures per hour at weekday morning peak, from GTFS. */
  peakDeparturesPerHour: number;
}

export type LineMaturity =
  | "operating"
  | "under_construction"
  | "approved"
  | "in_planning"
  | "proposed";

export interface FutureLine {
  id: string;
  name: string;
  mode: TransitMode;
  maturity: LineMaturity;
  expectedOpening?: string; // free text, e.g. "2030s"
  stations: { id: string; name: string; location: LatLng }[];
  /** Parcels inside the plan's expropriation line ("block-parcel"). */
  expropriationParcels?: string[];
  source?: { label: string; url?: string };
}

export type RenewalStage =
  | "none"
  | "reported" // news or marketing only, unconfirmed
  | "representation_signed"
  | "developer_selected"
  | "plan_submitted"
  | "plan_deposited"
  | "plan_approved"
  | "permit_application"
  | "permit"
  | "construction";

export type SignalType =
  | "declared_complex"
  | "plan"
  | "permit_application"
  | "committee_minutes"
  | "news"
  | "marketing";

export interface RenewalSignal {
  id: string;
  projectKey: string; // signals about the same project share a key
  type: SignalType;
  stage: RenewalStage;
  date: string;
  location: LatLng;
  label: string;
  unitsExisting?: number;
  unitsPlanned?: number;
  plannedFloors?: number;
  source: { label: string; url?: string };
}

export interface CityPolicy {
  city: string;
  /** Approved replacement plan for TAMA 38 (building-level renewal). */
  hasBuildingRenewalPlan: boolean;
  /** Municipal urban-renewal policy document exists. */
  hasRenewalPolicy: boolean;
  /** Betterment-levy rate applied to building renewal (Amendment 139 default 25%). */
  renewalLevyPercent: number;
}
