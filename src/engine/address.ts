/**
 * Address normalisation for matching adverts to registry deals. Yad2, Madlan and the Tax
 * Authority spell the same street differently ("שד' רוטשילד", "שדרות רוטשילד", "רוטשילד").
 */
const PREFIXES = [
  "רחוב", "רח'", "רח׳", "שדרות", "שדרת", "שד'", "שד׳", "שד", "דרך", "סמטת", "סמ'", "סמ׳",
  "כיכר", "ככר", "שכונת", "שכ'", "street", "st.", "st", "blvd", "ave",
];

export function normaliseStreet(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/["'׳״`]/g, (c) => (c === "״" || c === '"' ? "" : "'"))
    .replace(/[-\u05BE\u2010-\u2015\u2212_.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // strip leading type words (possibly repeated)
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of PREFIXES) {
      if (s.startsWith(p + " ")) {
        s = s.slice(p.length + 1).trim();
        changed = true;
      }
    }
  }
  return s.replace(/'/g, "").replace(/\s+/g, "");
}

export function normaliseCity(raw: string): string {
  return raw
    .replace(/["'׳״]/g, "")
    .replace(/[-\u05BE\u2010-\u2015\u2212]/g, " ") // hyphen, Hebrew maqaf, dashes, minus
    .replace(/\s+/g, " ")
    .replace(/^ת\s?א\s?יפו$|^תל אביב$/, "תל אביב יפו")
    .trim();
}

/** "12א" → { n: 12, suffix: "א" }; "" → null. */
export function parseHouseNumber(raw: string | undefined): { n: number; suffix: string } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)\s*([א-תa-z]?)/i);
  return m ? { n: Number(m[1]), suffix: (m[2] ?? "").toLowerCase() } : null;
}
