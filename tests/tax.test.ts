import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openDb, dealsNear } from "../server/db";
import { parseTaxExport } from "../server/connectors/taxExport";
import { importTaxExport, relocateUnlocated, rowToDeal } from "../server/taxImport";
import { areaBand, buildPlan, createRequest, getRequest, splitItem, uploadToItem } from "../server/requests";
import type { ParcelLayer } from "../server/connectors/parcels";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";
import type { Subject } from "../src/engine/types";

const SAMPLE = readFileSync(new URL("./fixtures/tax-export-sample.xls", import.meta.url), "utf8");

const LAYER: ParcelLayer = { url: "https://example.test/parcels/MapServer/0", wkid: 4326, blockField: "GUSH", parcelField: "HELKA" } as ParcelLayer;
/** Fake cadastre: every parcel is a small square near Tel Aviv. */
const fakeParcels = (async () =>
  new Response(JSON.stringify({ features: [{ attributes: {}, geometry: { rings: [[[34.78, 32.08], [34.781, 32.08], [34.781, 32.081], [34.78, 32.081], [34.78, 32.08]]] } }] }))) as unknown as typeof fetch;

/** Build an export like the real one with given criteria and row count. */
function makeExport(o: { from: string; to: string; areaFrom: number; areaTo?: number; city?: string; total: number; rows: number }) {
  const d = (iso: string) => iso.split("-").reverse().join("/");
  const head =
    `<b>סוג נכס:</b> דירת מגורים&nbsp<b>מיום מכירה:</b> ${d(o.from)}&nbsp<b>עד יום מכירה:</b> ${d(o.to)}&nbsp<br>` +
    `<b>שטח מ:</b> ${o.areaFrom}&nbsp${o.areaTo ? `<b>שטח עד:</b> ${o.areaTo}&nbsp` : ""}<br><b>ישוב: </b>${o.city ?? "תל אביב -יפו"}&nbsp<br/>קיימות ${o.total} תוצאות`;
  const th = ["גוש חלקה", "יום מכירה", "תמורה מוצהרת בש&quot;ח", "שווי מכירה בש&quot;ח", "מהות", "חלק נמכר", "ישוב", "שנת בניה", "שטח", "חדרים"]
    .map((h) => `<th>${h}</th>`).join("");
  const rows = Array.from({ length: o.rows }, (_, i) =>
    `<tr><td>006625-${String(100 + i).padStart(4, "0")}-001-00</td><td>${d(o.from)}</td><td>3,000,000</td><td>3,000,000</td><td>דירה בבית קומות</td><td>1.000</td><td>תל אביב -יפו</td><td>1990</td><td>${o.areaFrom + 5}</td><td>4</td></tr>`,
  ).join("");
  return `${head}<table><tr>${th}</tr>${rows}</table>`;
}

describe("Tax Authority export", () => {
  test("parses the real layout: criteria, rows, partial sale, no truncation", () => {
    const e = parseTaxExport(SAMPLE);
    expect(e.totalReported).toBe(6);
    expect(e.rows).toHaveLength(6);
    expect(e.truncated).toBe(false);
    expect(e.criteria.kind).toBe("דירת מגורים");
    expect(e.criteria.from).toBe("2026-08-03");
    expect(e.criteria.to).toBe("2026-11-03");
    expect(e.criteria.areaFrom).toBe(90);
    expect(e.rows[0]!.block).toBe("6625");
    expect(e.rows[0]!.parcel).toBe("869");
    expect(e.rows[0]!.saleValue).toBe(4_836_404);
    expect(e.rows.filter((r) => (r.fractionSold ?? 1) < 0.999)).toHaveLength(1);
  });

  test("flags a cut-off export (150 rows shown, more exist)", () => {
    const e = parseTaxExport(makeExport({ from: "2026-08-01", to: "2026-10-31", areaFrom: 70, total: 212, rows: 150 }));
    expect(e.truncated).toBe(true);
  });

  test("row → deal: off-plan when built after the sale, no street, carries fraction", () => {
    const row = parseTaxExport(SAMPLE).rows[0]!;
    const d = rowToDeal(row, { lat: 32.08, lng: 34.78, approx: false });
    expect(d.offPlan).toBe(true); // built 2030, sold 2026
    expect(d.address.street).toBe("");
    expect(d.floor).toBeUndefined();
    expect(d.price).toBe(4_836_404);
  });

  test("import without a parcel layer parks rows; relocate places them later", async () => {
    const db = openDb(":memory:");
    const r = await importTaxExport(db, SAMPLE, undefined);
    expect(r.stored).toBe(0);
    expect(r.unlocated).toBe(6);
    const again = await relocateUnlocated(db, LAYER, fakeParcels);
    expect(again.placed).toBe(6);
    expect(dealsNear(db, 32.0805, 34.7805, 300).length).toBe(6);
  });

  test("import with a parcel layer stores deals and counts partial / off-plan", async () => {
    const db = openDb(":memory:");
    const r = await importTaxExport(db, SAMPLE, LAYER, undefined, fakeParcels);
    expect(r.stored).toBe(6);
    expect(r.partial).toBe(1);
    expect(r.offPlan).toBeGreaterThan(0);
  });
});

