import { describe, expect, test } from "bun:test";
import { lookupParcel } from "../server/connectors/overParcel";
import { getCase, saveCase } from "../server/cases";
import { openDb } from "../server/db";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";
import type { Subject } from "../src/engine/types";

/** Over's answer for Nahum Lipshitz 15, Jerusalem (26 Nov 2026), trimmed to the fields used. */
const ADDRESS_ANSWER = {
  query: { mode: "address", city: "ירושלים", street: "נחום ליפשיץ", number: "15" },
  data: [{
    parcel_key: "30002-0-34",
    identity: {
      gush: 30002, gush_suffix: 0, helka: 34, gp_key: "30002-34",
      point: { lat: 31.755433232155212, lon: 35.21629248959043 },
      addresses: [
        { street: "ליפשיץ נחום", house: 15, entrance: null, neighbourhood: "שכונת גאולים-בקעה", match: "pip", point_source: "address_register" },
        { street: "ליפשיץ נחום", house: 15, entrance: "ד", neighbourhood: null, match: "pip", point_source: "govmap" },
      ],
    },
    sources: {
      parcels: { fields: { legal_area: 3325.0, status: "מוסדר", locality: "ירושלים" } },
      gazetteer: { fields: { n_assets: 39, n_dwellings: 38, n_subparcels: 39, floors_max: 4, building_year_min: 1980, building_year_max: 1980 } },
    },
    match: { method: "gp_key", confidence: "exact", notes: [] },
  }],
  count: 1,
};

/** Over's answer for a point in Tel Aviv with radius 0 (26 Nov 2026). */
const POINT_ANSWER = {
  query: { mode: "point", lat: 32.0682, lon: 34.7847 },
  data: [{ parcel_key: "7104-0-289", identity: { gush: 7104, gush_suffix: 0, helka: 289, gp_key: "7104-289", distance_m: 0.0 }, match: { method: "gp_key", confidence: "exact", notes: [] } }],
  count: 1,
};

function fakeApi(answers: Record<string, unknown>, calls: { path: string; params: any }[] = []) {
  return { async get(path: string, params: any) { calls.push({ path, params }); if (!(path in answers)) throw new Error("HTTP 404"); return answers[path] as any; } };
}

describe("block and parcel from Over's property lookup", () => {
  test("by address (real answer): 30002/34, settled, building facts", async () => {
    const calls: any[] = [];
    const r = await lookupParcel(fakeApi({ "/nadlan/address": ADDRESS_ANSWER }, calls), { city: "ירושלים", street: "נחום ליפשיץ", number: "15", lat: 31.75, lng: 35.21 });
    expect(r).toEqual({
      block: "30002", parcel: "34", subBlock: undefined, method: "address", confidence: "exact", status: "מוסדר", legalArea: 3325,
      neighbourhood: "שכונת גאולים-בקעה", subParcels: 39, floorsMax: 4, buildingYear: 1980,
    });
    expect(calls).toEqual([{ path: "/nadlan/address", params: { city: "ירושלים", street: "נחום ליפשיץ", number: 15 } }]);
  });

  test("no address match: the parcel under the map point (real answer)", async () => {
    const calls: any[] = [];
    const r = await lookupParcel(fakeApi({ "/nadlan/address": { data: [] }, "/nadlan/lookup": POINT_ANSWER }, calls), { city: "תל אביב -יפו", street: "רחוב שאין", number: "8", lat: 32.0682, lng: 34.7847 });
    expect(r).toMatchObject({ block: "7104", parcel: "289", method: "point" });
    expect(calls[1]).toEqual({ path: "/nadlan/lookup", params: { lat: 32.0682, lon: 34.7847, radius_m: 0 } });
  });

  test("house number with a letter; several parcels → the one holding that house", async () => {
    const two = { data: [
      { identity: { gush: 1, helka: 1, addresses: [{ house: 13 }] } },
      { identity: { gush: 1, helka: 2, addresses: [{ house: 15 }] } },
    ] };
    const r = await lookupParcel(fakeApi({ "/nadlan/address": two }), { city: "X", street: "Y", number: "15א" });
    expect(r).toMatchObject({ block: "1", parcel: "2" });
  });

  test("Over unreachable and no point: nothing", async () => {
    expect(await lookupParcel(fakeApi({}), { city: "X", street: "Y", number: "1" })).toBeNull();
  });
});

describe("a looked-up block/parcel survives an older browser copy", () => {
  const subject = { ...DEMO_SUBJECT, parcel: undefined } as Subject;

  test("kept when the save has none; replaced by the owner's own", () => {
    const db = openDb(":memory:");
    saveCase(db, "case-parcel-0000001", subject);
    db.query(`UPDATE cases SET subject = ? WHERE id = ?`).run(JSON.stringify({ ...subject, parcel: { block: "30002", parcel: "34", source: "suggested" } }), "case-parcel-0000001");
    saveCase(db, "case-parcel-0000001", subject); // a browser that loaded the property before the lookup
    expect(getCase(db, "case-parcel-0000001")!.subject.parcel).toEqual({ block: "30002", parcel: "34", source: "suggested" });
    saveCase(db, "case-parcel-0000001", { ...subject, parcel: { block: "30002", parcel: "35", source: "owner" } });
    expect(getCase(db, "case-parcel-0000001")!.subject.parcel?.parcel).toBe("35");
  });
});
