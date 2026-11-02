import { describe, expect, test } from "bun:test";
import { openDb, dealsNear } from "../server/db";
import { importDeals, parseCsv } from "../server/dealsImport";
import { parseNominatim, parseGoogle } from "../server/connectors/geocode";
import { discoverSeries, pickDistrictCode } from "../server/connectors/cbs";

describe("deals import", () => {
  test("Hebrew CSV headers, dd/mm/yyyy dates, Hebrew floors, geocoding when coordinates are missing", async () => {
    const csv = [
      "תאריך עסקה,מחיר מוצהר,ישוב,רחוב,מספר בית,גוש חלקה,שטח,חדרים,קומה,שנת בנייה",
      '17/05/2026,"2,950,000",תל אביב יפו,הירקון,120,006950-0042-012,92,4,שלישית,1972',
      "01/03/2026,4100000,תל אביב יפו,דיזנגוף,200,,110,5,7,",
      "bad,1,x,y,1,,1,1,1,",
    ].join("\n");
    const rows = parseCsv(csv);
    expect(rows[0]!.price).toBe("2,950,000");
    const db = openDb(":memory:");
    const fakeGeo = async () => [{ label: "x", lat: 32.08, lng: 34.77 }];
    const r = await importDeals(db, rows, "test", fakeGeo as any);
    expect(r.stored).toBe(2);
    expect(r.geocoded).toBe(2);
    expect(r.rejected).toHaveLength(1);
    const d = dealsNear(db, 32.08, 34.77, 500).find((x) => x.address.street === "הירקון")!;
    expect(d.date).toBe("2026-05-17");
    expect(d.floor).toBe(3);
    expect(d.parcel).toEqual({ block: "6950", parcel: "42", subParcel: "12" });
    expect(d.yearBuilt).toBe(1972);
  });
});

describe("geocoders", () => {
  test("Nominatim and Google results", () => {
    const n = parseNominatim([{ lat: "32.0778", lon: "34.7745", display_name: "x", address: { road: "דיזנגוף", house_number: "50", city: "תל אביב-יפו" } }]);
    expect(n[0]).toMatchObject({ street: "דיזנגוף", number: "50", city: "תל אביב-יפו", attribution: "© OpenStreetMap contributors" });
    const g = parseGoogle({ results: [{ formatted_address: "Dizengoff 50", geometry: { location: { lat: 32.07, lng: 34.77 } }, address_components: [{ long_name: "50", types: ["street_number"] }] }] });
    expect(g[0]!.number).toBe("50");
  });
});

describe("CBS catalogue (shape seen on the live server)", () => {
  test("chapter → subjects (subjectId/subjectName) → series (codeId/codeName)", async () => {
    const chapter = { chapterId: "aa", subject: [{ subjectId: 45, subjectName: "מדד מחירי דירות", code: null }, { subjectId: 16, subjectName: "שכר דירה", code: null }] };
    const subject45 = { code: [{ codeId: 40010, codeName: "מחוז תל אביב" }, { codeId: 40020, codeName: "מחוז ירושלים" }] };
    const subject16 = { code: [{ codeId: 50010, codeName: "מחוז תל אביב" }] };
    const f = (async (u: string) => new Response(JSON.stringify(u.includes("chapter") ? chapter : u.includes("id=45") ? subject45 : subject16))) as unknown as typeof fetch;
    const series = await discoverSeries(f);
    expect(series.find((s) => s.code === "40010")!.name).toBe("מדד מחירי דירות – מחוז תל אביב");
    expect(pickDistrictCode(series, "tel_aviv")).toBe("40010"); // dwelling index, not rent
  });
});
