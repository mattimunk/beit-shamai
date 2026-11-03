/**
 * Import the national parcel layer now (it also runs monthly in the scheduler):
 *   sudo docker compose exec app bun run server/importParcels.ts
 * Downloads ~640 MB from data.gov.il, keeps one point per block/parcel, deletes the download,
 * then places any Tax Authority deals that were waiting for a location.
 */
import { openDb } from "./db";
import { runJob, syncParcelLayer } from "./jobs";

const db = openDb();
const t = Date.now();
console.log("Downloading the national parcel layer from data.gov.il (about 640 MB)…");
const r = await runJob(db, "parcels", "*", () => syncParcelLayer(db));
console.log(`\nDone in ${Math.round((Date.now() - t) / 60000)} min:`);
console.log(`  parcels stored:          ${r.parcels.toLocaleString("en")}`);
console.log(`  blocks:                  ${r.blocks.toLocaleString("en")}`);
console.log(`  fields used:             ${r.blockField} / ${r.parcelField}`);
console.log(`  Tax Authority deals placed: ${r.dealsPlaced} (still waiting: ${r.dealsWaiting})`);
