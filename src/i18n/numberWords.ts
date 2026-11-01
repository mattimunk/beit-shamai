/**
 * Amounts in words, as appraisal conclusions state them ("במילים: ...").
 * Hebrew uses masculine forms (שקלים חדשים). Supports up to 999,999,999.
 */
const ONES_M = ["", "אחד", "שניים", "שלושה", "ארבעה", "חמישה", "שישה", "שבעה", "שמונה", "תשעה"];
const ONES_CONSTRUCT = ["", "", "שני", "שלושת", "ארבעת", "חמשת", "ששת", "שבעת", "שמונת", "תשעת"];
const TEENS_M = ["עשרה", "אחד עשר", "שנים עשר", "שלושה עשר", "ארבעה עשר", "חמישה עשר", "שישה עשר", "שבעה עשר", "שמונה עשר", "תשעה עשר"];
const TENS = ["", "", "עשרים", "שלושים", "ארבעים", "חמישים", "שישים", "שבעים", "שמונים", "תשעים"];
const HUNDREDS = ["", "מאה", "מאתיים", "שלוש מאות", "ארבע מאות", "חמש מאות", "שש מאות", "שבע מאות", "שמונה מאות", "תשע מאות"];
const THOUSANDS: Record<number, string> = {
  1: "אלף", 2: "אלפיים", 3: "שלושת אלפים", 4: "ארבעת אלפים", 5: "חמשת אלפים", 6: "ששת אלפים",
  7: "שבעת אלפים", 8: "שמונת אלפים", 9: "תשעת אלפים", 10: "עשרת אלפים",
};

/** 0..999 in masculine Hebrew, with "ו" before the last word. */
function under1000(n: number): string[] {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(HUNDREDS[h]!);
  if (rest >= 10 && rest < 20) parts.push(TEENS_M[rest - 10]!);
  else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t) parts.push(TENS[t]!);
    if (o) parts.push(ONES_M[o]!);
  }
  return parts;
}

function joinWithVav(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  const last = parts[parts.length - 1]!;
  return [...parts.slice(0, -1), "ו" + last].join(" ");
}

export function hebrewNumber(n: number): string {
  n = Math.round(Math.abs(n));
  if (n === 0) return "אפס";
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  // Each group is joined internally with "ו" before its last word; groups are separated by
  // spaces, and a final one-word group takes "ו" ("ארבעה מיליון ואלף").
  const groups: string[] = [];
  if (millions) {
    if (millions === 1) groups.push("מיליון");
    else if (millions === 2) groups.push("שני מיליון");
    else groups.push(joinWithVav(under1000(millions)) + " מיליון");
  }
  if (thousands) {
    if (THOUSANDS[thousands]) groups.push(THOUSANDS[thousands]!);
    else groups.push(joinWithVav(under1000(thousands)) + " אלף");
  }
  if (rest) groups.push(joinWithVav(under1000(rest)));
  if (groups.length > 1 && !groups[groups.length - 1]!.includes(" ")) {
    groups[groups.length - 1] = "ו" + groups[groups.length - 1];
  }
  return groups.join(" ");
}

export function hebrewNis(n: number): string {
  return `${hebrewNumber(n)} שקלים חדשים`;
}

const EN_ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function en1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${EN_ONES[h]} hundred`);
  if (r) parts.push(r < 20 ? EN_ONES[r]! : `${EN_TENS[Math.floor(r / 10)]}${r % 10 ? "-" + EN_ONES[r % 10] : ""}`);
  return parts.join(" and ");
}
export function englishNis(n: number): string {
  n = Math.round(Math.abs(n));
  if (n === 0) return "zero new shekels";
  const m = Math.floor(n / 1_000_000);
  const t = Math.floor((n % 1_000_000) / 1000);
  const r = n % 1000;
  const parts: string[] = [];
  if (m) parts.push(`${en1000(m)} million`);
  if (t) parts.push(`${en1000(t)} thousand`);
  if (r) parts.push(en1000(r));
  return `${parts.join(" ")} new shekels`;
}
