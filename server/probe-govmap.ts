/**
 * Run from an Israeli host to check the GovMap response shape against mapDeal():
 *
 *   bun run server/probe-govmap.ts 32.0853 34.7818 300
 *
 * Prints the raw keys of the first rows, how many rows mapped, and saves the raw payload to
 * tests/fixtures/govmap-live.json so a real fixture can be added to the test suite.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { extractRows, fetchDealsByRadius } from "./govmap";

const [lat = "32.0853", lng = "34.7818", radius = "300"] = process.argv.slice(2);
const { deals, unmapped, raw } = await fetchDealsByRadius({ lat: Number(lat), lng: Number(lng) }, Number(radius));
const rows = extractRows(raw);
console.log(`rows: ${rows.length}, mapped: ${deals.length}, unmapped: ${unmapped}`);
console.log("keys of first row:", rows[0] ? Object.keys(rows[0]) : "(none)");
console.log("first raw row:", rows[0]);
console.log("first mapped deal:", deals[0]);
mkdirSync("tests/fixtures", { recursive: true });
writeFileSync("tests/fixtures/govmap-live.json", JSON.stringify(raw, null, 2));
console.log("saved tests/fixtures/govmap-live.json");
