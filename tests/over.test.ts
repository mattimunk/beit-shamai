import { describe, expect, test } from "bun:test";
import { openDb, dealsNear } from "../server/db";
import { importTaxExport } from "../server/taxImport";
import { createRequest, getRequest, reconcileRequest, uploadToItem } from "../server/requests";
import { ensureParcelPoints } from "../server/connectors/parcelsOpen";
import { OverApi } from "../server/connectors/over";
import {
  blocksNear, compareWithOver, floorFromGovmap, govmapRowToDeal, overRowToDeal, parseBlockList, pullOverForRequest, pullTaxBlock,
  type GovmapRow, type OverRow,
} from "../server/overDeals";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";
import type { Subject } from "../src/engine/types";

const DAY = 86_400_000;
const at = { lat: 31.7745, lng: 35.2146 };
const subject = {
  ...DEMO_SUBJECT,
  address: { ...DEMO_SUBJECT.address, city: "ירושלים" },
  location: at,
  parcel: { block: "30079", parcel: "213" },
  area: { mode: "declared", area: 100 },
} as Subject;
const NO_GAPS = new Set<number>();

/** Parcel points: blocks 30079 and 30077 near the subject, 40000 far away. */
function seedParcels(db: ReturnType<typeof openDb>) {
  ensureParcelPoints(db);
  const ins = db.prepare(`INSERT INTO parcel_points (block, parcel, lat, lng) VALUES (?, ?, ?, ?)`);
  for (const [b, p, dLat] of [[30079, 213, 0.0005], [30079, 199, 0.001], [30079, 110, 0.0012], [30079, 105, 0.0013], [30077, 154, 0.004], [40000, 1, 0.05]] as const) {
    ins.run(b, p, at.lat + dLat, at.lng);
  }
  db.query(`INSERT INTO block_points (block, lat, lng, parcels) VALUES (30079, ?, ?, 4)`).run(at.lat + 0.001, at.lng);
}

type ExportRow = [string, string, number, number, number, number];
/** A Tax Authority export with explicit rows: [gush-helka-sub, date, amount, fraction, area, rooms]. */
function exportOf(from: string, to: string, rows: ExportRow[]) {
  const d = (iso: string) => iso.split("-").reverse().join("/");
  const head = `<b>סוג נכס:</b> דירת מגורים&nbsp<b>מיום מכירה:</b> ${d(from)}&nbsp<b>עד יום מכירה:</b> ${d(to)}&nbsp<br><b>שטח מ:</b> 75&nbsp<b>שטח עד:</b> 135&nbsp<br><b>ישוב: </b>ירושלים&nbsp<br/>קיימות ${rows.length} תוצאות`;
  const th = ["גוש חלקה", "יום מכירה", "תמורה מוצהרת בש&quot;ח", "שווי מכירה בש&quot;ח", "מהות", "חלק נמכר", "ישוב", "שנת בניה", "שטח", "חדרים"].map((h) => `<th>${h}</th>`).join("");
  const tr = rows.map(([g, date, amt, frac, area, rooms]) =>
    `<tr><td>${g}</td><td>${d(date)}</td><td>${amt.toLocaleString("en")}</td><td>${amt.toLocaleString("en")}</td><td>דירה בבית קומות</td><td>${frac}</td><td>ירושלים</td><td>1960</td><td>${area}</td><td>${rooms}</td></tr>`).join("");
  return `${head}<table><tr>${th}</tr>${tr}</table>`;
}

/** A row as Over's /api/deals/search returns it (strings for block/parcel/sub-parcel). */
const taxRow = (gush: number, helka: number, sub: string, date: string, amount: number, extra: Partial<OverRow> = {}): OverRow => ({
  gush: String(gush), helka: String(helka), sub_parcel: sub, date, amount, declared_amount: amount, nature: "דירה בבית קומות",
  area_sqm: 90, rooms: 3, year_built: 1960, portion_fraction: 1, settlement: "ירושלים", ...extra,
});

