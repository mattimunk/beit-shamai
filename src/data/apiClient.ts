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

export async function valuateRemote(subject: Subject, facts: ValuationFacts = {}, date?: string): Promise<ValuationResult> {
  const r = await fetch("/api/valuate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject, facts, date }),
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