describe("data requests", () => {
  const subject: Subject = { ...DEMO_SUBJECT, address: { ...DEMO_SUBJECT.address, city: "תל אביב-יפו" }, area: { mode: "declared", area: 100 } } as Subject;

  test("plan: 4 quarters back from today, newest first, area band around the subject", () => {
    const plan = buildPlan(subject, "2026-11-03");
    expect(plan).toHaveLength(4);
    expect(plan[0]!.to).toBe("2026-11-03");
    expect(plan[0]!.from).toBe("2026-08-04");
    expect(plan[1]!.to).toBe("2026-08-03");
    expect(plan[3]!.from).toBe("2025-11-04");
    expect(areaBand(100)).toEqual([75, 135]);
  });

  test("split: by date into ~120-result pieces using the export's total; by area when too short", () => {
    const base = { id: "x", requestId: "r", city: "c", kind: "k", status: "truncated" as const, areaFrom: 75, areaTo: 135 };
    const two = splitItem({ ...base, from: "2026-08-04", to: "2026-11-03" });
    expect(two).toHaveLength(2);
    expect(two[0]!.to < two[1]!.from).toBe(true);
    const four = splitItem({ ...base, from: "2026-08-04", to: "2026-11-03" }, 430); // a Tel Aviv quarter
    expect(four).toHaveLength(4);
    expect(four[0]!.from).toBe("2026-08-04");
    expect(four[3]!.to).toBe("2026-11-03");
    for (let k = 1; k < 4; k++) expect(four[k]!.from).toBe(new Date(Date.parse(four[k - 1]!.to) + 864e5).toISOString().slice(0, 10));
    const [c, d] = splitItem({ ...base, from: "2026-10-28", to: "2026-11-03" }, 200); // a week: halve the area
    expect(c!.from).toBe(d!.from);
    expect(c!.areaTo + 1).toBe(d!.areaFrom);
  });

  test("workflow: preliminary → truncated upload splits → uploads finish → final; later request reuses coverage", async () => {
    const db = openDb(":memory:");
    const today = new Date().toISOString().slice(0, 10);
    const req = createRequest(db, subject, today);
    expect(req.status).toBe("preliminary");
    expect(req.items.filter((i) => i.status === "pending")).toHaveLength(4);

    // Wrong file: kept, but the search stays open.
    const first = req.items[0]!;
    const wrong = await uploadToItem(db, req.id, first.id, makeExport({ from: first.from, to: first.to, areaFrom: first.areaFrom, areaTo: first.areaTo, city: "חיפה", total: 3, rows: 3 }), LAYER, fakeParcels);
    expect(wrong.mismatch.length).toBeGreaterThan(0);
    expect(wrong.item.status).toBe("pending");

    // Cut off at 150: split into two narrower searches.
    const cut = await uploadToItem(db, req.id, first.id, makeExport({ from: first.from, to: first.to, areaFrom: first.areaFrom, areaTo: first.areaTo, total: 230, rows: 150 }), LAYER, fakeParcels);
    expect(cut.item.status).toBe("truncated");
    expect(cut.newItems).toHaveLength(2);

    let r = getRequest(db, req.id)!;
    for (const it of r.items.filter((i) => i.status === "pending")) {
      const out = await uploadToItem(db, req.id, it.id, makeExport({ from: it.from, to: it.to, areaFrom: it.areaFrom, areaTo: it.areaTo, total: 40, rows: 40 }), LAYER, fakeParcels);
      expect(out.item.status).toBe("done");
    }
    r = getRequest(db, req.id)!;
    expect(r.status).toBe("final");

    // A second request for a similar flat in the same city needs no new searches.
    const req2 = createRequest(db, { ...subject, area: { mode: "declared", area: 100 }, rooms: 5 } as Subject, today);
    expect(req2.items.every((i) => i.status === "covered")).toBe(true);
    expect(req2.status).toBe("final");
  });
});