let nextId = 3_785_000_000;
/** A row as Over's /api/deals/govmap/search returns it (numbers, ISO date, a point). */
const govRow = (gush: number, parcel: number, sub: number, date: string, amount: number, extra: Partial<GovmapRow> = {}): GovmapRow => ({
  objectid: 900_000 + (nextId % 1000), deal_id: nextId++, deal_date: date, deal_amount: amount, settlement: "ירושלים", street: "ירמיהו", house_num: "24",
  floor: null, asset_area: 90, rooms: 3, property_type: "דירה", deal_nature: "דירה בבית קומות", gush, parcel, sub_parcel: sub,
  lon: at.lng + 0.0003, lat: at.lat + 0.0008, ...extra,
});

/** A fake Over REST API over fixed rows: both searches, filtered, sorted and paged like the real one. */
function fakeApi(tax: OverRow[], gov: GovmapRow[], calls: { path: string; params: any }[] = []) {
  return {
    async get(path: string, p: any) {
      calls.push({ path, params: p });
      const dateOf = (x: any) => (path === "/deals/search" ? x.date : x.deal_date.slice(0, 10));
      const src: any[] = path === "/deals/search" ? tax : path === "/deals/govmap/search" ? gov : [];
      if (!src && path !== "/deals/search") throw new Error("unknown path " + path);
      let hit = src.filter((x) =>
        (p.gush === undefined || Number(x.gush) === p.gush) &&
        (p.settlement === undefined || x.settlement === p.settlement) &&
        (p.date_from === undefined || dateOf(x) >= p.date_from) &&
        (p.date_to === undefined || dateOf(x) <= p.date_to));
      hit = hit.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
      if (p.sort === "date_desc") hit.reverse();
      const offset = p.offset ?? 0, limit = p.limit ?? 50;
      return { data: hit.slice(offset, offset + limit), total: Math.min(hit.length, 10_000) };
    },
  };
}

describe("GovMap floors and gap lists", () => {
  test("Hebrew floor words → numbers", () => {
    expect(floorFromGovmap("קרקע")).toBe(0);
    expect(floorFromGovmap("ראשונה")).toBe(1);
    expect(floorFromGovmap("שלישית")).toBe(3);
    expect(floorFromGovmap("שנייה")).toBe(2);
    expect(floorFromGovmap("עשירית")).toBe(10);
    expect(floorFromGovmap("אחת עשרה")).toBe(11);
    expect(floorFromGovmap("שתים עשרה")).toBe(12);
    expect(floorFromGovmap("עשרים")).toBe(20);
    expect(floorFromGovmap("עשרים ושתיים")).toBe(22);
    expect(floorFromGovmap("מרתף")).toBe(-1);
    expect(floorFromGovmap("ראשונה, שניה")).toBe(1); // duplex: the lower floor
    expect(floorFromGovmap("קומה 4")).toBe(4);
    expect(floorFromGovmap("7")).toBe(7);
    expect(floorFromGovmap(null)).toBeUndefined();
    expect(floorFromGovmap("גג")).toBeUndefined();
  });

  test("block lists with ranges", () => {
    const s = parseBlockList("30028, 30033-30035,30109");
    expect([...s]).toEqual([30028, 30033, 30034, 30035, 30109]);
  });
});

