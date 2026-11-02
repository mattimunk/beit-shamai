/**
 * Renewal signals from public layers:
 *  - Urban Renewal Authority declared complexes (מתחמי פינוי-בינוי מוכרזים)
 *  - Planning Administration plans near the property (submitted / deposited / approved)
 * Both become RenewalSignal records. Only renewal-related plans are kept; other plans are not
 * renewal signals and would clutter the report.
 */
import type { RenewalSignal, RenewalStage } from "../../src/engine/types";
import { arcgisDate, attr, queryAround, type ArcgisFeature, type ArcgisLayer } from "./arcgis";

const RENEWAL_WORDS = /התחדשות|פינוי|בינוי|תמ"?א\s?38|חיזוק|הריסה ובני|עיבוי|urban renewal/i;

/** Plan status text → stage. Israeli plan statuses vary in wording between systems. */
export function planStage(status: string): RenewalStage | null {
  const s = status.replace(/["׳״']/g, "");
  if (/אושר|בתוקף|מאושר|approved|in force/i.test(s)) return "plan_approved";
  if (/הופקד|הפקד|מופקד|deposit/i.test(s)) return "plan_deposited";
  if (/הוגש|הגשה|בדיקת תנאי סף|קליטה|submitted|בהליך|בבדיקה/i.test(s)) return "plan_submitted";
  if (/נדח|בוטל|rejected|cancel/i.test(s)) return null;
  return "plan_submitted";
}

export function planToSignal(f: ArcgisFeature, sourceLabel: string, sourceUrl?: string): RenewalSignal | null {
  const a = f.attributes;
  const name = String(attr(a, ["pl_name", "plan_name", "PL_NAME", "name", "shem_tochnit", "שם תכנית"]) ?? "");
  const number = String(attr(a, ["pl_number", "plan_number", "PL_NUMBER", "mispar_tochnit", "number"]) ?? "");
  const goals = String(attr(a, ["pl_objectives", "pl_goals", "goals", "matarot", "description", "pl_landuse_string"]) ?? "");
  if (!RENEWAL_WORDS.test(`${name} ${goals}`)) return null;
  const stage = planStage(String(attr(a, ["internet_short_status", "station_desc", "status", "pl_status", "STATUS", "שלב"]) ?? ""));
  if (!stage) return null;
  const units = Number(attr(a, ["quantity_delta_120", "units_added", "yechidot_diur", "dwelling_units"]));
  return {
    id: `plan-${number || name}`,
    projectKey: `plan-${number || name}`,
    type: "plan",
    stage,
    date: arcgisDate(attr(a, ["last_update_date", "pl_date_8", "status_date", "date", "update_date"])) ?? new Date().toISOString().slice(0, 10),
    location: f.location,
    label: number ? `${name} (${number})` : name,
    unitsPlanned: Number.isFinite(units) && units > 0 ? units : undefined,
    source: { label: sourceLabel, url: String(attr(a, ["pl_url"]) ?? "") || sourceUrl },
  };
}

export function complexToSignal(f: ArcgisFeature, sourceLabel: string, sourceUrl?: string): RenewalSignal {
  const a = f.attributes;
  const name = String(attr(a, ["shem_mitcham", "complex_name", "name", "NAME", "שם מתחם", "mitcham"]) ?? "מתחם פינוי-בינוי");
  const existing = Number(attr(a, ["yachad_kayam", "existing_units", "units_existing", "יח\"ד קיימות"]));
  const planned = Number(attr(a, ["yachad_chadash", "planned_units", "units_planned", "יח\"ד מתוכננות"]));
  const id = String(attr(a, ["objectid", "OBJECTID", "id"]) ?? name);
  return {
    id: `complex-${id}`,
    projectKey: `complex-${id}`,
    type: "declared_complex",
    // Declaration in the tax track follows deposit and 67% signatures; treat as at least that.
    stage: "representation_signed",
    date: arcgisDate(attr(a, ["declaration_date", "taarich_hachraza", "date"])) ?? new Date().toISOString().slice(0, 10),
    location: f.location,
    label: name,
    unitsExisting: Number.isFinite(existing) && existing > 0 ? existing : undefined,
    unitsPlanned: Number.isFinite(planned) && planned > 0 ? planned : undefined,
    source: { label: sourceLabel, url: sourceUrl },
  };
}

export async function fetchRenewalSignals(
  layers: { plans?: ArcgisLayer; complexes?: ArcgisLayer },
  center: { lat: number; lng: number },
  radiusM: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ signals: RenewalSignal[]; errors: string[] }> {
  const signals: RenewalSignal[] = [];
  const errors: string[] = [];
  if (layers.complexes) {
    try {
      for (const f of await queryAround(layers.complexes, center, radiusM, fetchImpl)) {
        signals.push(complexToSignal(f, "Urban Renewal Authority", layers.complexes.url));
      }
    } catch (e) { errors.push(`complexes: ${(e as Error).message}`); }
  }
  if (layers.plans) {
    try {
      for (const f of await queryAround(layers.plans, center, radiusM, fetchImpl)) {
        const s = planToSignal(f, "Planning Administration", layers.plans.url);
        if (s) signals.push(s);
      }
    } catch (e) { errors.push(`plans: ${(e as Error).message}`); }
  }
  return { signals, errors };
}
