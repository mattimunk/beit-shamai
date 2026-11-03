/**
 * Reader for Madlan / Yad2 search-result pages saved with "print to PDF".
 *
 * Printed pages often carry no usable text layer (Windows print drivers turn the web fonts
 * into Type 3 glyphs with no character map), so every page is rendered and read with OCR:
 *   1. a Hebrew+English pass for the card text (rooms, floor, area, type, address), and
 *   2. a digits-only pass for prices, which the Hebrew model misreads in the bold price font.
 * Prices and text lines are paired by position. Madlan prints the price at the top of a card
 * with the details below it; Yad2 prints the street first and the price at the bottom, so the
 * card is the lines above it. Cards without a price, and new-project "starting from" prices,
 * are ignored.
 *
 * Needs `pdftoppm` (poppler-utils) and `tesseract` with the `heb` model on the server.
 * Use: per case only – the adverts the client printed for this property. Not a shared database.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AdvertCard {
  page: number;
  price: number;
  /** Earlier price shown struck through next to the current one (a price drop). */
  previousPrice?: number;
  rooms?: number;
  floor?: number;
  floorsInBuilding?: number;
  area?: number;
  propertyType?: string;
  street?: string;
  number?: string;
  neighbourhood?: string;
  exclusive: boolean;
  brokered: boolean;
  /** Features listed on the card (Yad2 shows them as tags). */
  parking?: boolean;
  elevator?: boolean;
  safeRoom?: boolean;
  renovated?: boolean;
  newFromDeveloper?: boolean;
  /** Not a single home (whole building, plot, shop…) – kept for the record, not used. */
  excluded?: string;
  /** Something looks off (e.g. implausible price per sqm) – shown for manual review. */
  check?: string;
  /** OCR text of the card, kept for review. */
  raw: string;
}

export interface AdvertPrint {
  source: "madlan" | "yad2" | "unknown";
  city?: string;
  printedAt?: string; // ISO date from the browser's print header
  totalResults?: number;
  pages: number;
  cards: AdvertCard[];
}

interface Word { page: number; line: string; left: number; top: number; width: number; height: number; conf: number; text: string }

function parseTsv(tsv: string, page: number): Word[] {
  const out: Word[] = [];
  for (const row of tsv.split("\n").slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5" || !c[11]!.trim()) continue;
    out.push({
      page, line: `${c[2]}-${c[3]}-${c[4]}`, left: +c[6]!, top: +c[7]!, width: +c[8]!, height: +c[9]!, conf: +c[10]!, text: c[11]!.trim(),
    });
  }
  return out;
}

interface Line { top: number; bottom: number; left: number; right: number; text: string }

/** A grey page image (PGM from pdftoppm -gray): one byte per pixel, 0 = black. */
export interface Gray { w: number; h: number; px: Uint8Array }

export function parsePgm(buf: Uint8Array): Gray {
  // Header: "P5" w h maxval, separated by whitespace, then one byte per pixel.
  let pos = 0;
  const fields: string[] = [];
  while (fields.length < 4) {
    while (/\s/.test(String.fromCharCode(buf[pos]!))) pos++;
    if (buf[pos] === 35) { while (buf[pos] !== 10) pos++; continue; } // comment
    let tok = "";
    while (!/\s/.test(String.fromCharCode(buf[pos]!))) tok += String.fromCharCode(buf[pos++]!);
    fields.push(tok);
  }
  pos++;
  if (fields[0] !== "P5") throw new Error("not a binary PGM");
  return { w: +fields[1]!, h: +fields[2]!, px: buf.subarray(pos) };
}

/** Share of dark pixels in a box. */
function ink(img: Gray, x0: number, y0: number, x1: number, y1: number): number {
  let dark = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) { n++; if (img.px[y * img.w + x]! < 128) dark++; }
  return n ? dark / n : 0;
}

/**
 * Some site fonts draw "3" with a flat top, which OCR reads as "5". A real 5 has a vertical
 * stroke on the upper left, between the top bar and the bowl; a flat-top 3 has nothing there.
 */
