/**
 * Helpers for the government real-estate site (nadlan.gov.il) and the over.org.il mirror of the
 * Tax Authority deals register. Used by server/probeNadlan.ts to find out what this server can
 * reach. Nothing here is wired into valuations yet.
 *
 * What is known (Nov 2026, from public projects that use the site):
 *  - data.nadlan.gov.il serves static JSON price indices per settlement and neighbourhood,
 *    e.g. /api/pages/settlement/buy/5000.json (5000 = Tel Aviv-Yafo). No sign-in.
 *  - Per-deal data on nadlan.gov.il is reported to sit behind reCAPTCHA and request signing.
 *    The probe checks that claim by scanning the site's own scripts.
 *  - The site is reported to answer Israeli residential IPs only, so DEALS_PROXY is honoured.
 *  - over.org.il mirrors the Tax Authority register (1998 onwards) behind MCP servers that need
 *    a Google sign-in (OAuth). The probe only checks they are up.
 */

export const NADLAN_SITE = "https://www.nadlan.gov.il/";
export const NADLAN_DATA = "https://data.nadlan.gov.il";
export const OVER_MCP = {
  deals: "https://www.over.org.il/deals/mcp",
  nadlan: "https://www.over.org.il/nadlan/mcp",
} as const;

export interface FetchOpts {
  proxy?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
};

/** fetch with a timeout, browser-like headers and the optional Bun per-request proxy. */
export async function get(url: string, init: RequestInit = {}, o: FetchOpts = {}): Promise<Response> {
  const f = o.fetchImpl ?? fetch;
  const req: RequestInit & { proxy?: string } = {
    ...init,
    headers: { ...BROWSER_HEADERS, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
  };
  if (o.proxy) req.proxy = o.proxy;
  return f(url, req);
}

export function settlementIndexUrl(code: number | string, deal: "buy" | "rent" = "buy"): string {
  return `${NADLAN_DATA}/api/pages/settlement/${deal}/${code}.json`;
}

/** Static price-index page for one settlement. Throws with the HTTP status on failure. */
export async function fetchSettlementIndex(code: number | string, o: FetchOpts = {}): Promise<unknown> {
  const url = settlementIndexUrl(code);
  const res = await get(url, { headers: { Accept: "application/json" } }, o);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url} – ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON (${text.length} bytes): ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

/** Describe a JSON value's shape in one line: top-level keys and array lengths, two levels deep. */
export function shapeOf(v: unknown, depth = 2): string {
  if (Array.isArray(v)) return `[${v.length}]${v.length && depth > 0 ? " of " + shapeOf(v[0], depth - 1) : ""}`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as object);
    if (depth <= 0) return `{${keys.length} keys}`;
    return `{ ${keys
      .slice(0, 25)
      .map((k) => {
        const c = (v as Record<string, unknown>)[k];
        return c && typeof c === "object" ? `${k}: ${shapeOf(c, depth - 1)}` : k;
      })
      .join(", ")}${keys.length > 25 ? ", …" : ""} }`;
  }
  return typeof v;
}

/** Script URLs referenced by an HTML page, made absolute. */
export function scriptUrls(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try {
      out.add(new URL(m[1]!, base).toString());
    } catch {
      /* ignore malformed src */
    }
  }
  return [...out];
}

export interface ApiRefs {
  /** Absolute URLs on nadlan / gov.il / over.org.il hosts found in the text. */
  urls: string[];
  /** Relative API-looking paths, e.g. "/api/pages/settlement/buy/". */
  paths: string[];
  /** reCAPTCHA (or similar) markers found, e.g. "grecaptcha.execute", "recaptcha/api.js". */
  captcha: string[];
  /** Request-signing markers found, e.g. "x-signature" headers or HMAC calls. */
  signing: string[];
}

/** Pull API endpoints and anti-bot markers out of a page or JS bundle. */
export function extractApiRefs(text: string): ApiRefs {
  const urls = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[a-z0-9.-]*(?:nadlan|gov\.il|over\.org\.il)[a-z0-9.-]*(?:\/[^\s"'`<>)\\]*)?/gi)) {
    urls.add(m[0]!.replace(/[.,;]+$/, ""));
  }
  const paths = new Set<string>();
  for (const m of text.matchAll(/["'`](\/(?:api|Nadlan\.REST|rest|services?)\/[A-Za-z0-9_\-/.{}$]*)["'`]/g)) {
    paths.add(m[1]!);
  }
  const pick = (re: RegExp) => [...new Set([...text.matchAll(re)].map((m) => m[0]!.toLowerCase()))];
  return {
    urls: [...urls].sort(),
    paths: [...paths].sort(),
    captcha: pick(/grecaptcha\.(?:execute|enterprise\.execute|render)|recaptcha\/(?:api|enterprise)\.js|hcaptcha|turnstile/gi),
    signing: pick(/x-(?:signature|sign|request-signature|nonce|timestamp)\b|hmac(?:sha256)?|crypto\.subtle\.sign/gi),
  };
}

export function mergeRefs(list: ApiRefs[]): ApiRefs {
  const u = (k: keyof ApiRefs) => [...new Set(list.flatMap((r) => r[k]))].sort();
  return { urls: u("urls"), paths: u("paths"), captcha: u("captcha"), signing: u("signing") };
}