describe("same sale, one id", () => {
  test("identical rows in an export are kept as separate sales", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const eight = Array.from({ length: 8 }, () => ["030079-0199-063-00", "2026-06-21", 533333, 0.111, 90, 3] as ExportRow);
    const r = await importTaxExport(db, exportOf("2026-06-01", "2026-06-30", eight), undefined);
    expect(r.stored).toBe(8);
    const ids = dealsNear(db, at.lat, at.lng, 2000).map((d) => d.id).sort();
    expect(ids[0]).toBe("tax-30079-199-63-2026-06-21-533333");
    expect(ids).toContain("tax-30079-199-63-2026-06-21-533333#8");
  });

  test("a Tax Authority copy row gets the same id as the uploaded row", () => {
    const d = overRowToDeal(taxRow(30079, 213, "021", "2026-06-18", 6333600), { ...at, approx: false });
    expect(d.id).toBe("tax-30079-213-21-2026-06-18-6333600");
    expect(overRowToDeal(taxRow(30079, 213, "000", "2026-06-03", 5e6), { ...at, approx: false }).parcel?.subParcel).toBeUndefined();
  });

  test("a GovMap row keeps its floor, address and point, with year built from the Tax Authority copy", () => {
    const g = govRow(30079, 199, 63, "2026-06-21", 4_848_400, { floor: "קרקע", street: "אלקנה", house_num: "14", rooms: 4 });
    const d = govmapRowToDeal(g, { lat: g.lat!, lng: g.lon!, approx: false }, taxRow(30079, 199, "063", "2026-06-21", 533_333, { portion_fraction: 0.111 }));
    expect(d.floor).toBe(0);
    expect(d.address.street).toBe("אלקנה");
    expect(d.address.number).toBe("14");
    expect(d.price).toBe(4_848_400);
    expect(d.yearBuilt).toBe(1960);
    expect(d.fractionSold).toBeUndefined(); // GovMap shows the whole sale
    expect(d.parcel).toEqual({ block: "30079", parcel: "199", subParcel: "63" });
  });
});

