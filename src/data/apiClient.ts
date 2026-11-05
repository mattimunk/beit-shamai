/** Browser client for the Beit Shamai server (used when the app is served by it). */
import type { Subject } from "../engine/types";
import type { ValuationFacts, ValuationResult } from "../engine/valuation";

export interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
  city?: string;
  street?: string;
  number?: string;
  attribution?: string;
}

/** True when the page is served by our server (health endpoint answers). */
export async function detectServer(): Promise<boolean> {
  if (!/^https?:$/.test(location.protocol)) return false;
  try {
    const r = await fetch("/health", { headers: { accept: "application/json" } });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.ok === true;
  } catch {
    return false;
  }
}

export async function searchAddress(q: string): Promise<GeocodeHit[]> {
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`geocode ${r.status}`);
  return r.json();
}

export async function valuateRemote(subject: Subject, facts: ValuationFacts = {}, date?: string, caseId?: string): Promise<ValuationResult> {
  const r = await fetch("/api/valuate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject, facts, date, caseId }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `valuate ${r.status}`);
  return j as ValuationResult;
}

/** Store an uploaded document on the server, in the property's case folder. */
export async function uploadDocument(caseId: string, file: File, kind: string): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);
  const r = await fetch(`/api/cases/${encodeURIComponent(caseId)}/documents`, { method: "POST", body: form });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `upload ${r.status}`);
  return j.id as string;
}

export interface PlanItemDto {
  id: string; city: string; kind: string; from: string; to: string; areaFrom: number; areaTo: number;
  status: "pending" | "done" | "covered" | "truncated" | "split"; note?: string; parentId?: string;
}
export interface RequestDto {
  id: string; createdAt: string; status: "preliminary" | "final"; finalAt?: string; subject: Subject; items: PlanItemDto[];
}

export async function createDataRequest(subject: Subject): Promise<RequestDto> {
  const r = await fetch("/api/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `request ${r.status}`);
  return j;
}

export async function getDataRequest(id: string): Promise<RequestDto> {
  const r = await fetch(`/api/requests/${encodeURIComponent(id)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `request ${r.status}`);
  return j;
}

export async function listDataRequests(token: string, all = false): Promise<RequestDto[]> {
  const r = await fetch(`/api/requests${all ? "?all=1" : ""}`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `requests ${r.status}`);
  return j;
}

export async function uploadTaxExport(token: string, requestId: string, itemId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/requests/${requestId}/items/${itemId}/upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `upload ${r.status}`);
  return j as { import: { stored: number; rows: number; partial: number; unlocated: number }; mismatch: string[]; item: PlanItemDto; request: RequestDto };
}

/** Plan item counts used for the preliminary / final label. */
export function requestProgress(r: RequestDto) {
  const live = r.items.filter((i) => i.status !== "truncated" && i.status !== "split");
  return { done: live.filter((i) => i.status !== "pending").length, total: live.length };
}

/** Upload a Madlan/Yad2 print-to-PDF for the case; the server reads the adverts on it. */
export async function uploadAdvertPrint(caseId: string, file: File, city: string) {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/cases/${encodeURIComponent(caseId)}/adverts?city=${encodeURIComponent(city)}`, { method: "POST", body: form });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `adverts ${r.status}`);
  return j as {
    print: { source: string; pages: number; city?: string; printedAt?: string };
    adverts: { card: { price: number; previousPrice?: number; rooms?: number; floor?: number; area?: number; street?: string; number?: string; neighbourhood?: string }; used: boolean; reason?: string }[];
  };
}

/** Upload a Tax Authority export without choosing a search; the server matches it to every open search. */
export async function uploadTaxExportAny(token: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch("/api/tax/import", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `upload ${r.status}`);
  return j as { stored: number; rows: number; partial: number; unlocated: number; truncated: boolean; totalReported?: number };
}

/** Suggested block/parcel for a point, from the national parcel layer on the server. */
export async function parcelAt(lat: number, lng: number): Promise<{ block: number; parcel: number; distanceM: number }[]> {
  const r = await fetch(`/api/parcel-at?lat=${lat}&lng=${lng}`);
  if (!r.ok) return [];
  return r.json();
}
