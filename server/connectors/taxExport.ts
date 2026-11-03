/**
 * Parser for the Tax Authority "מערכת מידע נדל"ן" export (the file it downloads as .xls is
 * really an HTML table). Layout seen in a real export (Nov 2026):
 *
 *   header:  סוג נכס: דירת מגורים · מיום מכירה: 03/08/2026 · עד יום מכירה: 03/11/2026 ·
 *            שטח מ: 90 · ישוב: תל אביב -יפו · "קיימות 87 תוצאות"
 *   columns: גוש חלקה | יום מכירה | תמורה מוצהרת בש"ח | שווי מכירה בש"ח | מהות | חלק נמכר |
 *            ישוב | שנת בניה | שטח | חדרים
 *
 * The system returns at most 150 rows per search; when the stated count is higher (or exactly
 * 150 rows came back) the export is truncated and the search must be narrowed.
 */
import { parseGush } from "../govmap";

export const TAX_SEARCH_LIMIT = 150;

export interface TaxCriteria {
  kind?: string; // סוג נכס
  from?: string; // ISO
  to?: string; // ISO
  areaFrom?: number;
  areaTo?: number;
  roomsFrom?: number;
  roomsTo?: number;
  city?: string;
  block?: string;
  street?: string;
  raw: Record<string, string>;
}

export interface TaxRow {
  block: string;
  parcel: string;
  subParcel?: string;
  date: string; // ISO
  declared?: number;
  saleValue?: number;
  kind?: string;
  fractionSold?: number;
  city?: string;
  yearBuilt?: number;
  area?: number;
  rooms?: number;
}

export interface TaxExport {
  criteria: TaxCriteria;
  totalReported?: number;
  rows: TaxRow[];
  truncated: boolean;
  skipped: number;
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

const num = (v?: string) => {
  if (!v) return undefined;
  const n = Number(v.replace(/[,₪\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};
const dmy = (v?: string) => {
  const m = v?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : undefined;
};

/** Normalise the city spelling the system uses ("תל אביב -יפו" → "תל אביב יפו"). */
export const normaliseTaxCity = (c: string) => c.replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim();

export function parseTaxExport(text: string): TaxExport {
  const s = text.replace(/^﻿/, "");
  const tableAt = s.search(/<table/i);
  const head = tableAt >= 0 ? s.slice(0, tableAt) : s;

  // "<b>label:</b> value" pairs in the header
  const raw: Record<string, string> = {};
  for (const m of head.matchAll(/<b>\s*([^<:]+?)\s*:\s*<\/b>([\s\S]*?)(?=<b>|<br|<table|$)/gi)) {
    raw[decode(m[1]!)] = decode(m[2]!);
  }
  const pick = (re: RegExp) => Object.entries(raw).find(([k]) => re.test(k))?.[1];
  const criteria: TaxCriteria = {
    kind: pick(/סוג נכס/),
    from: dmy(pick(/^מיום|מתאריך/)),
    to: dmy(pick(/^עד יום|עד תאריך/)),
    areaFrom: num(pick(/^שטח מ/)),
    areaTo: num(pick(/^שטח עד/)),
    roomsFrom: num(pick(/^חדרים מ/)),
    roomsTo: num(pick(/^חדרים עד/)),
    city: pick(/ישוב|יישוב/) ? normaliseTaxCity(pick(/ישוב|יישוב/)!) : undefined,
    block: pick(/^גוש/),
    street: pick(/רחוב/),
    raw,
  };
  const totalReported = num(decode(head).match(/קיימות\s+([\d,]+)\s+תוצאות/)?.[1]);

  // Table: header row decides the column order.
  const trs = [...s.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => decode(c[1]!)),
  );
  const headerIdx = trs.findIndex((r) => r.some((c) => /גוש/.test(c)) && r.some((c) => /יום מכירה|תאריך/.test(c)));
  const rows: TaxRow[] = [];
  let skipped = 0;
  if (headerIdx >= 0) {
    const h = trs[headerIdx]!;
    const col = (re: RegExp) => h.findIndex((c) => re.test(c));
    const iGush = col(/גוש/), iDate = col(/יום מכירה|תאריך/), iDecl = col(/תמורה/), iValue = col(/שווי/),
      iKind = col(/מהות/), iFrac = col(/חלק נמכר/), iCity = col(/ישוב|יישוב/), iYear = col(/שנת בני/),
      iArea = col(/^שטח/), iRooms = col(/חדרים/);
    for (const r of trs.slice(headerIdx + 1)) {
      const g = parseGush(r[iGush] ?? "");
      const date = dmy(r[iDate]);
      if (!g || !date) { skipped++; continue; }
      rows.push({
        block: g.block,
        parcel: g.parcel,
        subParcel: g.subParcel,
        date,
        declared: num(r[iDecl]),
        saleValue: num(r[iValue]),
        kind: iKind >= 0 ? r[iKind] : undefined,
        fractionSold: iFrac >= 0 ? num(r[iFrac]) : undefined,
        city: iCity >= 0 && r[iCity] ? normaliseTaxCity(r[iCity]!) : criteria.city,
        yearBuilt: iYear >= 0 ? num(r[iYear]) : undefined,
        area: iArea >= 0 ? num(r[iArea]) : undefined,
        rooms: iRooms >= 0 ? num(r[iRooms]) : undefined,
      });
    }
  }
  const truncated = (totalReported !== undefined && totalReported > rows.length + skipped) || rows.length >= TAX_SEARCH_LIMIT;
  return { criteria, totalReported, rows, truncated, skipped };
}
