import { distanceM } from "./geo";
import type { CityPolicy, LatLng, RenewalSignal, RenewalStage, SignalType, Subject } from "./types";

export const STAGE_ORDER: RenewalStage[] = [
  "none",
  "reported",
  "representation_signed",
  "developer_selected",
  "plan_submitted",
  "plan_deposited",
  "plan_approved",
  "permit_application",
  "permit",
  "construction",
];

export const SIGNAL_RELIABILITY: Record<SignalType, "high" | "medium_high" | "medium" | "low"> = {
  declared_complex: "high",
  plan: "high",
  permit_application: "high",
  committee_minutes: "medium_high",
  news: "medium",
  marketing: "low",
};

export type PotentialReason =
  | "old_building"
  | "no_safe_room"
  | "unused_rights"
  | "low_density"
  | "in_declared_complex"
  | "near_metro"
  | "city_has_renewal_plan"
  | "city_no_renewal_plan"
  | "already_new"
  | "many_units";

export interface RenewalPotential {
  level: "low" | "medium" | "high";
  points: number;
  reasons: { key: PotentialReason; points: number }[];
  ownStage: RenewalStage;
}

export interface NearbyProject {
  projectKey: string;
  label: string;
  location: LatLng;
  distanceM: number;
  /** Stage confirmed by reliable signals; news/marketing alone can only yield "reported". */
  stage: RenewalStage;
  unitsExisting?: number;
  unitsPlanned?: number;
  plannedFloors?: number;
  signals: RenewalSignal[];
  latestSignal: string;
  /** Most recent signal from the most reliable source type available. */
  bestSignal: RenewalSignal;
  unconfirmed: boolean;
}

export interface RenewalResult {
  potential: RenewalPotential;
  nearby: NearbyProject[];
  radiusM: number;
  policy?: CityPolicy;
}

export function renewalPotential(
  subject: Subject,
  valuationYear: number,
  ctx: { inDeclaredComplex: boolean; nearMetro: boolean; policy?: CityPolicy },
): RenewalPotential {
  const reasons: RenewalPotential["reasons"] = [];
  const add = (key: PotentialReason, points: number) => reasons.push({ key, points });

  const age = valuationYear - subject.yearBuilt;
  if (subject.newBuild || age < 25) add("already_new", -4);
  else if (subject.yearBuilt < 1980) add("old_building", 3);
  else if (age >= 35) add("old_building", 1);

  if (!subject.hasSafeRoom && !subject.newBuild) add("no_safe_room", 1);

  const b = subject.building;
  if (b) {
    const builtPct = (b.existingBuiltSqm / b.plotSqm) * 100;
    if (b.planRightsPercent !== undefined && b.planRightsPercent - builtPct >= 50) add("unused_rights", 2);
    if (builtPct < 120) add("low_density", 1);
    if (b.unitsInBuilding > 24) add("many_units", -1); // harder to reach the required majority
  }
  if (ctx.inDeclaredComplex) add("in_declared_complex", 3);
  if (ctx.nearMetro) add("near_metro", 2);
  if (ctx.policy) {
    if (ctx.policy.hasBuildingRenewalPlan || ctx.policy.hasRenewalPolicy) add("city_has_renewal_plan", 1);
    else add("city_no_renewal_plan", -1);
  }

  const points = reasons.reduce((s, r) => s + r.points, 0);
  const level = points >= 6 ? "high" : points >= 3 ? "medium" : "low";
  return { level, points, reasons, ownStage: b?.ownRenewalProjectStage ?? "none" };
}

/** Group signals by project and derive each project's stage conservatively. */
export function nearbyProjects(at: LatLng, signals: RenewalSignal[], radiusM = 500): NearbyProject[] {
  const byKey = new Map<string, RenewalSignal[]>();
  for (const s of signals) {
    if (distanceM(at, s.location) > radiusM) continue;
    const list = byKey.get(s.projectKey) ?? [];
    list.push(s);
    byKey.set(s.projectKey, list);
  }

  const out: NearbyProject[] = [];
  for (const [projectKey, list] of byKey) {
    const reliable = list.filter((s) => s.type !== "news" && s.type !== "marketing");
    const stageFrom = (arr: RenewalSignal[]) =>
      arr.reduce<RenewalStage>(
        (best, s) => (STAGE_ORDER.indexOf(s.stage) > STAGE_ORDER.indexOf(best) ? s.stage : best),
        "none",
      );
    const unconfirmed = reliable.length === 0;
    const stage = unconfirmed ? "reported" : stageFrom(reliable);
    const latest = [...list].sort((a, b) => (a.date < b.date ? 1 : -1))[0]!;
    const withUnits = [...list].reverse().find((s) => s.unitsPlanned !== undefined);
    const withFloors = [...list].reverse().find((s) => s.plannedFloors !== undefined);
    out.push({
      projectKey,
      label: (reliable[0] ?? list[0])!.label,
      location: list[0]!.location,
      distanceM: distanceM(at, list[0]!.location),
      stage,
      unitsExisting: withUnits?.unitsExisting,
      unitsPlanned: withUnits?.unitsPlanned,
      plannedFloors: withFloors?.plannedFloors,
      signals: [...list].sort((a, b) => (a.date < b.date ? 1 : -1)),
      latestSignal: latest.date,
      bestSignal: [...(reliable.length ? reliable : list)].sort((a, b) => (a.date < b.date ? 1 : -1))[0]!,
      unconfirmed,
    });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM);
}

export function isInDeclaredComplex(at: LatLng, signals: RenewalSignal[], radiusM = 60): boolean {
  return signals.some((s) => s.type === "declared_complex" && distanceM(at, s.location) <= radiusM);
}