describe("Over's REST API", () => {
  test("query string, retry on 503, error on 404", async () => {
    const seen: string[] = [];
    let n = 0;
    const f = (async (url: string) => {
      seen.push(url);
      if (url.includes("missing")) return new Response("{}", { status: 404 });
      if (n++ === 0) return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ data: [1] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const api = new OverApi({ fetchImpl: f }, { gapMs: 0, base: "https://www.over.org.il/api" });
    expect(await api.get("/deals/search", { gush: 30079, date_from: "2026-05-01", helka: undefined })).toEqual({ data: [1] });
    expect(seen[0]).toBe("https://www.over.org.il/api/deals/search?gush=30079&date_from=2026-05-01");
    expect(seen.length).toBe(2);
    await expect(api.get("/missing")).rejects.toThrow("HTTP 404");
  });
});

describe("pulling Over by block", () => {
  test("blocks within the radius, not the far one", () => {
    const db = openDb(":memory:");
    seedParcels(db);
    expect(blocksNear(db, at.lat, at.lng, 1000)).toEqual([30077, 30079]);
  });

  test("pages to the end of a block (Over's total is not trusted)", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => taxRow(30079, 1 + (i % 40), "001", "2026-03-01", 1_000_000 + i));
    const calls: any[] = [];
    const got = await pullTaxBlock(fakeApi(rows, [], calls), 30079, "2025-11-01", "2026-11-18");
    expect(got.length).toBe(450);
    expect(calls.map((c) => c.params.offset)).toEqual([0, 200, 400]);
  });

  test("a request pulls both mirrors, keeps one deal per sale, and shrinks the plan", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const tax = [
      taxRow(30079, 110, "011", "2026-05-30", 4_200_000, { rooms: 3, area_sqm: 63 }),
      taxRow(30079, 199, "063", "2026-06-21", 533_333, { portion_fraction: 0.111 }), // heirs: Over keeps one of 9
      taxRow(30077, 154, "027", "2026-06-01", 3_180_000, { rooms: 2.5, area_sqm: 65 }), // not in GovMap
      taxRow(30079, 213, "005", "2026-04-01", 900_000, { nature: "חנות", rooms: null }),
      taxRow(30079, 1, "001", "2026-03-01", 2_000_000, { nature: "מגורים", rooms: null }), // land/rights, not flats
      taxRow(40000, 1, "001", "2026-06-01", 1_000_000), // far block: not pulled
    ];
    const gov = [
      govRow(30079, 110, 11, "2026-05-30", 4_200_000, { floor: "שלישית", rooms: 3, asset_area: 63 }),
      govRow(30079, 199, 63, "2026-06-21", 4_848_400, { floor: "קרקע", street: "אלקנה", house_num: "14", rooms: 4 }),
      govRow(30079, 31, 15, "2026-07-07", 3_900_000, { floor: "שלישית", street: "אבן האזל", house_num: "9" }), // newer than the Tax Authority copy
      govRow(30079, 22, 7, "2026-09-17", 4_500_000, { street: "עזרת תורה", house_num: "4" }),
      govRow(30079, 178, 20, "2026-07-12", 1_200_000, { deal_nature: "חנות", property_type: "בנין" }),
      govRow(30079, 9, 1, "2048-01-01", 1, {}), // a date as published, beyond today
    ];
    const req = createRequest(db, subject, "2026-11-18");
    const d = await pullOverForRequest(db, req.id, { api: fakeApi(tax, gov), today: "2026-11-18", marginDays: 30, gapBlocks: NO_GAPS });
    expect(d.error).toBeUndefined();
    expect(d.blocks).toEqual([30077, 30079]);
    expect(d.govmapRows).toBe(4);
    expect(d.taxRows).toBe(3);
    expect(d.rows).toBe(5); // 4 GovMap sales + the one only in the Tax Authority copy
    expect(d.excluded).toEqual({ "חנות": 2, "מגורים": 1 });
    expect(d.govmapNewest).toBe("2026-09-17");
    expect(d.taxNewest).toBe("2026-06-21");
    expect(d.through).toBe("2026-08-18"); // newest GovMap sale − 30 days
    expect(d.govmapMissing).toEqual([30077]);
    expect(d.blind).toEqual([]);

    const lib = dealsNear(db, at.lat, at.lng, 2000);
    const byParcel = (p: string) => lib.filter((x) => `${x.parcel?.block}/${x.parcel?.parcel}` === p);
    const heirs = byParcel("30079/199");
    expect(heirs.length).toBe(1);
    expect(heirs[0]).toMatchObject({ price: 4_848_400, floor: 0, yearBuilt: 1960, address: { street: "אלקנה", number: "14" } });
    expect(heirs[0]!.id.startsWith("gm-")).toBe(true);
    expect(byParcel("30079/110")).toHaveLength(1); // in both mirrors: stored once
    expect(byParcel("30079/110")[0]!.floor).toBe(3);
    expect(byParcel("30077/154")[0]!.id).toBe("tax-30077-154-27-2026-06-01-3180000");
    expect(byParcel("30079/31")).toHaveLength(1);
    expect(lib.some((x) => x.date > "2026-11-18")).toBe(false);

    reconcileRequest(db, req.id, Date.parse("2026-11-18") / DAY);
    const r = getRequest(db, req.id)!;
    const live = r.items.filter((i) => i.status !== "split");
    const over = live.filter((i) => i.status === "over");
    const pending = live.filter((i) => i.status === "pending");
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((i) => i.to <= "2026-08-18")).toBe(true);
    expect(pending.every((i) => i.from >= "2026-08-19")).toBe(true);
    expect(pending.some((i) => i.from === "2026-08-19")).toBe(true); // the search that straddled the date was split
    expect(r.status).toBe("preliminary");
    expect(r.over?.status).toBe("done");

    // Uploading the months after Over's cover makes the report final.
    for (const it of pending) {
      const rows: ExportRow[] = it.from <= "2026-08-30" && it.to >= "2026-08-30" ? [["030079-0105-020-00", "2026-08-30", 3_424_000, 1, 63, 2]] : [];
      await uploadToItem(db, req.id, it.id, exportOf(it.from, it.to, rows), undefined);
    }
    expect(getRequest(db, req.id)!.status).toBe("final");
  });

  test("an upload replaces Over's copy of a sale, except where it has only part-sales", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const req = createRequest(db, subject, "2026-11-18");
    await pullOverForRequest(db, req.id, {
      api: fakeApi([], [
        govRow(30079, 213, 21, "2026-06-18", 6_333_600, { rooms: 5, asset_area: 121 }),
        govRow(30079, 199, 63, "2026-06-21", 4_848_400),
      ]),
      today: "2026-11-18",
      gapBlocks: NO_GAPS,
    });
    expect(dealsNear(db, at.lat, at.lng, 2000).filter((x) => x.id.startsWith("gm-"))).toHaveLength(2);
    await importTaxExport(db, exportOf("2026-06-01", "2026-06-30", [
      ["030079-0213-021-00", "2026-06-18", 6_333_600, 1, 121, 5],
      ...Array.from({ length: 9 }, () => ["030079-0199-063-00", "2026-06-21", 533_333, 0.111, 90, 3] as ExportRow),
    ]), undefined);
    const lib = dealsNear(db, at.lat, at.lng, 2000);
    expect(lib.filter((x) => x.parcel?.parcel === "213").map((x) => x.id)).toEqual(["tax-30079-213-21-2026-06-18-6333600"]);
    const heirs = lib.filter((x) => x.parcel?.parcel === "199");
    expect(heirs.filter((x) => x.id.startsWith("gm-"))).toHaveLength(1); // the whole-sale row stays
    expect(heirs.filter((x) => x.id.startsWith("tax-"))).toHaveLength(9);

    // Pulling again does not bring back the copy the upload replaced.
    await pullOverForRequest(db, req.id, {
      api: fakeApi([], [govRow(30079, 213, 21, "2026-06-18", 6_333_600)]),
      today: "2026-11-30", cacheDays: 0, gapBlocks: NO_GAPS,
    });
    expect(dealsNear(db, at.lat, at.lng, 2000).filter((x) => x.parcel?.parcel === "213").map((x) => x.id)).toEqual(["tax-30079-213-21-2026-06-18-6333600"]);
  });

  test("a known-gap block with no rows in either mirror: nothing counts as covered", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const req = createRequest(db, subject, "2026-11-18");
    const d = await pullOverForRequest(db, req.id, {
      api: fakeApi([taxRow(30077, 154, "027", "2026-06-01", 3_180_000)], [govRow(30077, 154, 27, "2026-09-01", 3_180_000)]),
      today: "2026-11-18", gapBlocks: new Set([30079]),
    });
    expect(d.blind).toEqual([30079]);
    expect(d.through).toBeUndefined();
    reconcileRequest(db, req.id, Date.parse("2026-11-18") / DAY);
    expect(getRequest(db, req.id)!.items.some((i) => i.status === "over")).toBe(false);
  });

  test("a known-gap block without mapped parcels is found by its GovMap point", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const req = createRequest(db, subject, "2026-11-18");
    const gov = [
      govRow(30045, 12, 3, "2026-08-01", 3_000_000, { lat: at.lat - 0.003, lon: at.lng }), // ~330 m away, not in the parcel layer
      govRow(30060, 1, 1, "2026-08-01", 3_000_000, { lat: at.lat - 0.05, lon: at.lng }), // ~5.5 km away
      govRow(30079, 110, 11, "2026-05-30", 4_200_000),
    ];
    const d = await pullOverForRequest(db, req.id, { api: fakeApi([], gov), today: "2026-11-18", gapBlocks: new Set([30045, 30060, 30061]) });
    expect(d.blocks).toEqual([30045, 30077, 30079]);
    expect(d.blind).toEqual([]); // GovMap has its sales
    expect(d.taxMissing).toEqual([30045, 30079]);
    expect(d.through).toBeDefined();
    expect(dealsNear(db, at.lat, at.lng, 2000).some((x) => x.parcel?.block === "30045")).toBe(true);
  });

  test("a second request near the same blocks uses the cached pull", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const calls: any[] = [];
    const api = fakeApi([taxRow(30079, 213, "021", "2026-06-18", 6_333_600)], [govRow(30079, 213, 21, "2026-06-18", 6_333_600)], calls);
    const blockCalls = () => calls.filter((c) => c.params.gush !== undefined).length;
    const a = createRequest(db, subject, "2026-11-18");
    await pullOverForRequest(db, a.id, { api, today: "2026-11-18", gapBlocks: NO_GAPS });
    const n = blockCalls();
    const b = createRequest(db, subject, "2026-11-18");
    const d = await pullOverForRequest(db, b.id, { api, today: "2026-11-19", gapBlocks: NO_GAPS });
    expect(blockCalls()).toBe(n);
    expect(d.blocksCached).toBe(2);
    expect(d.rows).toBe(1);
    // After OVER_CACHE_DAYS the blocks are pulled again.
    await pullOverForRequest(db, b.id, { api, today: "2026-11-30", gapBlocks: NO_GAPS });
    expect(blockCalls()).toBeGreaterThan(n);
  });

  test("a failed pull leaves the plan as it was", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const req = createRequest(db, subject, "2026-11-18");
    const d = await pullOverForRequest(db, req.id, { api: { get: async () => { throw new Error("Over: HTTP 503"); } }, today: "2026-11-18", gapBlocks: NO_GAPS });
    expect(d.error).toContain("503");
    reconcileRequest(db, req.id, Date.parse("2026-11-18") / DAY);
    expect(getRequest(db, req.id)!.items.some((i) => i.status === "over")).toBe(false);
  });
});

