import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { emptyDossier, flags, overallProgress, sectionProgress, toSubject, tourLayout, applicationNumber } from "../src/dossier/schema";
import { newSubject } from "../src/ui/newSubject";
import { captureLinkCase, newCaptureLink, revokeCaptureLinks, saveCase } from "../server/cases";
import { buildShotList, cleanLayout } from "../server/capture";

describe("dossier", () => {
  test("progress grows as questions are answered", () => {
    const d = emptyDossier();
    const before = sectionProgress(d, "setup").done;
    d.setup.purpose = "sale"; d.setup.submitter = "owner";
    expect(sectionProgress(d, "setup").done).toBeGreaterThan(before);
    expect(overallProgress(d, { done: 0, total: 9 })).toBeGreaterThan(0);
  });
  test("area difference is flagged, small differences are not", () => {
    const d = emptyDossier();
    d.size.interior = 100; d.size.registered = 90;
    expect(flags(d).map((f) => f.kind)).toContain("area_registered");
    d.size.registered = 98;
    expect(flags(d).map((f) => f.kind)).not.toContain("area_registered");
  });
  test("tour follows rooms and named extra rooms", () => {
    const d = emptyDossier();
    d.rooms.bedrooms = 3; d.rooms.custom = ["חדר עבודה", " "];
    const l = tourLayout(d);
    expect(l.bedrooms).toBe(3);
    expect(l.extra).toEqual(["חדר עבודה"]);
    expect(buildShotList(l).map((s) => s.id)).toContain("extra-1");
  });
  test("subject gets the address; 'don't know' never becomes a number", () => {
    const d = emptyDossier();
    d.location.city = "תל אביב"; d.location.street = "בן יהודה"; d.location.number = "10";
    d.size.interior = "unknown";
    const s = toSubject(d, newSubject());
    expect(s.address.street).toBe("בן יהודה");
    expect(JSON.stringify(s)).not.toContain("unknown");
  });
  test("application number format", () => {
    expect(applicationNumber(7, 2026)).toBe("BS-26-00007");
  });
});

describe("filming links", () => {
  test("a new link replaces the old one; links expire", () => {
    const db = new Database(":memory:");
    saveCase(db, "case-aaaaaaaaaaaaaaaa", newSubject());
    const a = newCaptureLink(db, "case-aaaaaaaaaaaaaaaa", 1000);
    expect(captureLinkCase(db, a.token, 2000)).toBe("case-aaaaaaaaaaaaaaaa");
    const b = newCaptureLink(db, "case-aaaaaaaaaaaaaaaa", 3000);
    expect(captureLinkCase(db, a.token, 4000)).toBeNull();
    expect(captureLinkCase(db, b.token, b.expiresAt + 1)).toBeNull();
    revokeCaptureLinks(db, "case-aaaaaaaaaaaaaaaa");
    expect(captureLinkCase(db, b.token, 4000)).toBeNull();
  });
  test("layouts are cleaned before storing", () => {
    const l = cleanLayout({ bedrooms: 99, bathrooms: -2, extra: ["x".repeat(100), 5 as any] } as any);
    expect(l.bedrooms).toBe(12);
    expect(l.bathrooms).toBe(0);
    expect(l.extra).toEqual(["x".repeat(40)]);
  });
});
