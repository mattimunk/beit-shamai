/**
 * Import the national parcel layer now (it also runs monthly in the scheduler).
 *
 *   sudo docker compose exec app bun run server/importParcels.ts
 *       downloads ~640 MB from data.gov.il, keeps one point per block/parcel, deletes the download
 *
 *   sudo docker compose exec app bun run server/importParcels.ts /data/parcel_all.zip
 *       imports a copy you downloaded yourself (when data.gov.il refuses the server)
 *
 * Afterwards, Tax Authority deals that were waiting for a location are placed.
 */
import { existsSync, rmSync } from "node:fs";
import { openDb } from "./db";
import { runJob, syncParcelLayer } from "./jobs";

const file = process.argv[2];
if (file && !existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}
const db = openDb();
const t = Date.now();
console.log(file ? `Importing ${file}…` : "Downloading the national parcel layer from data.gov.il (about 640 MB)…");
const r = await runJob(db, "parcels", "*", () => syncParcelLayer(db, undefined, undefined, file));
if (file) rmSync(file, { force: true }); // the points are in the database; the archive is not needed
console.log(`\nDone in ${Math.max(1, Math.round((Date.now() - t) / 60000))} min:`);
console.log(`  parcels stored:             ${r.parcels.toLocaleString("en")}`);
console.log(`  blocks:                     ${r.blocks.toLocaleString("en")}`);
console.log(`  fields used:                ${r.blockField} / ${r.parcelField}`);
console.log(`  Tax Authority deals placed: ${r.dealsPlaced} (still waiting: ${r.dealsWaiting})`);
