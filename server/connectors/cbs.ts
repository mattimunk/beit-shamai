/**
 * CBS Index of Prices of Dwellings by district (api.cbs.gov.il, documented public API).
 *   catalog: https://api.cbs.gov.il/index/catalog/chapter?id=aa&format=json&lang=he
 *   data:    https://api.cbs.gov.il/index/data/price?id=<code>&format=json&startPeriod=mm-yyyy
 *
 * The district series codes are discovered from the catalog by name and can be pinned in
 * config once verified. The district index is published monthly (two-month moving periods).
 */
import type { PriceIndexPoint } from "../../src/engine/types";

export const CBS_BASE = "https://api.cbs.gov.il/index";

export type District = "jerusalem" | "north" | "haifa" | "center" | "tel_aviv" | "south";

export const DISTRICT_NAMES: Record<District, RegExp> = {
  jerusalem: /ירושלים|jerusalem/i,
  north: /צפון|north/i,
  haifa: /חיפה|haifa/i,
  center: /מרכז|central/i,
  tel_aviv: /תל אביב|tel aviv/i,
  south: /דרום|south/i,
};

/** Walk any JSON and collect {code, name} pairs that look like index series. */
export function collectSeries(json: unknown): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = [];
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const code = v.code ?? v.Code ?? v.id ?? v.codeId;
      const name = v.name ?? v.Name ?? v.title ?? v.desc ?? v.description;
      if (code !== undefined && typeof name === "string") out.push({ code: String(code), name });
      Object.values(v).forEach(walk);
    }
  };
  walk(json);
  return out;
}

export function pickDistrictCode(series: { code: string; name: string }[], d: District): string | undefined {
  const dwelling = series.filter((s) => /דירות|dwelling/i.test(s.name) && !/חדשות|new/i.test(s.name));
  return (dwelling.find((s) => DISTRICT_NAMES[d].test(s.name)) ?? series.find((s) => DISTRICT_NAMES[d].test(s.name)))?.code;
}

/** Parse observations: accepts {month: [{year, month, currBase:{value}}]} and similar shapes. */
export function parseIndexData(json: unknown): PriceIndexPoint[] {
  const pts: PriceIndexPoint[] = [];
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const y = v.year ?? v.Year;
      const m = v.month ?? v.Month;
      const val = v.currBase?.value ?? v.value ?? v.Value ?? v.index;
      if (y && m && typeof val === "number") {
        pts.push({ month: `${y}-${String(m).padStart(2, "0")}`, value: val });
        return;
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(json);
  const byMonth = new Map(pts.map((p) => [p.month, p]));
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

export async function fetchDistrictIndex(
  district: District,
  opts: { code?: string; startPeriod?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ code: string; points: PriceIndexPoint[] }> {
  const f = opts.fetchImpl ?? fetch;
  let code = opts.code;
  if (!code) {
    const cat = await (await f(`${CBS_BASE}/catalog/chapter?id=aa&format=json&download=false&lang=he`)).json();
    const series = collectSeries(cat);
    code = pickDistrictCode(series, district);
    if (!code) throw new Error(`CBS: no dwelling index series found for district ${district}`);
  }
  const start = opts.startPeriod ?? "01-2018";
  const res = await f(`${CBS_BASE}/data/price?id=${code}&format=json&download=false&startPeriod=${start}&lang=he`);
  if (!res.ok) throw new Error(`CBS ${res.status}`);
  return { code, points: parseIndexData(await res.json()) };
}
