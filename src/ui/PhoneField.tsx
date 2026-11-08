import { useEffect, useState } from "react";
import { useT } from "./context";

/** Country calling codes most relevant to buyers and sellers in Israel; Israel first. */
const COUNTRIES: { code: string; flag: string; he: string; en: string }[] = [
  { code: "972", flag: "🇮🇱", he: "ישראל", en: "Israel" },
  { code: "1", flag: "🇺🇸", he: "ארה״ב / קנדה", en: "USA / Canada" },
  { code: "44", flag: "🇬🇧", he: "בריטניה", en: "United Kingdom" },
  { code: "33", flag: "🇫🇷", he: "צרפת", en: "France" },
  { code: "7", flag: "🇷🇺", he: "רוסיה", en: "Russia" },
  { code: "380", flag: "🇺🇦", he: "אוקראינה", en: "Ukraine" },
  { code: "49", flag: "🇩🇪", he: "גרמניה", en: "Germany" },
  { code: "32", flag: "🇧🇪", he: "בלגיה", en: "Belgium" },
  { code: "31", flag: "🇳🇱", he: "הולנד", en: "Netherlands" },
  { code: "41", flag: "🇨🇭", he: "שווייץ", en: "Switzerland" },
  { code: "39", flag: "🇮🇹", he: "איטליה", en: "Italy" },
  { code: "34", flag: "🇪🇸", he: "ספרד", en: "Spain" },
  { code: "54", flag: "🇦🇷", he: "ארגנטינה", en: "Argentina" },
  { code: "55", flag: "🇧🇷", he: "ברזיל", en: "Brazil" },
  { code: "52", flag: "🇲🇽", he: "מקסיקו", en: "Mexico" },
  { code: "27", flag: "🇿🇦", he: "דרום אפריקה", en: "South Africa" },
  { code: "61", flag: "🇦🇺", he: "אוסטרליה", en: "Australia" },
  { code: "971", flag: "🇦🇪", he: "איחוד האמירויות", en: "UAE" },
];

/** Split a stored number ("+972501234567") into country code and national number. */
export function splitPhone(v: string | undefined): { code: string; number: string } {
  const s = (v ?? "").replace(/[^\d+]/g, "");
  if (s.startsWith("+")) {
    const digits = s.slice(1);
    const hit = [...COUNTRIES].sort((a, b) => b.code.length - a.code.length).find((c) => digits.startsWith(c.code));
    if (hit) return { code: hit.code, number: digits.slice(hit.code.length) };
  }
  return { code: "972", number: s.replace(/^\+/, "") };
}

/** Join code and number into international format, dropping the national leading 0. */
export function joinPhone(code: string, number: string): string {
  const n = number.replace(/\D/g, "").replace(/^0+/, "");
  return n ? `+${code}${n}` : "";
}

/** Rough check: Israeli numbers have 8–9 digits after the code (mobiles 9), others 6–14. */
export function phoneLooksValid(code: string, number: string): boolean {
  const n = number.replace(/\D/g, "").replace(/^0+/, "");
  if (!n) return true; // optional
  return code === "972" ? /^\d{8,9}$/.test(n) : /^\d{6,14}$/.test(n);
}

export function PhoneField({ value, onChange, label }: { value?: string; onChange: (v: string) => void; label: string }) {
  const { t, lang } = useT();
  const init = splitPhone(value);
  const [code, setCode] = useState(init.code);
  const [number, setNumber] = useState(init.number ? (init.code === "972" ? `0${init.number}` : init.number) : "");
  useEffect(() => { onChange(joinPhone(code, number)); }, [code, number]);
  const valid = phoneLooksValid(code, number);
  return (
    <div className="field">
      <span>{label}</span>
      <div className="phone-row" dir="ltr">
        <select value={code} onChange={(e) => setCode(e.target.value)} aria-label={t.account.countryCode}>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>{`${c.flag} +${c.code} ${lang === "he" ? c.he : c.en}`}</option>
          ))}
        </select>
        <input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="tel" autoComplete="tel-national"
          placeholder={code === "972" ? "050-1234567" : ""} aria-invalid={!valid} />
      </div>
      {!valid && <span className="small warn-text">{t.account.phoneInvalid}</span>}
    </div>
  );
}
