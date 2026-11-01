import type { AddOn, AddOnType, Condition, ParkingKind, ViewQuality } from "./types";

/**
 * Configurable valuation parameters.
 *
 * IMPORTANT: every default below is a placeholder practice range written from general
 * knowledge, NOT a sourced or regulatory figure. They must be calibrated per city with partner
 * licensed appraisers before any real use. Every report prints the coefficient it used, and
 * appraisers can override any value (with a logged reason).
 */
export interface AddOnCoefficient {
  /** Coefficient applied to sqm (equivalent area = sqm × coefficient). */
  coefficient: number;
  /** Optional declining scale: the first `tierSqm` at `coefficient`, the rest at `beyondCoefficient`. */
  tierSqm?: number;
  beyondCoefficient?: number;
}

export interface ValuationConfig {
  version: string;
  city: string;
  addOns: Record<Exclude<AddOnType, "parking">, AddOnCoefficient>;
  /** Assigned (משויך, not registered) areas are discounted relative to attached ones. */
  assignedFactor: number;
  /** Unpermitted add-on area is valued at this fraction of its normal coefficient. */
  unpermittedFactor: number;
  /** Fixed value per parking space by kind (NIS). */
  parkingNis: Record<ParkingKind, number>;
  adjustments: {
    /** Per floor above ground, applied up to `floorCap` floors, when there is an elevator. */
    perFloorWithElevator: number;
    floorCap: number;
    /** Per floor above the 2nd when there is no elevator (negative). */
    perFloorNoElevatorAbove2: number;
    groundFloor: number;
    /** Per 10 years of building-age difference. */
    perDecadeAge: number;
    condition: Record<Condition, number>;
    view: Record<ViewQuality, number>;
    newBuildPremium: number;
    leaseholdDiscount: number;
  };
  comparables: {
    radiiM: number[];
    maxMonths: number;
    minComparables: number;
    maxComparables: number;
    /** Distance at which similarity weight halves. */
    distanceHalfM: number;
    /** Age (months) at which similarity weight halves. */
    recencyHalfMonths: number;
    /** Comparables whose total adjustment exceeds this are dropped. */
    maxGrossAdjustment: number;
  };
}

export const DEFAULT_CONFIG: ValuationConfig = {
  version: "defaults-0.1 (uncalibrated)",
  city: "*",
  addOns: {
    sun_balcony: { coefficient: 0.3 },
    covered_balcony: { coefficient: 0.4 },
    roof_terrace: { coefficient: 0.33, tierSqm: 40, beyondCoefficient: 0.2 },
    garden: { coefficient: 0.25, tierSqm: 30, beyondCoefficient: 0.12 },
    storage: { coefficient: 0.4 },
  },
  assignedFactor: 0.5,
  unpermittedFactor: 0.5,
  parkingNis: {
    regular: 150_000,
    covered: 170_000,
    underground: 180_000,
    tandem: 110_000,
    mechanical: 100_000,
  },
  adjustments: {
    perFloorWithElevator: 0.01,
    floorCap: 8,
    perFloorNoElevatorAbove2: -0.02,
    groundFloor: -0.03,
    perDecadeAge: 0.02,
    condition: { new: 0.08, renovated: 0.04, original: 0, needs_work: -0.08 },
    view: { blocked: -0.03, regular: 0, open: 0.03, sea: 0.08 },
    newBuildPremium: 0.05,
    leaseholdDiscount: -0.02,
  },
  comparables: {
    radiiM: [300, 600, 1000, 1500],
    maxMonths: 24,
    minComparables: 5,
    maxComparables: 15,
    distanceHalfM: 500,
    recencyHalfMonths: 12,
    maxGrossAdjustment: 0.3,
  },
};

export interface AddOnLine {
  addOn: AddOn;
  /** Equivalent sqm contributed (area-based add-ons). */
  equivalentSqm: number;
  /** Fixed NIS contributed (parking). */
  fixedNis: number;
  coefficientUsed: number | null;
  note?: "assigned" | "unpermitted" | "declining_scale";
}

export function valueAddOn(addOn: AddOn, cfg: ValuationConfig): AddOnLine {
  let factor = 1;
  let note: AddOnLine["note"];
  if (addOn.attachment === "assigned") {
    factor *= cfg.assignedFactor;
    note = "assigned";
  }
  if (!addOn.permitted) {
    factor *= cfg.unpermittedFactor;
    note = "unpermitted";
  }

  if (addOn.type === "parking") {
    const kind = addOn.parkingKind ?? "regular";
    const count = addOn.count ?? 1;
    return {
      addOn,
      equivalentSqm: 0,
      fixedNis: Math.round(cfg.parkingNis[kind] * count * factor),
      coefficientUsed: null,
      note,
    };
  }

  const c = cfg.addOns[addOn.type];
  const sqm = addOn.area ?? 0;
  let eq: number;
  if (c.tierSqm !== undefined && c.beyondCoefficient !== undefined && sqm > c.tierSqm) {
    eq = c.tierSqm * c.coefficient + (sqm - c.tierSqm) * c.beyondCoefficient;
    note = note ?? "declining_scale";
  } else {
    eq = sqm * c.coefficient;
  }
  eq *= factor;
  return {
    addOn,
    equivalentSqm: Math.round(eq * 100) / 100,
    fixedNis: 0,
    coefficientUsed: sqm > 0 ? Math.round((eq / sqm) * 1000) / 1000 : c.coefficient,
    note,
  };
}

/** Merge a partial city override over defaults (shallow per section). */
export function configFor(overrides?: Partial<ValuationConfig>): ValuationConfig {
  if (!overrides) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    addOns: { ...DEFAULT_CONFIG.addOns, ...(overrides.addOns ?? {}) },
    parkingNis: { ...DEFAULT_CONFIG.parkingNis, ...(overrides.parkingNis ?? {}) },
    adjustments: { ...DEFAULT_CONFIG.adjustments, ...(overrides.adjustments ?? {}) },
    comparables: { ...DEFAULT_CONFIG.comparables, ...(overrides.comparables ?? {}) },
  };
}
