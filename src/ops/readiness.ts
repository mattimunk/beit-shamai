/**
 * Two separate indicators for a property:
 *
 *  • Application completion – how much the applicant has told us (questions + tour shots).
 *  • Appraisal confidence – how reliable and sufficient the evidence is. Answers alone never
 *    raise it much: documents, the tour, verification and market evidence do.
 *
 * Each missing component carries a consequence the report states plainly (a limitation),
 * e.g. no floor plan → the layout and the legality of spaces cannot be verified.
 */
import { flags, isKnown, overallProgress, type Dossier } from "../dossier/schema";

export type MarketLevel = "none" | "insufficient" | "low" | "medium" | "high";
export type Freshness = "fresh" | "review" | "outdated" | "none";

export interface ReadinessInput {
  dossier?: Dossier;
  hasAddress: boolean;
  hasParcel: boolean;
  docKinds: string[];
  shots: { done: number; total: number };
  market: { level: MarketLevel; freshness: Freshness };
  /** An admin has checked the uploaded documents against the answers. */
  docsVerified: boolean;
}

export type Limitation =
  | "no_parcel" | "area_unverified" | "area_mismatch" | "no_ownership" | "no_plan" | "no_permit"
  | "no_tour" | "partial_tour" | "market_weak" | "market_none" | "market_stale" | "not_verified" | "no_physical";

export interface Component { key: string; weight: number; score: number; limitation?: Limitation }

export interface Readiness {
  /** 0–100 */
  completion: number;
  /** 0–100 */
  confidence: number;
  level: "low" | "moderate" | "good" | "high";
  components: Component[];
  limitations: Limitation[];
}

/** Which document proves ownership for this registry. */
export function ownershipKinds(d?: Dossier): string[] {
  const reg = d?.legal.registry;
  if (reg === "ila" || reg === "company" || reg === "amidar" || reg === "other") return ["rights_confirmation", "tabu"];
  return ["tabu", "rights_confirmation"];
}

export const MARKET_SCORE: Record<MarketLevel, number> = { none: 0, insufficient: 0, low: 0.4, medium: 0.7, high: 1 };

export function readiness(x: ReadinessInput): Readiness {
  const d = x.dossier;
  const has = (k: string) => x.docKinds.includes(k);
  const fl = d ? flags(d) : [];
  const c: Component[] = [];

  c.push({ key: "identification", weight: 10, score: (x.hasAddress ? 0.6 : 0) + (x.hasParcel ? 0.4 : 0), limitation: !x.hasParcel ? "no_parcel" : undefined });

  const phys = d ? [d.size.interior, d.rooms.rooms, d.building.yearBuilt, d.location.type].filter((v) => v !== undefined && v !== "unknown" && v !== "later").length / 4 : 0;
  c.push({ key: "physical", weight: 10, score: phys, limitation: phys < 0.5 ? "no_physical" : undefined });

  const mismatch = fl.some((f) => f.kind === "area_registered" || f.kind === "area_arnona");
  const regKnown = has("tabu") || (d ? isKnown(d.size.registered) : false);
  c.push({ key: "registered_area", weight: 10, score: mismatch ? 0.3 : regKnown ? 1 : 0, limitation: mismatch ? "area_mismatch" : regKnown ? undefined : "area_unverified" });

  const own = ownershipKinds(d).some(has);
  c.push({ key: "ownership", weight: 10, score: own ? 1 : 0, limitation: own ? undefined : "no_ownership" });

  const plan = has("floor_plan");
  c.push({ key: "floor_plan", weight: 10, score: plan ? 1 : 0, limitation: plan ? undefined : "no_plan" });

  const permit = has("building_permit") || has("form4");
  const devAnswered = d ? d.legal.deviations === "none" : false;
  c.push({ key: "legal", weight: 5, score: permit ? 1 : devAnswered ? 0.4 : 0, limitation: permit ? undefined : "no_permit" });

  const tour = x.shots.total ? Math.min(1, x.shots.done / x.shots.total) : 0;
  c.push({ key: "condition", weight: 15, score: tour, limitation: tour === 0 ? "no_tour" : tour < 0.7 ? "partial_tour" : undefined });

  const stale = x.market.freshness === "outdated" ? 0.6 : x.market.freshness === "review" ? 0.85 : 1;
  const m = MARKET_SCORE[x.market.level] * stale;
  c.push({
    key: "market", weight: 25, score: m,
    limitation: x.market.level === "none" || x.market.level === "insufficient" ? "market_none"
      : x.market.level === "low" ? "market_weak" : x.market.freshness === "outdated" ? "market_stale" : undefined,
  });

  c.push({ key: "verification", weight: 5, score: x.docsVerified ? 1 : 0, limitation: x.docsVerified ? undefined : "not_verified" });

  const total = c.reduce((a, k) => a + k.weight, 0);
  const confidence = Math.round((c.reduce((a, k) => a + k.weight * k.score, 0) / total) * 100);
  // No market evidence caps confidence: a value cannot be reliable without comparable sales.
  const capped = MARKET_SCORE[x.market.level] === 0 ? Math.min(confidence, 35) : confidence;
  const level = capped >= 80 ? "high" : capped >= 60 ? "good" : capped >= 40 ? "moderate" : "low";
  return {
    completion: d ? overallProgress(d, x.shots) : 0,
    confidence: capped,
    level,
    components: c,
    limitations: c.map((k) => k.limitation).filter((l): l is Limitation => !!l),
  };
}