describe("national parcel layer", () => {
  test("shapefile in a ZIP → one point per parcel and per block; deals placed from it", async () => {
    const { importParcelZip, parcelPoint } = await import("../server/connectors/parcelsOpen");
    const db = openDb(":memory:");
    const r = await importParcelZip(db, new URL("./fixtures/parcels-mini.zip", import.meta.url).pathname);
    expect(r).toMatchObject({ parcels: 3, blocks: 2, blockField: "GUSH_NUM", parcelField: "PARCEL" });
    const p = parcelPoint(db, "6625", "869")!;
    expect(p.approx).toBe(false);
    expect(p.lat).toBeGreaterThan(32.0);
    expect(p.lat).toBeLessThan(32.15);
    expect(p.lng).toBeGreaterThan(34.7);
    expect(p.lng).toBeLessThan(34.85);
    expect(parcelPoint(db, "6625", "999")!.approx).toBe(true); // unknown parcel → block centre
    expect(parcelPoint(db, "1", "1")).toBeNull();
    // A Tax Authority export imported with no ArcGIS layer is placed from the local points.
    const imp = await importTaxExport(db, SAMPLE, undefined);
    expect(imp.stored).toBe(3); // the three sales in block 6625; the other blocks are not in the mini layer
    expect(imp.unlocated).toBe(3);
  });
});

describe("partly covering uploads", () => {
  const subject = { ...DEMO_SUBJECT, address: { ...DEMO_SUBJECT.address, city: "תל אביב-יפו" }, area: { mode: "declared", area: 100 } } as Subject;

  test("narrower date ranges count; the rest becomes new searches; uploads to any row count", async () => {
    const db = openDb(":memory:");
    const req = createRequest(db, subject, "2026-06-30");
    const q = req.items.find((i) => i.status === "pending" && i.to === "2026-06-30")!; // 2026-03-31 … 2026-06-30
    expect(q.from).toBe("2026-03-31");
    // The user narrowed the dates to stay under 150: April and May only, uploaded to that row.
    await uploadToItem(db, req.id, q.id, makeExport({ from: "2026-03-31", to: "2026-04-30", areaFrom: q.areaFrom, areaTo: q.areaTo, total: 120, rows: 120 }), LAYER, fakeParcels);
    const out = await uploadToItem(db, req.id, q.id, makeExport({ from: "2026-05-01", to: "2026-05-31", areaFrom: q.areaFrom, areaTo: q.areaTo, total: 110, rows: 110 }), LAYER, fakeParcels);
    // Everything that descends from the original search:
    const all = out.request.items;
    const ids = new Set([q.id]);
    for (let grew = true; grew;) { grew = false; for (const i of all) if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) { ids.add(i.id); grew = true; } }
    const kids = all.filter((i) => i.id !== q.id && ids.has(i.id));
    expect(all.find((i) => i.id === q.id)!.status).toBe("split");
    expect(kids.filter((k) => k.status === "covered").map((k) => [k.from, k.to]).sort()).toEqual([["2026-03-31", "2026-04-30"], ["2026-05-01", "2026-05-31"]]);
    expect(kids.filter((k) => k.status === "pending")).toHaveLength(1);
    const rest = kids.find((k) => k.status === "pending")!;
    expect([rest.from, rest.to]).toEqual(["2026-06-01", "2026-06-30"]);
    // June uploaded to a *different* row still closes it.
    const other = out.request.items.find((i) => i.status === "pending" && i.id !== rest.id)!;
    const fin = await uploadToItem(db, req.id, other.id, makeExport({ from: "2026-06-01", to: "2026-06-30", areaFrom: 50, total: 90, rows: 90 }), LAYER, fakeParcels);
    expect(fin.request.items.find((i) => i.id === rest.id)!.status).toBe("covered");
    expect(fin.item.note).toBe("no_overlap");
  });

  test("search length learned from earlier uploads: ~120 results each (Tel Aviv: about 3 weeks)", async () => {
    const db = openDb(":memory:");
    // 430 sales of 75–135 sqm in a quarter: ~4.7 a day → searches of ~25 days.
    await importTaxExport(db, makeExport({ from: "2026-05-05", to: "2026-08-04", areaFrom: 75, areaTo: 135, total: 430, rows: 150 }), LAYER, undefined, fakeParcels);
    const req = createRequest(db, subject, "2026-11-03");
    const open = req.items.filter((i) => i.status === "pending");
    const lens = open.map((i) => (Date.parse(i.to) - Date.parse(i.from)) / 864e5 + 1);
    expect(Math.max(...lens)).toBeLessThanOrEqual(26);
    expect(Math.min(...lens)).toBeGreaterThanOrEqual(20);
    expect(open.length).toBeGreaterThanOrEqual(13);
    // A city never uploaded before keeps 3-month searches.
    const other = createRequest(db, { ...subject, address: { ...subject.address, city: "חדרה" } } as Subject, "2026-11-03");
    expect(other.items).toHaveLength(4);
  });
});
