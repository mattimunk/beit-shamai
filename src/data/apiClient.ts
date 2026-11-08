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
  id: string; createdAt: string; status: "preliminary" | "final"; finalAt?: string; subject: Subject; caseId?: string; items: PlanItemDto[];
}

export async function createDataRequest(subject: Subject, caseId?: string): Promise<RequestDto> {
  const r = await fetch("/api/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject, caseId }) });
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
  const r = await fetch(`/api/requests${all ? "?all=1" : ""}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `requests ${r.status}`);
  return j;
}

export async function uploadTaxExport(token: string, requestId: string, itemId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/requests/${requestId}/items/${itemId}/upload`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: form });
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
  const r = await fetch("/api/tax/import", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: form });
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

// ---- Visit capture -------------------------------------------------------------------------

export interface VisitLayout { bedrooms: number; bathrooms: number; toilets: number; balconies: number; garden: boolean; storage: boolean; parking: boolean }
export interface CaptureDto { shotId: string; media: "video" | "photo"; frames: string[]; duration?: number; at: string }

export async function getCapture(caseId: string): Promise<{ layout: VisitLayout | null; captures: CaptureDto[] }> {
  const r = await fetch(`/api/cases/${encodeURIComponent(caseId)}/capture`);
  if (!r.ok) return { layout: null, captures: [] };
  return r.json();
}

export async function saveVisitLayout(caseId: string, layout: VisitLayout) {
  await fetch(`/api/cases/${encodeURIComponent(caseId)}/capture`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout }) });
}

export const frameUrl = (caseId: string, name: string) => `/api/cases/${encodeURIComponent(caseId)}/frames/${encodeURIComponent(name)}`;

/** Upload one shot with progress (fetch has no upload progress, so XMLHttpRequest). */
export function uploadShot(caseId: string, shotId: string, file: File, onProgress: (share: number) => void): Promise<CaptureDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/cases/${encodeURIComponent(caseId)}/capture/${shotId}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let j: any = null;
      try { j = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && j) resolve(j);
      else reject(new Error(j?.error ?? `upload ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("network error – check the connection and try again"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

// ---- Property files --------------------------------------------------------------------------

export interface CaseSummaryDto { id: string; address: string; updatedAt: string; createdAt: string; shots: number }

export async function getCaseFile(id: string): Promise<{ id: string; subject: Subject; status?: string; request?: RequestDto | null } | null> {
  const r = await fetch(`/api/cases/${encodeURIComponent(id)}`);
  return r.ok ? r.json() : null;
}

export async function saveCaseFile(id: string, subject: Subject): Promise<void> {
  await fetch(`/api/cases/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject }) });
}

export async function listCaseFiles(ids: string[]): Promise<CaseSummaryDto[]> {
  if (!ids.length) return [];
  const r = await fetch(`/api/cases?ids=${ids.map(encodeURIComponent).join(",")}`);
  return r.ok ? r.json() : [];
}

/** The property files this browser has opened, newest first (kept in this browser). */
export function knownCases(): string[] {
  try { return JSON.parse(localStorage.getItem("bs-cases") ?? "[]"); } catch { return []; }
}
export function rememberCase(id: string) {
  try { localStorage.setItem("bs-cases", JSON.stringify([id, ...knownCases().filter((x) => x !== id)].slice(0, 200))); } catch { /* memory only */ }
}

/** Link that opens only the guided filming for one property (agent or buyer, on a phone). */
export const visitLink = (caseId: string) => `${location.origin}/?visit=${encodeURIComponent(caseId)}`;

// ---- Accounts ---------------------------------------------------------------------------------

export type UserRole = "buyer" | "seller" | "agent" | "appraiser" | "other";
export interface UserDto { id: string; email: string; name?: string; phone?: string; role?: UserRole; agency?: string; license?: string; marketingConsent: boolean }
export interface MeDto { user: UserDto; isAdmin: boolean }
export type CaseStatus = "draft" | "submitted" | "data" | "documents" | "review" | "done";
export interface PipelineCase extends CaseSummaryDto {
  status: CaseStatus; submittedAt?: string; statusAt?: string;
  owner?: { id: string; email: string; name?: string; role?: string };
  request?: { id: string; status: string; done: number; total: number };
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any)?.error ?? `HTTP ${r.status}`);
  return j as T;
}
const post = (url: string, body?: unknown, method = "POST") =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export const requestSignInCode = (email: string, lang: "he" | "en") => post("/api/auth/code", { email, lang }).then((r) => jsonOrThrow<{ emailed: boolean }>(r));
export const verifySignIn = (email: string, code: string) => post("/api/auth/verify", { email, code }).then((r) => jsonOrThrow<MeDto & { isNew: boolean }>(r));
export const signOut = () => post("/api/auth/logout");
export async function getMe(): Promise<MeDto | null> {
  const r = await fetch("/api/me");
  return r.ok ? r.json() : null;
}
export const saveProfile = (p: Partial<UserDto>) => post("/api/me", p, "PUT").then((r) => jsonOrThrow<MeDto>(r));
export const myCases = () => fetch("/api/my/cases").then((r) => jsonOrThrow<PipelineCase[]>(r));
export const submitCase = (id: string) => post(`/api/cases/${encodeURIComponent(id)}/submit`).then((r) => jsonOrThrow<{ case: { status: CaseStatus }; request: RequestDto | null }>(r));
export const adminCases = (status?: CaseStatus) => fetch(`/api/admin/cases${status ? `?status=${status}` : ""}`).then((r) => jsonOrThrow<PipelineCase[]>(r));
export const setCaseStatusAdmin = (id: string, status: CaseStatus) => post(`/api/admin/cases/${encodeURIComponent(id)}`, { status }, "PUT").then((r) => jsonOrThrow(r));