/** Plain-language consequences, for the admin workbench and the client's preliminary report. */
export const LIMITATION_TEXT: Record<"he" | "en", Record<Limitation, string>> = {
  he: {
    no_parcel: "גוש/חלקה לא אומתו – זיהוי הנכס במרשם טרם נבדק.",
    no_physical: "חסרים פרטים פיזיים בסיסיים (שטח, חדרים, שנת בנייה).",
    area_unverified: "השטח הרשום לא אומת – ההערכה מבוססת על השטח שדווח.",
    area_mismatch: "קיים פער בין השטח המדווח לשטח הרשום – השמאי יבדוק.",
    no_ownership: "לא צורף מסמך בעלות – הזכויות בנכס לא אומתו.",
    no_plan: "לא צורפה תכנית דירה – לא ניתן לאמת את חלוקת השטחים ואת חוקיות חלק מהחללים.",
    no_permit: "לא צורף היתר בנייה – התאמת הנכס להיתר לא נבדקה.",
    no_tour: "לא צולם סיור – התאמת המצב והגימור מוגבלת ולא אומתה.",
    partial_tour: "הסיור חלקי – מצב חלק מהחדרים לא נבדק.",
    market_none: "אין די עסקאות השוואה – לא ניתן לקבוע שווי אמין.",
    market_weak: "מעט עסקאות השוואה – טווח ההערכה רחב יותר.",
    market_stale: "נתוני השוק אינם עדכניים – ייתכן שחסרות עסקאות אחרונות.",
    not_verified: "המסמכים טרם נבדקו מול הפרטים שמסרתם.",
  },
  en: {
    no_parcel: "Block/parcel not verified – the property's registry identity is unchecked.",
    no_physical: "Basic physical details are missing (area, rooms, year built).",
    area_unverified: "Registered area not verified – the estimate uses the reported area.",
    area_mismatch: "Reported and registered areas differ – the appraiser will check.",
    no_ownership: "No ownership document – property rights are unverified.",
    no_plan: "No floor plan – the layout and the legality of some spaces cannot be verified.",
    no_permit: "No building permit – conformity with the permit is unchecked.",
    no_tour: "No tour filmed – the condition adjustment is limited and unverified.",
    partial_tour: "Partial tour – some rooms' condition is unchecked.",
    market_none: "Not enough comparable sales – a reliable value cannot be set.",
    market_weak: "Few comparable sales – the estimate range is wider.",
    market_stale: "Market data is not current – recent sales may be missing.",
    not_verified: "Documents not yet checked against your answers.",
  },
};