describe("upload against Over", () => {
  test("Yirmiyahu case: matched, missing from both, missing from the Tax Authority copy, merged, newer", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const req = createRequest(db, subject, "2026-11-18");
    await pullOverForRequest(db, req.id, {
      api: fakeApi(
        [
          taxRow(30079, 110, "011", "2026-05-30", 4_200_000),
          taxRow(30079, 213, "021", "2026-06-18", 6_333_600),
          taxRow(30079, 199, "063", "2026-06-21", 533_333, { portion_fraction: 0.111 }),
          taxRow(30077, 154, "027", "2026-06-01", 3_180_000),
        ],
        [
          govRow(30079, 213, 0, "2026-06-03", 5_000_000), // the ₪5M sale Over's Tax Authority copy lacks
          govRow(30079, 22, 7, "2026-09-17", 4_500_000),
        ],
      ),
      today: "2026-11-18",
      gapBlocks: NO_GAPS,
    });
    await importTaxExport(db, exportOf("2026-05-18", "2026-11-18", [
      ["030079-0110-011-00", "2026-05-30", 4_200_000, 1, 63, 3],
      ["030079-0213-021-00", "2026-06-18", 6_333_600, 1, 121, 5],
      ["030077-0154-027-00", "2026-06-01", 3_180_000, 1, 65, 2.5],
      ...Array.from({ length: 8 }, () => ["030079-0199-063-00", "2026-06-21", 533_333, 0.111, 90, 3] as ExportRow),
      ["030079-0213-000-00", "2026-06-03", 5_000_000, 1, 98, 4],
      ["030079-0105-020-00", "2026-07-15", 3_424_000, 1, 63, 2],
      ["030079-0105-021-00", "2026-10-01", 3_500_000, 1, 63, 2],
    ]), undefined);
    const c = compareWithOver(db, req.id)!;
    expect(c.matched).toBe(5); // 110, 213/21, 154, the first heirs row, and the ₪5M sale (via GovMap)
    expect(c.missingTaxCopy.map((x) => x.parcel)).toEqual(["30079/213"]);
    expect(c.missing.map((x) => x.date)).toEqual(["2026-07-15"]);
    expect(c.merged).toEqual([expect.objectContaining({ parcel: "30079/199/63", copies: 8 })]);
    expect(c.newer.map((x) => x.date)).toEqual(["2026-10-01"]);
  });
});
