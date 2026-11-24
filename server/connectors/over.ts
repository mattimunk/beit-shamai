/**
 * Client for over.org.il ("גרסאות לעם") public REST API.
 *
 * Over mirrors two registers of completed sales:
 *   /api/deals/search          the Tax Authority register (block/parcel, share sold, year built)
 *   /api/deals/govmap/search   GovMap's deals layer (adds street, house number, floor, a point)
 *
 * The REST API needs no sign-in and no key, and Over allows any use, commercial included
 * (www.over.org.il/api, checked 24 Nov 2026). Over asks callers to avoid bursts of parallel
 * calls and to keep a local cache: calls here are sequential, spaced by OVER_GAP_MS, and the
 * callers cache per block.
 */
export const OVER_API = (process.env.OVER_API_URL ?? "https://www.over.org.il/api").replace(/\/$/, "");

export interface OverFetch {
  fetchImpl?: typeof fetch;
  proxy?: string;
}

export type OverParams = Record<string, string | number | boolean | null | undefined>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OverApi {
  private last = 0;
  readonly base: string;
  readonly gapMs: number;
  constructor(private o: OverFetch = {}, opts: { base?: string; gapMs?: number } = {}) {
    this.base = (opts.base ?? OVER_API).replace(/\/$/, "");
    this.gapMs = opts.gapMs ?? Number(process.env.OVER_GAP_MS ?? 250);
  }

  url(path: string, params: OverParams = {}): string {
    const u = new URL(this.base + (path.startsWith("/") ? path : "/" + path));
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    return u.toString();
  }

  /** GET a JSON answer. Retries twice on 429 / 5xx / network errors, honouring Retry-After. */
  async get<T>(path: string, params: OverParams = {}): Promise<T> {
    const url = this.url(path, params);
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      let res: Response;
      try {
        const init: RequestInit & { proxy?: string } = { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) };
        if (this.o.proxy) init.proxy = this.o.proxy;
        res = await (this.o.fetchImpl ?? fetch)(url, init);
      } catch (e) {
        lastErr = `Over: ${(e as Error).message}`;
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      lastErr = `Over: HTTP ${res.status} for ${path}`;
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1500 * (attempt + 1));
        continue;
      }
      break;
    }
    throw new Error(lastErr);
  }
}
