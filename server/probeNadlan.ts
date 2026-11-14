/**
 * Deals-source check: can this server get Tax Authority deals without the manual export?
 * Run from the deployed server (an Israeli address matters):
 *
 *   bun run server/probeNadlan.ts [settlementCode]
 *   sudo docker compose exec app bun run server/probeNadlan.ts 5000
 *
 * settlementCode is the CBS locality code (default 5000 = Tel Aviv-Yafo). DEALS_PROXY in .env
 * (an Israeli ISP proxy) is used for every request if set.
 *
 * It checks:
 *  1. data.nadlan.gov.il static price index for the settlement (open, no sign-in expected)
 *  2. www.nadlan.gov.il: loads the site and its scripts, lists the API endpoints they call, and
 *     looks for reCAPTCHA / request-signing code. That shows whether per-deal data is reachable.
 *  3. over.org.il deals mirror (MCP): up or not, and whether it wants a sign-in.
 *
 * Raw responses go to tests/fixtures/live/nadlan-*. Send the printout (and those files) back.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  NADLAN_SITE,
  OVER_MCP,
  extractApiRefs,
  fetchSettlementIndex,
  get,
  mergeRefs,
  scriptUrls,
  settlementIndexUrl,
  shapeOf,
  type ApiRefs,
} from "./connectors/nadlanGov";

const code = process.argv[2] ?? "5000";
const proxy = process.env.DEALS_PROXY || undefined;
const o = { proxy };
const out = "tests/fixtures/live";
mkdirSync(out, { recursive: true });
const save = (name: string, data: unknown) =>
  writeFileSync(`${out}/${name}`, typeof data === "string" ? data : JSON.stringify(data, null, 2));

type Verdict = "PASS" | "FAIL" | "INFO";
const results: { v: Verdict; source: string; note: string }[] = [];
const line = (v: Verdict, source: string, note: string) => results.push({ v, source, note });
const clip = (s: string, n = 160) => s.replace(/\s+/g, " ").slice(0, n);

// 0. Where are we calling from?
try {
  const ip = await (await get("https://api.ipify.org", {}, o)).text();
  line("INFO", "Calling from", `${ip.trim()}${proxy ? " (through DEALS_PROXY)" : " (no proxy)"}`);
} catch (e) {
  line("INFO", "Calling from", `IP lookup failed – ${(e as Error).message}`);
}

// 1. Static price index (open layer).
try {
  const json = await fetchSettlementIndex(code, o);
  save(`nadlan-index-${code}.json`, json);
  line("PASS", `Price index ${settlementIndexUrl(code)}`, shapeOf(json));
} catch (e) {
  line("FAIL", `Price index ${settlementIndexUrl(code)}`, (e as Error).message);
}

// 2. The site and its scripts: which endpoints, and are they gated?
let refs: ApiRefs | null = null;
try {
  const res = await get(NADLAN_SITE, {}, o);
  const html = await res.text();
  save("nadlan-home.html", html);
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${clip(html)}`);
  const host = new URL(NADLAN_SITE).host;
  const queue = scriptUrls(html, NADLAN_SITE);
  const seen = new Set<string>();
  const found: ApiRefs[] = [extractApiRefs(html)];
  const failed: string[] = [];
  // Follow same-site scripts and the chunks they reference, up to 40 files.
  while (queue.length && seen.size < 40) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const r = await get(url, {}, o);
      if (!r.ok) {
        failed.push(`${r.status} ${url}`);
        continue;
      }
      const js = await r.text();
      found.push(extractApiRefs(js));
      if (new URL(url).host !== host) continue; // don't crawl third-party chunks
      for (const m of js.matchAll(/["'`]((?:\.{0,2}\/)?[A-Za-z0-9_\-/.]+\.js)["'`]/g)) {
        try {
          const next = new URL(m[1]!, url).toString();
          if (new URL(next).host === host && !seen.has(next)) queue.push(next);
        } catch {
          /* not a URL */
        }
      }
    } catch (e) {
      failed.push(`${(e as Error).message} ${url}`);
    }
  }
  refs = mergeRefs(found);
  save("nadlan-endpoints.json", { scripts: [...seen], failed, ...refs });
  line(
    "PASS",
    "nadlan.gov.il site",
    `HTTP ${res.status}, ${seen.size} scripts read${failed.length ? `, ${failed.length} failed` : ""}` +
      `\n      endpoints: ${refs.urls.length} URLs, ${refs.paths.length} API paths (full list in nadlan-endpoints.json)` +
      [...refs.urls.filter((u) => /api|rest|deal/i.test(u)), ...refs.paths]
        .slice(0, 15)
        .map((u) => `\n        ${u}`)
        .join("") +
      `\n      reCAPTCHA markers: ${refs.captcha.join(", ") || "none found"}` +
      `\n      request-signing markers: ${refs.signing.join(", ") || "none found"}`,
  );
} catch (e) {
  line("FAIL", "nadlan.gov.il site", (e as Error).message);
}

// 3. over.org.il mirror of the Tax Authority register (MCP over HTTP).
for (const [name, url] of Object.entries(OVER_MCP)) {
  try {
    const res = await get(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "beit-shamai-probe", version: "0.1" } },
        }),
      },
      o,
    );
    const body = clip(await res.text());
    const auth = res.headers.get("www-authenticate");
    if (res.status === 401) line("PASS", `over.org.il ${name}`, `up; needs sign-in (401${auth ? `, ${clip(auth, 120)}` : ""})`);
    else if (res.ok) line("PASS", `over.org.il ${name}`, `up; answered without sign-in – ${body}`);
    else line("FAIL", `over.org.il ${name}`, `HTTP ${res.status} – ${body}`);
  } catch (e) {
    line("FAIL", `over.org.il ${name}`, (e as Error).message);
  }
}

console.log("\nDeals-source check\n" + "-".repeat(60));
for (const r of results) console.log(`${r.v.padEnd(4)}  ${r.source}\n      ${r.note}`);

// Plain-language reading of the results.
const ok = (prefix: string) => results.some((r) => r.v === "PASS" && r.source.startsWith(prefix));
const notes: string[] = [];
if (!ok("Price index") && !ok("nadlan.gov.il")) {
  notes.push("nadlan.gov.il refuses this server. Try again with DEALS_PROXY set to an Israeli ISP proxy.");
} else {
  if (ok("Price index")) notes.push("Price indices per city/neighbourhood are reachable: usable as a market-trend source.");
  if (refs?.captcha.length || refs?.signing.length)
    notes.push("The site's own code uses reCAPTCHA and/or request signing: per-deal data can't be fetched automatically (same wall as GovMap).");
  else if (refs)
    notes.push("No reCAPTCHA or signing code found in the scripts read. Per-deal endpoints may be open – send nadlan-endpoints.json back to check.");
}
if (ok("over.org.il deals"))
  notes.push("over.org.il is up. It needs a one-time Google sign-in; check its terms before relying on it.");
console.log("\nWhat this means\n" + notes.map((n) => `- ${n}`).join("\n"));
console.log(`\nRaw responses saved in ${out}/nadlan-* – send them over.`);
