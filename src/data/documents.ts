/**
 * Uploaded documents. Each document has a kind and a few key fields (entered or confirmed by
 * the user / appraiser). The fields feed the valuation and the report:
 *   - land-registry extract → rights, block/parcel, registered area, liens and caveats (legal chapter)
 *   - purchase contract     → previous sale of the unit
 *   - rental contract       → income cross-check (gross yield)
 *   - plans / permit / form 4 / condominium order → permit and area evidence (planning chapter)
 *   - arnona bill           → declared area
 *   - engineer report / prior appraisal → noted in the report
 * Every document is listed in the report's "documents relied upon" chapter.
 */
import type { RightsType, Subject } from "../engine/types";

export type DocKind =
  | "tabu"
  | "rights_confirmation"
  | "purchase_contract"
  | "rental_contract"
  | "floor_plan"
  | "building_permit"
  | "form4"
  | "arnona"
  | "condo_order"
  | "engineer_report"
  | "prior_appraisal"
  | "photos"
  | "advert_print"
  | "other";

export type FieldType = "date" | "money" | "number" | "text" | "bool" | "rights" | "planType";

export const DOC_FIELDS: Record<DocKind, { key: string; type: FieldType }[]> = {
  tabu: [
    { key: "date", type: "date" },
    { key: "rights", type: "rights" },
    { key: "block", type: "text" },
    { key: "parcel", type: "text" },
    { key: "subParcel", type: "text" },
    { key: "registeredArea", type: "number" },
    { key: "mortgage", type: "bool" },
    { key: "caveat", type: "bool" },
    { key: "notes", type: "text" },
  ],
  purchase_contract: [
    { key: "date", type: "date" },
    { key: "price", type: "money" },
    { key: "area", type: "number" },
  ],
  rental_contract: [
    { key: "date", type: "date" },
    { key: "endDate", type: "date" },
    { key: "monthlyRent", type: "money" },
  ],
  floor_plan: [
    { key: "planType", type: "planType" },
    { key: "area", type: "number" },
  ],
  building_permit: [
    { key: "permitNo", type: "text" },
    { key: "date", type: "date" },
    { key: "notes", type: "text" },
  ],
  form4: [{ key: "date", type: "date" }],
  arnona: [
    { key: "date", type: "date" },
    { key: "area", type: "number" },
  ],
  condo_order: [{ key: "notes", type: "text" }],
  engineer_report: [
    { key: "date", type: "date" },
    { key: "notes", type: "text" },
  ],
  prior_appraisal: [
    { key: "date", type: "date" },
    { key: "price", type: "money" },
    { key: "notes", type: "text" },
  ],
  photos: [{ key: "notes", type: "text" }],
  advert_print: [],
  rights_confirmation: [{ key: "date", type: "date" }, { key: "rights", type: "rights" }],
  other: [{ key: "notes", type: "text" }],
};

export interface DocumentRecord {
  id: string;
  kind: DocKind;
  fileName: string;
  size: number;
  mime: string;
  addedAt: string;
  fields: Record<string, string | number | boolean>;
  /** Browser object URL for preview (not persisted). */
  url?: string;
  /** Set once stored on the server. */
  serverId?: string;
  /** For printed Madlan/Yad2 pages: what the server read from them. */
  adverts?: { read: number; used: number; status: "reading" | "done" | "error"; error?: string; rows?: AdvertRow[] };
}

export interface AdvertRow { price: number; previousPrice?: number; rooms?: number; floor?: number; area?: number; address: string; used: boolean; reason?: string }

