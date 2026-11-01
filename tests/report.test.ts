import { describe, expect, test } from "bun:test";
import { hebrewNis, englishNis } from "../src/i18n/numberWords";
import { hebrewLetterNumber } from "../src/ui/ShumaReport";
import { applyRegistry, documentFacts, guessKind, type DocumentRecord } from "../src/data/documents";
import { valuate } from "../src/engine/valuation";
import { DemoProvider, DEMO_VALUATION_DATE } from "../src/data/demo/demoProvider";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";

describe("amounts in words", () => {
  test("Hebrew legal style", () => {
    expect(hebrewNis(3_330_000)).toBe("שלושה מיליון שלוש מאות ושלושים אלף שקלים חדשים");
    expect(hebrewNis(1_180_000)).toBe("מיליון מאה ושמונים אלף שקלים חדשים");
    expect(hebrewNis(4_001_000)).toBe("ארבעה מיליון ואלף שקלים חדשים");
    expect(hebrewNis(2_000_000)).toBe("שני מיליון שקלים חדשים");
    expect(hebrewNis(12_450_000)).toBe("שנים עשר מיליון ארבע מאות וחמישים אלף שקלים חדשים");
  });
  test("English", () => {
    expect(englishNis(3_330_000)).toBe("three million three hundred and thirty thousand new shekels");
  });
});

describe("Hebrew item numbering", () => {
  test("א … י, י״א, ט״ו, ט״ז, כ״א", () => {
    expect([1, 9, 10, 11, 15, 16, 20, 21].map(hebrewLetterNumber)).toEqual(["א", "ט", "י", "י״א", "ט״ו", "ט״ז", "כ", "כ״א"]);
  });
});

const doc = (kind: DocumentRecord["kind"], fields: DocumentRecord["fields"]): DocumentRecord => ({
  id: Math.random().toString(36), kind, fileName: "x.pdf", size: 1, mime: "application/pdf", addedAt: "2026-11-01", fields,
});

describe("documents", () => {
  test("kind guessed from Hebrew and English file names", () => {
    expect(guessKind("נסח טאבו 6789.pdf")).toBe("tabu");
    expect(guessKind("חוזה שכירות 2026.pdf")).toBe("rental_contract");
    expect(guessKind("חוזה רכישה.pdf")).toBe("purchase_contract");
    expect(guessKind("טופס 4.pdf")).toBe("form4");
    expect(guessKind("building permit.pdf")).toBe("building_permit");
    expect(guessKind("IMG_2231.jpg")).toBe("photos");
  });
  test("registry extract sets rights and parcel; contracts become facts", () => {
    const docs = [
      doc("tabu", { block: "1111", parcel: "22", subParcel: "3", rights: "leasehold", mortgage: true }),
      doc("rental_contract", { date: "2026-01-01", monthlyRent: 8200 }),
      doc("purchase_contract", { date: "2015-05-05", price: 1_500_000 }),
    ];
    const s = applyRegistry(DEMO_SUBJECT, docs);
    expect(s.rights).toBe("leasehold");
    expect(s.parcel).toEqual({ block: "1111", parcel: "22", subParcel: "3" });
    const f = documentFacts(docs);
    expect(f.rentMonthly).toBe(8200);
    expect(f.registry?.mortgage).toBe(true);
    expect(f.contractSales).toEqual([{ date: "2015-05-05", price: 1_500_000 }]);
  });
  test("rent gives an income cross-check; contract sale joins the unit's history", async () => {
    const r = await valuate(DEMO_SUBJECT, new DemoProvider(), DEMO_VALUATION_DATE, {
      rentMonthly: 8200,
      contractSales: [{ date: "2015-05-05", price: 1_500_000 }],
    });
    expect(r.income?.grossYield).toBeCloseTo((8200 * 12) / r.value!.point, 6);
    expect(r.income?.impliedLow).toBeLessThan(r.income!.impliedHigh);
    expect(r.market.priorSales.map((d) => d.date)).toContain("2015-05-05");
  });
});
