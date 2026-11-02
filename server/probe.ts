/**
 * Source check – run once from the deployed server (or any Israeli machine):
 *
 *   bun run server/probe.ts [lat] [lng]
 *
 * Calls every external source once around the point, prints PASS / FAIL with what came back,
 * and saves the raw responses to tests/fixtures/live/ so real fixtures can be added to tests.
 * Default point: central Tel Aviv.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { extractRows, fetchDealsByRadius, GOVMAP_HEADERS } from "./govmap";
import { wgs84ToItm } from "./itm";
import { geocode } from "./connectors/geocode";
import { queryAround } from "./connectors/arcgis";
import { CBS_BASE, fetchDistrictIndex } from "./connectors/cbs";
import { loadSources } from "./config";

const [latS = "32.0853", lngS = "34.7818"] = process.argv.slice(2);
const center = { lat: Number(latS), lng: Number(lngS) };
const cfg = loadSources();
const out = "tests/fixtures/live";
mkdirSync(out, { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(`${out}/${name}.json`, JSON.stringify(data, null, 2));
const results: { source: string; ok: boolean; note: string }[] = [];

async function check(source: string, fn: () => Promise<string>) {
  try {
    results.push({ source, ok: true, note: await fn() });
  } catch (e) {
    results.push({ source, ok: false, note: (e as Error).message });
  }
}

await check("GovMap deals (Tax Authority)", async () => {
  const r = await fetchDealsByRadius(center, 300, { proxy: process.env.DEALS_PROXY });
  save("govmap-deals", r.raw);
  const rows = extractRows(r.raw);
  if (!rows.length) throw new Error("no rows – endpoint shape changed or IP blocked");
  return `${rows.length} rows, ${r.deals.length} mapped, ${r.unmapped} unmapped; first row keys: ${Object.keys(rows[0]!).join(", ")}`;
});

// Diagnostics: why does GovMap refuse? Compare a bare request with a browser-like one, and
// check whether the government real-estate site (nadlan.gov.il) answers from this server.
async function status(url: string, init: RequestInit = {}) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = (await r.text()).replace(/\s+/g, " ").slice(0, 160);
    return `HTTP ${r.status} – ${body}`;
  } catch (e) {
    return `error – ${(e as Error).message}`;
  }
}
await check("Diagnostics (not a source)", async () => {
  const xy = wgs84ToItm(center.lat, center.lng);
  const url = `https://www.govmap.gov.il/api/real-estate/deals/${Math.round(xy.x)},${Math.round(xy.y)}/300`;
  const lines = [
    `server public IP: ${await status("https://api.ipify.org")}`,
    `govmap home page: ${await status("https://www.govmap.gov.il/")}`,
    `govmap deals, bare request: ${await status(url)}`,
    `govmap deals, browser headers: ${await status(url, { headers: GOVMAP_HEADERS })}`,
    `nadlan.gov.il home: ${await status("https://www.nadlan.gov.il/")}`,
    `data.nadlan.gov.il (static JSON): ${await status("https://data.nadlan.gov.il/api/pages/settlement/buy/5000.json")}`,
    `CBS chapter aa: ${await status(`${CBS_BASE}/catalog/chapter?id=aa&format=json&download=false&lang=he`)}`,
  ];
  return "\n      " + lines.join("\n      ");
});

await check("GovMap address search", async () => {
  const hits = await geocode("דיזנגוף 50 תל אביב");
  save("govmap-geocode", hits);
  if (!hits.length) throw new Error("no hits parsed – check response shape in the saved file");
  return `${hits.length} hits, first: ${hits[0]!.label} (${hits[0]!.lat.toFixed(5)}, ${hits[0]!.lng.toFixed(5)})`;
});

await check("CBS dwelling price index", async () => {
  const r = await fetchDistrictIndex("tel_aviv", { code: cfg.cbs.codes.tel_aviv });
  save("cbs-tel-aviv", r);
  if (!r.points.length) throw new Error(`series ${r.code} returned no observations`);
  return `series ${r.code}: ${r.points.length} months, latest ${r.points.at(-1)!.month} = ${r.points.at(-1)!.value} → pin this code in config`;
});

await check("GTFS feed", async () => {
  const res = await fetch(cfg.gtfsUrl, { method: "HEAD" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return `reachable, ${(Number(res.headers.get("content-length") ?? 0) / 1e6).toFixed(0)} MB`;
});

for (const [name, layer] of Object.entries(cfg.layers)) {
  if (!layer) {
    results.push({ source: `Layer: ${name}`, ok: false, note: "no URL configured yet" });
    continue;
  }
  await check(`Layer: ${name}`, async () => {
    const feats = await queryAround(layer, center, 1000);
    save(`layer-${name}`, feats.slice(0, 20));
    return `${feats.length} features; attribute names: ${feats[0] ? Object.keys(feats[0].attributes).join(", ") : "(none)"}`;
  });
}

console.log("\nSource check\n" + "-".repeat(60));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.source}\n      ${r.note}`);
console.log(`\nRaw responses saved in ${out}/ – send them over to lock in the field mappings.`);