/** Guess the kind from the file name (Hebrew or English). */
export function guessKind(name: string): DocKind {
  const n = name.toLowerCase();
  if (/madlan|yad2|מדלן|יד ?2|למכירה|דירות מחכות/.test(n)) return "advert_print";
  if (/נסח|טאבו|tabu|registry|nesach/.test(n)) return "tabu";
  if (/שכירות|שכ"ד|rent|lease/.test(n)) return "rental_contract";
  if (/חוזה|הסכם|contract|purchase|מכר/.test(n)) return "purchase_contract";
  if (/טופס\s?4|תעודת גמר|form\s?4|completion/.test(n)) return "form4";
  if (/היתר|גרמושק|permit/.test(n)) return "building_permit";
  if (/תשריט|בית משותף|condo/.test(n)) return "condo_order";
  if (/תוכנית|תכנית|plan|floor/.test(n)) return "floor_plan";
  if (/ארנונה|arnona/.test(n)) return "arnona";
  if (/שומה|appraisal|הערכת שווי/.test(n)) return "prior_appraisal";
  if (/מהנדס|בדק בית|engineer|inspection/.test(n)) return "engineer_report";
  if (/\.(jpe?g|png|heic|webp)$/.test(n)) return "photos";
  return "other";
}

/** Facts derived from the documents that the engine and the report use. */
export interface DocumentFacts {
  rentMonthly?: number;
  rentDate?: string;
  contractSales: { date: string; price: number }[];
  registry?: {
    date?: string;
    rights?: RightsType;
    registeredArea?: number;
    mortgage?: boolean;
    caveat?: boolean;
    notes?: string;
  };
  permit?: { permitNo?: string; date?: string; notes?: string };
  form4Date?: string;
  arnonaArea?: number;
  planAreas: { planType: string; area: number }[];
  priorAppraisals: { date?: string; value?: number }[];
  engineerNotes?: string;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[,₪\s]/g, "")) : undefined);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function documentFacts(docs: DocumentRecord[]): DocumentFacts {
  const facts: DocumentFacts = { contractSales: [], planAreas: [], priorAppraisals: [] };
  for (const d of docs) {
    const f = d.fields;
    switch (d.kind) {
      case "tabu":
        facts.registry = {
          date: str(f.date),
          rights: f.rights === "leasehold" || f.rights === "ownership" ? f.rights : undefined,
          registeredArea: num(f.registeredArea),
          mortgage: f.mortgage === true,
          caveat: f.caveat === true,
          notes: str(f.notes),
        };
        break;
      case "purchase_contract": {
        const p = num(f.price);
        const dt = str(f.date);
        if (p && dt) facts.contractSales.push({ date: dt, price: p });
        break;
      }
      case "rental_contract": {
        const rent = num(f.monthlyRent);
        if (rent && (!facts.rentDate || (str(f.date) ?? "") > facts.rentDate)) {
          facts.rentMonthly = rent;
          facts.rentDate = str(f.date);
        }
        break;
      }
      case "building_permit":
        facts.permit = { permitNo: str(f.permitNo), date: str(f.date), notes: str(f.notes) };
        break;
      case "form4":
        facts.form4Date = str(f.date) ?? "";
        break;
      case "arnona":
        facts.arnonaArea = num(f.area);
        break;
      case "floor_plan": {
        const a = num(f.area);
        if (a) facts.planAreas.push({ planType: String(f.planType ?? "other"), area: a });
        break;
      }
      case "prior_appraisal":
        facts.priorAppraisals.push({ date: str(f.date), value: num(f.price) });
        break;
      case "engineer_report":
        facts.engineerNotes = str(f.notes);
        break;
    }
  }
  return facts;
}

/**
 * Apply registry facts to the subject: the land-registry extract is the authority for
 * rights and parcel identity. Returns a new subject; the form still lets the user override.
 */
export function applyRegistry(subject: Subject, docs: DocumentRecord[]): Subject {
  const tabu = docs.find((d) => d.kind === "tabu");
  if (!tabu) return subject;
  const f = tabu.fields;
  const block = str(f.block);
  const parcel = str(f.parcel);
  return {
    ...subject,
    rights: f.rights === "leasehold" || f.rights === "ownership" ? f.rights : subject.rights,
    parcel: block && parcel ? { ...(subject.parcel ?? {}), block, parcel, subParcel: str(f.subParcel) ?? subject.parcel?.subParcel } : subject.parcel,
  };
}
