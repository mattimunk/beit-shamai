import { describe, expect, test } from "bun:test";
import { openDb } from "../server/db";
import { createRequest, getRequest, reconcileRequest, uploadToItem } from "../server/requests";
import { narrowOf } from "../server/taxImport";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";
import type { Subject } from "../src/engine/types";

const subject = {
  ...DEMO_SUBJECT,
  address: { ...DEMO_SUBJECT.address, city: "ירושלים", street: "נחום ליפשיץ", number: "15" },
  location: { lat: 31.7745, lng: 35.2146 },
  area: { mode: "declared", area: 120 },
} as Subject;

/** A Tax Authority export header for a search, optionally limited to a street or rooms; no rows. */
function emptyExport(from: string, to: string, aFrom: number, aTo: number, extra = "") {
  const d = (iso: string) => iso.split("-").reverse().join("/");
  const th = ["גוש חלקה", "יום מכירה", "תמורה מוצהרת בש&quot;ח", "שווי מכירה בש&quot;ח", "מהות", "חלק נמכר", "ישוב", "שנת בניה", "שטח", "חדרים"].map((h) => `<th>${h}</th>`).join("");
  return `<b>סוג נכס:</b> דירת מגורים&nbsp<b>מיום מכירה:</b> ${d(from)}&nbsp<b>עד יום מכירה:</b> ${d(to)}&nbsp<br><b>שטח מ:</b> ${aFrom}&nbsp<b>שטח עד:</b> ${aTo}&nbsp<br><b>ישוב: </b>ירושלים&nbsp${extra}<br/>קיימות 0 תוצאות<table><tr>${th}</tr></table>`;
}

describe("searches limited to a street, block or rooms", () => {
  test("recognised from the export's criteria", () => {
    expect(narrowOf({})).toBe("");
    expect(narrowOf({ street: "נחום ליפשיץ" })).toBe("street:נחום ליפשיץ");
    expect(narrowOf({ block: "30079", raw: { "חלקה": "213" } })).toBe("block:30079,parcel:213");
    expect(narrowOf({ roomsFrom: 3 })).toBe("rooms");
    expect(narrowOf({ street: " " })).toBe("");
  });

  test("a street search with 0 results doesn't close the city-wide search; a city search does", async () => {
    const db = openDb(":memory:");
    const req = createRequest(db, subject, "2026-11-25");
    const it = req.items.find((i) => i.status === "pending")!;
    const street = await uploadToItem(db, req.id, it.id, emptyExport(it.from, it.to, it.areaFrom, it.areaTo, "<b>רחוב:</b> נחום ליפשיץ&nbsp"), undefined);
    expect(street.item.status).toBe("pending");
    expect(street.item.note).toBe("narrow:street:נחום ליפשיץ");
    expect(street.mismatch.some((m) => m.startsWith("narrow"))).toBe(true);
    expect(getRequest(db, req.id)!.items.find((i) => i.id === it.id)!.status).toBe("pending");

    const city = await uploadToItem(db, req.id, it.id, emptyExport(it.from, it.to, it.areaFrom, it.areaTo), undefined);
    expect(city.item.status).toBe("done");
  });

  test("a search closed earlier by a street upload opens again", async () => {
    const db = openDb(":memory:");
    const req = createRequest(db, subject, "2026-11-25");
    const it = req.items.find((i) => i.status === "pending")!;
    await uploadToItem(db, req.id, it.id, emptyExport(it.from, it.to, it.areaFrom, it.areaTo, "<b>רחוב:</b> נחום ליפשיץ&nbsp"), undefined);
    // As it was before narrow searches were recognised: the street upload closed the search.
    const pull = db.query(`SELECT id FROM tax_pulls LIMIT 1`).get() as { id: string };
    db.query(`UPDATE plan_items SET status = 'done', pull_id = ?, note = NULL WHERE id = ?`).run(pull.id, it.id);
    reconcileRequest(db, req.id);
    const after = getRequest(db, req.id)!.items.find((i) => i.id === it.id)!;
    expect(after.status).toBe("pending");
    expect(after.note).toBe("narrow:street:נחום ליפשיץ");
  });
});
