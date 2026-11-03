/**
 * Adverts printed by the client for one property case (Madlan / Yad2 "print to PDF").
 *
 * The cards are read with OCR (connectors/advertPdf.ts), placed on the map by address, and
 * used as asking-price evidence for that case's valuation only. They are kept with the case
 * and never pooled into a shared listings database (that needs a licence from the sites).
 */
import type { Database } from "bun:sqlite";
import type { Listing } from "../src/engine/types";
import { readAdvertPdf, type AdvertCard, type AdvertPrint } from "./connectors/advertPdf";
import { geocode } from "./connectors/geocode";

export function ensureAdvertTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_adverts (
      id TEXT PRIMARY KEY, case_id TEXT, doc_id TEXT, source TEXT, printed_at TEXT, card TEXT,
      lat REAL, lng REAL, used INTEGER, reason TEXT, at TEXT
    );
    CREATE INDEX IF NOT EXISTS case_adverts_case ON case_adverts(case_id);
  `);
}

export interface CaseAdvert {
  id: string;
  docId: string;
  source: string;
  printedAt?: string;
  card: AdvertCard;
  location?: { lat: number; lng: number };
  used: boolean;
  /** Why the advert is not used in the valuation. */
  reason?: string;
}

type Geocoder = (q: string) => Promise<{ lat: number; lng: number }[]>;

/** Decide whether a card can be used, and why not. */
export function usability(c: AdvertCard): string | undefined {
  if (c.excluded) return `not a home (${c.excluded})`;
  if (c.check) return c.check;
  if (!c.rooms) return "rooms not read";
  if (!c.street) return "address not read";
  return undefined;
}

export async function importAdvertPrint(
  db: Database,
  caseId: string,
  docId: string,
  pdfPath: string,
  fallbackCity: string | undefined,
  geo: Geocoder = geocode,
  read: (p: string) => Promise<AdvertPrint> = readAdvertPdf,
): Promise<{ print: Omit<AdvertPrint, "cards">; adverts: CaseAdvert[] }> {
  ensureAdvertTables(db);
  const print = await read(pdfPath);
  const city = print.city ?? fallbackCity ?? "";
  const ins = db.prepare(
    `INSERT OR REPLACE INTO case_adverts (id, case_id, doc_id, source, printed_at, card, lat, lng, used, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const adverts: CaseAdvert[] = [];
  for (const card of print.cards) {
    let reason = usability(card);
    let loc: { lat: number; lng: number } | undefined;
    if (!reason) {
      const q = [card.street, card.number, card.neighbourhood && !card.number ? card.neighbourhood : "", city].filter(Boolean).join(" ");
      try { loc = (await geo(q))[0]; } catch { loc = undefined; }
      if (!loc) reason = "address not found on the map";
    }
    // Same advert printed twice (or in two files) is stored once.
    const id = `${caseId}:${print.source}:${card.street ?? ""}:${card.number ?? ""}:${card.area ?? ""}:${card.floor ?? ""}`;
    const a: CaseAdvert = { id, docId, source: print.source, printedAt: print.printedAt, card, location: loc, used: !reason, reason };
    ins.run(id, caseId, docId, print.source, print.printedAt ?? null, JSON.stringify(card), loc?.lat ?? null, loc?.lng ?? null, a.used ? 1 : 0, reason ?? null, new Date().toISOString());
    adverts.push(a);
  }
  const { cards: _cards, ...meta } = print;
  return { print: meta, adverts };
}

export function listCaseAdverts(db: Database, caseId: string): CaseAdvert[] {
  ensureAdvertTables(db);
  return (db.query(`SELECT * FROM case_adverts WHERE case_id = ? ORDER BY at`).all(caseId) as any[]).map((r) => ({
    id: r.id, docId: r.doc_id, source: r.source, printedAt: r.printed_at ?? undefined, card: JSON.parse(r.card),
    location: r.lat != null ? { lat: r.lat, lng: r.lng } : undefined, used: !!r.used, reason: r.reason ?? undefined,
  }));
}

/** The case's usable adverts as engine listings (asking-price evidence). */
export function caseListings(db: Database, caseId: string, city: string): Listing[] {
  return listCaseAdverts(db, caseId)
    .filter((a) => a.used && a.location)
    .map((a) => {
      const c = a.card;
      const seen = a.printedAt ?? new Date().toISOString().slice(0, 10);
      return {
        id: `case:${a.id}`,
        evidence: "asking_price" as const,
        source: `${a.source}_print`,
        sourceId: a.id,
        firstSeen: seen,
        lastSeen: seen,
        status: "active" as const,
        askingPrice: c.price,
        priceHistory: [...(c.previousPrice ? [{ date: seen, price: c.previousPrice }] : []), { date: seen, price: c.price }],
        location: a.location!,
        address: { city, street: c.street ?? "", number: c.number ?? "", neighborhood: c.neighbourhood },
        area: c.area!,
        rooms: c.rooms!,
        floor: c.floor,
        floorsInBuilding: c.floorsInBuilding,
      };
    });
}
