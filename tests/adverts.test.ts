import { describe, expect, test } from "bun:test";
import { isFlatTopThree, parseCardText, parseHocr, parsePgm, type Gray } from "../server/connectors/advertPdf";
import { caseListings, importAdvertPrint, listCaseAdverts, usability } from "../server/caseAdverts";
import { openDb } from "../server/db";

/** Draw filled rectangles on a white image. */
function glyph(rects: [number, number, number, number][], w = 40, h = 60): Gray {
  const px = new Uint8Array(w * h).fill(255);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[y * w + x] = 0;
  return { w, h, px };
}

describe("printed advert reader", () => {
  test("Madlan card text: rooms, floor, area, type, street, neighbourhood, tags", () => {
    const c = parseCardText(`4 חד' קומה 3 95 מ"ר\nדירה, פרץ חיות 7, לב תל אביב\nבבלעדיות`, "madlan");
    expect(c).toMatchObject({ rooms: 4, floor: 3, area: 95, propertyType: "דירה", street: "פרץ חיות", number: "7", neighbourhood: "לב תל אביב", exclusive: true });
    expect(parseCardText(`3 חד' קומת קרקע 84 מ"ר\nדירת גן, נחלת בנימין 39, נחלת בנימין`).floor).toBe(0);
    expect(parseCardText(`423 מ"ר\nבניין, העצמון 1, נחלת בנימין`).excluded).toBe("בניין");
    expect(parseCardText(`4 חד קומה1 90 מ"ר\nדורה, בית אל 2, נוה שרת`).propertyType).toBe("דירה");
  });

  test("Yad2 card text: street line first, then type / neighbourhood / city, features", () => {
    const c = parseCardText(`בית אל 13 0\nדירה, נווה שרת, תל אביב יפו\n5 חדרים • קומה 3 • 126 מ"ר\nממ"ד חניה 3 כיווני אוויר`, "yad2");
    expect(c).toMatchObject({ street: "בית אל", number: "13", neighbourhood: "נווה שרת", rooms: 5, floor: 3, area: 126, parking: true, safeRoom: true });
    const p = parseCardText(`בלעדי שיינקין\nגג/ פנטהאוז, לב תל אביב, תל אביב יפו\n2 חדרים • קומה 2 • 72 מ"ר\nחדש מקבלן`, "yad2");
    expect(p).toMatchObject({ street: "שיינקין", propertyType: "פנטהאוז", newFromDeveloper: true, exclusive: true });
  });

  test("flat-top 3 vs 5: a 5 has a stroke on the upper left", () => {
    const five = glyph([[2, 2, 38, 8], [2, 2, 10, 30], [2, 26, 38, 32], [30, 26, 38, 56], [2, 50, 38, 56]]);
    const three = glyph([[2, 2, 38, 8], [24, 8, 32, 26], [8, 25, 34, 31], [30, 26, 38, 56], [2, 50, 38, 56]]);
    expect(isFlatTopThree(five, [0, 0, 40, 60])).toBe(false);
    expect(isFlatTopThree(three, [0, 0, 40, 60])).toBe(true);
  });

  test("PGM header and hOCR words with per-character fixes", () => {
    const img = parsePgm(new Uint8Array([...new TextEncoder().encode("P5\n# c\n2 1\n255\n"), 0, 255]));
    expect(img).toMatchObject({ w: 2, h: 1 });
    expect([...img.px]).toEqual([0, 255]);
    const three = glyph([[2, 2, 38, 8], [24, 8, 32, 26], [8, 25, 34, 31], [30, 26, 38, 56], [2, 50, 38, 56]]);
    const hocr = `<span class='ocr_line' id='line_1' title="bbox 0 0 200 60">
      <span class='ocrx_word' id='w1' title='bbox 0 0 40 60; x_wconf 90'><span class='ocrx_cinfo' title='x_bboxes 0 0 40 60; x_conf 90'>5</span></span>
      <span class='ocrx_word' id='w2' title='bbox 60 0 140 60; x_wconf 90'><span class='ocrx_cinfo' title='x_bboxes 60 0 80 60; x_conf 90'>מ</span><span class='ocrx_cinfo' title='x_bboxes 80 0 90 60; x_conf 90'>&quot;</span><span class='ocrx_cinfo' title='x_bboxes 90 0 110 60; x_conf 90'>ר</span></span>`;
    const words = parseHocr(hocr, 1, three);
    expect(words.map((w) => w.text)).toEqual(["3", 'מ"ר']);
  });
});

describe("case adverts", () => {
  const card = (o: object) => ({ page: 1, price: 3_000_000, rooms: 4, floor: 2, area: 95, propertyType: "דירה", street: "הרצל", number: "10", exclusive: false, brokered: false, raw: "", ...o });

  test("usable cards are placed on the map and become listings for that case only", async () => {
    const db = openDb(":memory:");
    const read = async () => ({
      source: "madlan" as const, city: "תל אביב יפו", printedAt: "2026-11-03", pages: 1,
      cards: [
        card({ previousPrice: 3_300_000 }),
        card({ street: "בניין", excluded: "בניין" }),
        card({ number: "12", rooms: undefined }),
        card({ number: "14", area: 10, check: "price per sqm 300,000 looks wrong" }),
      ],
    });
    const geo = async () => [{ lat: 32.08, lng: 34.78 }];
    const out = await importAdvertPrint(db, "case-0123456789abcdef", "doc1", "/x.pdf", undefined, geo, read);
    expect(out.adverts.map((a) => a.used)).toEqual([true, false, false, false]);
    expect(out.adverts[2]!.reason).toBe("rooms not read");
    const ls = caseListings(db, "case-0123456789abcdef", "תל אביב יפו");
    expect(ls).toHaveLength(1);
    expect(ls[0]!.priceHistory.map((p) => p.price)).toEqual([3_300_000, 3_000_000]);
    expect(caseListings(db, "another-case-0000000", "x")).toHaveLength(0);
    // Uploading the same print again does not duplicate.
    await importAdvertPrint(db, "case-0123456789abcdef", "doc2", "/x.pdf", undefined, geo, read);
    expect(listCaseAdverts(db, "case-0123456789abcdef")).toHaveLength(4);
  });

  test("usability reasons", () => {
    expect(usability(card({}))).toBeUndefined();
    expect(usability(card({ street: undefined }))).toBe("address not read");
  });
});