export function isFlatTopThree(img: Gray, b: [number, number, number, number]): boolean {
  const [x0, y0, x1, y1] = b;
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 8) return false;
  return ink(img, x0, Math.round(y0 + h * 0.22), Math.round(x0 + w * 0.3), Math.round(y0 + h * 0.4)) < 0.06;
}

const unescapeHtml = (t: string) => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Words from tesseract hOCR (with hocr_char_boxes=1), fixing flat-top 3s against the image. */
export function parseHocr(hocr: string, page: number, img?: Gray): Word[] {
  const out: Word[] = [];
  let line = "";
  const re = /<span class=['"](ocr_line|ocr_header|ocr_textfloat|ocr_caption|ocrx_word|ocrx_cinfo)['"][^>]*?title=['"]([^'"]*)['"][^>]*>([^<]*)/g;
  let word: Word | null = null;
  let chars: string[] = [];
  const flush = () => {
    if (word) { word.text = (chars.length ? chars.join("") : word.text).trim(); if (word.text) out.push(word); }
    word = null; chars = [];
  };
  for (const m of hocr.matchAll(re)) {
    const [, cls, title, text] = m;
    const bb = title!.match(/(?:bbox|x_bboxes) (\d+) (\d+) (\d+) (\d+)/);
    if (!bb) continue;
    const box = [+bb[1]!, +bb[2]!, +bb[3]!, +bb[4]!] as [number, number, number, number];
    if (cls!.startsWith("ocr_")) { flush(); line = `${page}-${box.join(",")}`; continue; }
    if (cls === "ocrx_word") {
      flush();
      const conf = title!.match(/x_wconf (\d+)/);
      word = { page, line, left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1], conf: conf ? +conf[1]! : 0, text: unescapeHtml(text ?? "") };
      continue;
    }
    let ch = unescapeHtml(text ?? "");
    if (ch === "5" && img && isFlatTopThree(img, box)) ch = "3";
    chars.push(ch);
  }
  flush();
  return out;
}

/** Join words into lines; Hebrew lines read right to left, so order words by x descending. */
function toLines(words: Word[]): Line[] {
  const by = new Map<string, Word[]>();
  for (const w of words) (by.get(w.line) ?? by.set(w.line, []).get(w.line)!).push(w);
  return [...by.values()]
    .map((ws) => {
      const heb = ws.some((w) => /[֐-׿]/.test(w.text));
      ws.sort((a, b) => (heb ? b.left - a.left : a.left - b.left));
      return {
        top: Math.min(...ws.map((w) => w.top)),
        bottom: Math.max(...ws.map((w) => w.top + w.height)),
        left: Math.min(...ws.map((w) => w.left)),
        right: Math.max(...ws.map((w) => w.left + w.width)),
        text: ws.map((w) => w.text).join(" "),
      };
    })
    .sort((a, b) => a.top - b.top);
}

/**
 * Crop the price row at double resolution, erase horizontal strike-through lines, and read
 * the digits again. Returns the rightmost number as the current price and, when there is one,
 * the number before it as the earlier (crossed-out) price.
 */
async function rereadPriceRow(pdf: string, page: number, w: Word, dpi: number) {
  const dir = mkdtempSync(join(tmpdir(), "price-"));
  try {
    const k = 2; // re-render at twice the page resolution
    const padY = Math.round(w.height * 0.35);
    const x0 = Math.max(0, Math.round((w.left - w.width * 1.3) * k));
    const x1 = Math.round((w.left + w.width + 10) * k);
    const y0 = Math.max(0, Math.round((w.top - padY) * k));
    const h = Math.round((w.height + 2 * padY) * k);
    const base = join(dir, "c");
    await run(["pdftoppm", "-r", String(dpi * k), "-f", String(page), "-l", String(page), "-x", String(x0), "-y", String(y0), "-W", String(x1 - x0), "-H", String(h), "-gray", "-png", "-singlefile", pdf, base]);
    const img = `${base}.png`, neg = join(dir, "n.png"), line = join(dir, "l.png"), clean = join(dir, "x.png");
    await run(["convert", img, "-threshold", "60%", "-negate", neg]);
    await run(["convert", neg, "-morphology", "Open", "rectangle:150x1", line]);
    await run(["convert", neg, line, "-compose", "minus_src", "-composite", "-morphology", "Close", "rectangle:1x9", "-negate", clean]);
    const text = await run(["tesseract", clean, "stdout", "-l", "eng", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789, "]);
    const nums = [...text.matchAll(/\d{1,3}(?:,\d{3}){1,2}/g)].map((m) => Number(m[0].replace(/,/g, ""))).filter((v) => v >= 300_000);
    if (!nums.length) return null;
    const current = nums.at(-1)!;
    const before = nums.length > 1 ? nums.at(-2)! : undefined;
    const previous = before && before > current && before < current * 2 ? before : undefined;
    return { current, previous };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(0, 200)}`);
  return out;
}

const HEB_TYPES = /^(דירת גן|דירת גג|דירה|פנטהאוז|פנטהאוס|דופלקס|טריפלקס|גג\/פנטהאוז|קוטג'|בית פרטי|דו משפחתי|סטודיו|יחידת דיור|מיני פנטהאוז|לופט|בניין|מגרש|חנות|משרד|מחסן|חניה)/;
const NOT_A_HOME = /^(בניין|מגרש|חנות|משרד|מחסן|חניה)/;
/** Common OCR slips in the type word. */
const TYPE_FIX: [RegExp, string][] = [[/^דורה$/, "דירה"], [/^דירר?ה$/, "דירה"], [/^דירת גו$/, "דירת גן"]];
/** Drop Latin junk and bidi marks that OCR leaves inside Hebrew text. */
const cleanHeb = (s: string) => s.replace(/[\u200e\u200f]/g, "").replace(/\b[A-Za-z]{1,4}\b/g, "").replace(/\s{2,}/g, " ").trim();

/** Parse the text of one card (everything under its price). */
export function parseCardText(text: string, source: AdvertPrint["source"] = "madlan"): Omit<AdvertCard, "page" | "price" | "raw"> {
  const t = text.replace(/[״"]/g, '"').replace(/[׳']/g, "'");
  const card: Omit<AdvertCard, "page" | "price" | "raw"> = { exclusive: /בבלעדיות|בלעדי/.test(t), brokered: /תיווך|נכסים|נדל"?ן|real estate|realty|re\/max|רימקס|אנגלו סכסון/i.test(t) };
  if (/חניה|חנייה/.test(t)) card.parking = true;
  if (/מעלית/.test(t)) card.elevator = true;
  if (/ממ"ד|ממד/.test(t)) card.safeRoom = true;
  if (/משופצ?ת?|משופץ/.test(t)) card.renovated = true;
  if (/חדש מקבלן/.test(t)) card.newFromDeveloper = true;
  const rooms = t.match(/(\d+(?:\.5)?)\s*חד/);
  if (rooms && Number(rooms[1]) > 0 && Number(rooms[1]) <= 12) card.rooms = Number(rooms[1]);
  if (/קומת\s*קרקע|קומה\s*קרקע/.test(t)) card.floor = 0;
  else {
    const fl = t.match(/קומה\s*(-?\d+)(?:\s*מתוך\s*(\d+))?/);
    if (fl) { card.floor = Number(fl[1]); if (fl[2]) card.floorsInBuilding = Number(fl[2]); }
  }
  const area = t.match(/(\d{2,4})\s*מ"ר/) ?? t.match(/(\d{2,4})\s*מ"?ר/);
  if (area) card.area = Number(area[1]);
  const lines = t.split("\n");
  // Madlan: "<type>, <street> <number>, <neighbourhood>".
  // Yad2:   "<street> <number>" on its own line, then "<type>, <neighbourhood>, <city>".
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (/מ"ר|קומה|קומת/.test(line)) continue; // the spec line, not the address
    const parts = cleanHeb(line).split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    let type = parts[0]!;
    for (const [re, to] of TYPE_FIX) type = type.replace(re, to);
    const known = type.match(HEB_TYPES);
    // Accept an unknown short first part (OCR-damaged type word) when a street follows.
    if (!known && (type.split(" ").length > 2 || !/[א-ת]/.test(type))) continue;
    card.propertyType = known ? known[1] : type;
    if (/^גג\s*\/\s*פנטהאוז/.test(type)) card.propertyType = "פנטהאוז";
    if (NOT_A_HOME.test(card.propertyType!)) card.excluded = card.propertyType;
    if (source === "yad2") {
      // The street is the line above; the last part is the city.
      // Title line, without the "save" heart (read as 0 / ()) and the "exclusive" badge.
      let title = li > 0 ? cleanHeb(lines[li - 1]!) : "";
      title = title.replace(/(^|\s)(0|\(\)|\(|\)|O|o|©|♡)(?=\s|$)/g, " ").replace(/^\s*בלעדי\s+/, "").replace(/\s{2,}/g, " ").trim();
      if (HEB_TYPES.test(title) || /חדרים|מ"ר/.test(title)) title = "";
      const m = title.match(/^(.*?[א-ת"'].*?)\s+(\d+[א-ת]?)$/);
      if (m) { card.street = m[1]; card.number = m[2]; } else if (/[א-ת]/.test(title) && title.split(" ").length <= 4) card.street = title;
      if (parts.length >= 3) card.neighbourhood = parts.slice(1, -1).join(", ").replace(/\s*-\s*/g, " ");
      break;
    }
    const m = parts[1]!.match(/^(.*?)\s+(\d+[א-ת]?)$/);
    if (m) { card.street = m[1]; card.number = m[2]; } else card.street = parts[1];
    if (parts[2]) card.neighbourhood = parts.slice(2).join(", ");
    break;
  }
  return card;
}

function detectSource(lines: Line[]): AdvertPrint["source"] {
  const all = lines.map((l) => l.text).join(" ");
  if (/yad2|יד ?2/i.test(all)) return "yad2";
  if (/madlan|מדלן/i.test(all)) return "madlan";
  return "unknown";
}

export async function readAdvertPdf(pdfPath: string, opts: { dpi?: number; maxPages?: number } = {}): Promise<AdvertPrint> {
  const dir = mkdtempSync(join(tmpdir(), "advert-"));
  try {
    await run(["pdftoppm", "-r", String(opts.dpi ?? 300), "-l", String(opts.maxPages ?? 40), "-gray", pdfPath, join(dir, "p")]);
    const files = readdirSync(dir).filter((f) => f.endsWith(".pgm")).sort();
    const result: AdvertPrint = { source: "unknown", pages: files.length, cards: [] };
    for (let i = 0; i < files.length; i++) {
      const img = join(dir, files[i]!);
      const [textHocr, digitTsv, pgm] = await Promise.all([
        run(["tesseract", img, "stdout", "-l", "heb+eng", "--psm", "4", "-c", "hocr_char_boxes=1", "hocr"]),
        run(["tesseract", img, "stdout", "-l", "eng", "--psm", "11", "-c", "tessedit_char_whitelist=0123456789,", "tsv"]),
        Bun.file(img).bytes(),
      ]);
      const lines = toLines(parseHocr(textHocr, i + 1, parsePgm(pgm)));
      const pageH = Math.max(...lines.map((l) => l.bottom), 1);
      if (i === 0) {
        result.source = detectSource(lines);
        const head = lines.slice(0, 12).map((l) => l.text).join("\n");
        const d = head.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); // browser header, US order m/d/yy
        if (d) {
          const y = d[3]!.length === 2 ? 2000 + Number(d[3]) : Number(d[3]);
          result.printedAt = `${y}-${d[1]!.padStart(2, "0")}-${d[2]!.padStart(2, "0")}`;
        }
        const city = head.match(/למכירה ב([א-ת][א-ת\s-]+?)(?:\s*-|\n|$)/);
        if (city) result.city = city[1]!.trim();
      }
      // Prices: big comma-grouped numbers outside the browser header/footer.
      const allDigits = parseTsv(digitTsv, i + 1);
      // A token ending in a well-formed price; anything before it (a crossed-out old price,
      // the ₪ sign read as digits) marks it as merged, to be re-read on its own.
      const digits = allDigits
        .map((w) => ({ w, m: w.text.match(/(\d{1,3}(?:,\d{3}){1,2})$/) }))
        .filter((x) => x.m && /,\d{3}$/.test(x.w.text))
        .map(({ w, m }) => {
          const tail = m![1]!;
          const merged = tail !== w.text || w.width / (w.text.length * w.height) > 0.95;
          return { ...w, value: Number((merged && tail.length > 9 ? tail.slice(-9) : tail).replace(/,/g, "")), merged };
        })
        .filter((w) => w.value >= 300_000 && w.value <= 200_000_000 && w.top > pageH * 0.04 && w.top < pageH * 0.96);
      if (i === 0) {
        const tl = lines.find((l) => /תוצאות/.test(l.text));
        const total = tl && allDigits.find((w) => /^\d{1,3}(,\d{3})?$/.test(w.text) && Math.abs(w.top - tl.top) < 40);
        if (total) result.totalResults = Number(total.text.replace(/,/g, ""));
      }
      // Prices are printed larger than any other number on the card.
      const priceH = Math.max(0, ...digits.filter((d) => !d.merged).map((d) => d.height));
      for (let k = digits.length - 1; k >= 0; k--) if (digits[k]!.height < priceH * 0.8) digits.splice(k, 1);
      digits.sort((a, b) => a.top - b.top);
      // One price per card row: keep the tallest glyphs (the old price is smaller).
      const rows = digits.filter((d, k) => !digits.some((o, j) => j !== k && Math.abs(o.top - d.top) < 25 && (o.height > d.height || (o.height === d.height && j < k))));

      // A card cut by the page break: its details sit at the top of this page.
      const prev = result.cards.at(-1);
      if (result.source !== "yad2" && prev && prev.page === i && prev.area === undefined) {
        const firstTop = rows[0]?.top ?? pageH;
        const carry = lines.filter((l) => l.top > pageH * 0.115 && l.top < Math.min(firstTop, pageH * 0.3));
        if (carry.length) {
          const raw = [prev.raw, ...carry.map((l) => l.text)].join("\n");
          Object.assign(prev, parseCardText(raw, result.source), { raw });
        }
      }

      for (let k = 0; k < rows.length; k++) {
        const p = rows[k]!;
        // New-project promotions show "starting from" prices ("החל מ-…") – not a listing.
        const sameLine = lines.find((l) => Math.abs(l.top - p.top) < p.height && l.right >= p.left - 50 && l.left <= p.left + p.width + 50);
        if (sameLine && /החל|דירות\s*\d/.test(sameLine.text)) continue;
        // Re-read the price row on its own, at double resolution with strike-through lines
        // removed: separates a crossed-out old price from the current one and fixes the
        // shekel sign being read as a digit.
        const reread = await rereadPriceRow(pdfPath, i + 1, p, opts.dpi ?? 300).catch(() => null);
        // An unusually wide token means two prices (or the ₪ sign) were read as one number:
        // trust the re-read then; otherwise keep the first reading.
        const current = p.merged && reread ? reread.current : p.value;
        let body: Line[];
        if (result.source === "yad2") {
          const start = Math.max(k > 0 ? rows[k - 1]!.top + rows[k - 1]!.height : 0, p.top - pageH * 0.16, pageH * 0.04);
          body = lines.filter((l) => l.top > start && l.top <= p.top + p.height * 0.5);
        } else {
          const end = rows[k + 1]?.top ?? p.top + pageH * 0.2;
          body = lines.filter((l) => l.top > p.top + p.height * 0.5 && l.top < Math.min(end, p.top + pageH * 0.2));
        }
        const raw = body.map((l) => l.text).join("\n");
        const card: AdvertCard = { page: i + 1, price: current, ...parseCardText(raw, result.source), raw };
        if (reread?.previous) card.previousPrice = reread.previous;
        result.cards.push(card);
      }
    }
    for (const c of result.cards) {
      if (c.area) {
        const pps = c.price / c.area;
        if (pps > 250_000 || pps < 5_000) c.check = `price per sqm ${Math.round(pps).toLocaleString("en")} looks wrong`;
      }
      if (!c.area || !c.street) c.check ??= "details not fully read";
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
