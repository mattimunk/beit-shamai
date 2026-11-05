/**
 * National parcel layer (גושים וחלקות) from the Survey of Israel, open licence, on data.gov.il:
 *   https://data.gov.il/dataset/dff8a168-af6c-4e0f-bbe3-c4bd3646084c  (updated monthly)
 * The archive (~640 MB) holds a Shapefile of ~1.1 million parcel polygons in ITM.
 *
 * We keep one map point per block/parcel (the centre of the polygon's bounding box) in
 * SQLite, which is all that is needed to place a Tax Authority deal (they carry block/parcel
 * but no address). The archive is streamed: no polygon is held in memory, and the file is
 * deleted after import.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { listZip, zipBytes, type ZipEntry } from "./zip";
import { itmToWgs84 } from "../itm";

export const PARCELS_URL =
  "https://data.gov.il/dataset/dff8a168-af6c-4e0f-bbe3-c4bd3646084c/resource/c68b4df6-c809-4bb5-a546-61fa1528fed5/download/parcel_all.zip";

export function ensureParcelPoints(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS parcel_points (block INTEGER, parcel INTEGER, lat REAL, lng REAL, PRIMARY KEY (block, parcel)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS block_points (block INTEGER PRIMARY KEY, lat REAL, lng REAL, parcels INTEGER);
  `);
}

/** Exact parcel point, or the block's centre (approx) when the parcel is not in the layer. */
export function parcelPoint(db: Database, block: string | number, parcel: string | number): { lat: number; lng: number; approx: boolean } | null {
  ensureParcelPoints(db);
  const p = db.query(`SELECT lat, lng FROM parcel_points WHERE block = ? AND parcel = ?`).get(Number(block), Number(parcel)) as { lat: number; lng: number } | null;
  if (p) return { ...p, approx: false };
  const b = db.query(`SELECT lat, lng FROM block_points WHERE block = ?`).get(Number(block)) as { lat: number; lng: number } | null;
  return b ? { ...b, approx: true } : null;
}

/** Pulls exact byte counts out of a chunked stream. */
class ByteReader {
  private buf = new Uint8Array(0);
  private pos = 0;
  constructor(private it: AsyncIterator<Uint8Array>) {}
  async read(n: number): Promise<Uint8Array | null> {
    while (this.buf.length - this.pos < n) {
      const next = await this.it.next();
      if (next.done) return null;
      const rest = this.buf.subarray(this.pos);
      const merged = new Uint8Array(rest.length + next.value.length);
      merged.set(rest);
      merged.set(next.value, rest.length);
      this.buf = merged;
      this.pos = 0;
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

interface DbfField { name: string; type: string; offset: number; length: number }

const BLOCK_FIELD = /^(GUSH_NUM|GUSH|GUSHNUM|BLOCK|BLOCK_NUM|גוש)$/i;
const PARCEL_FIELD = /^(PARCEL|PARCEL_NUM|HELKA|HELKA_NUM|PARCELNUM|חלקה)$/i;

export interface ParcelImportResult { parcels: number; blocks: number; skipped: number; fields: string[]; blockField: string; parcelField: string }

/** Read a parcels Shapefile from a ZIP into parcel_points / block_points. */
export async function importParcelZip(db: Database, zipPath: string, log: (s: string) => void = () => {}): Promise<ParcelImportResult> {
  ensureParcelPoints(db);
  const entries = await listZip(zipPath);
  const pick = (ext: string) => {
    const all = entries.filter((e) => e.name.toLowerCase().endsWith(ext));
    // The main layer is the largest one (the archive may also hold small helper layers).
    return all.sort((a, b) => b.compressedSize - a.compressedSize)[0];
  };
  const shpE = pick(".shp"), dbfE = pick(".dbf");
  if (!shpE || !dbfE) throw new Error(`no shapefile in archive: ${entries.map((e) => e.name).join(", ")}`);
  return importParcelStreams(db, shpE, dbfE, zipPath, log);
}

async function importParcelStreams(db: Database, shpE: ZipEntry, dbfE: ZipEntry, zipPath: string, log: (s: string) => void): Promise<ParcelImportResult> {
  const shp = new ByteReader(zipBytes(zipPath, shpE)[Symbol.asyncIterator]());
  const dbf = new ByteReader(zipBytes(zipPath, dbfE)[Symbol.asyncIterator]());

  // DBF header
  const h = await dbf.read(32);
  if (!h) throw new Error("empty DBF");
  const hv = new DataView(h.buffer, h.byteOffset, 32);
  const count = hv.getUint32(4, true), headerLen = hv.getUint16(8, true), recLen = hv.getUint16(10, true);
  const fieldBytes = await dbf.read(headerLen - 32);
  const fields: DbfField[] = [];
  let off = 1; // deletion flag
  for (let i = 0; i + 32 <= fieldBytes!.length && fieldBytes![i] !== 0x0d; i += 32) {
    const name = new TextDecoder("latin1").decode(fieldBytes!.subarray(i, i + 11)).replace(/\0.*$/, "").trim();
    const f = { name, type: String.fromCharCode(fieldBytes![i + 11]!), offset: off, length: fieldBytes![i + 16]! };
    fields.push(f);
    off += f.length;
  }
  const bf = fields.find((f) => BLOCK_FIELD.test(f.name));
  const pf = fields.find((f) => PARCEL_FIELD.test(f.name));
  if (!bf || !pf) throw new Error(`block/parcel fields not recognised; fields are: ${fields.map((f) => f.name).join(", ")}`);
  log(`fields: ${fields.map((f) => f.name).join(", ")} → block=${bf.name}, parcel=${pf.name}; ${count} records`);

  // SHP header (100 bytes)
  if (!(await shp.read(100))) throw new Error("empty SHP");

  const num = (rec: Uint8Array, f: DbfField) => Number(new TextDecoder("latin1").decode(rec.subarray(f.offset, f.offset + f.length)).trim());
  const ins = db.prepare(`INSERT OR REPLACE INTO parcel_points (block, parcel, lat, lng) VALUES (?, ?, ?, ?)`);
  db.exec(`DELETE FROM parcel_points; DELETE FROM block_points;`);
  let parcels = 0, skipped = 0, batch: [number, number, number, number][] = [];
  const flush = db.transaction((rows: [number, number, number, number][]) => { for (const r of rows) ins.run(...r); });

  for (let i = 0; i < count; i++) {
    const rec = await dbf.read(recLen);
    const rh = await shp.read(8);
    if (!rec || !rh) break;
    const len = new DataView(rh.buffer, rh.byteOffset, 8).getInt32(4, false) * 2; // big-endian, 16-bit words
    const content = await shp.read(len);
    if (!content) break;
    const cv = new DataView(content.buffer, content.byteOffset, content.length);
    const type = len >= 4 ? cv.getInt32(0, true) : 0;
    const block = num(rec, bf), parcel = num(rec, pf);
    if (rec[0] === 0x2a || type === 0 || len < 36 || !Number.isFinite(block) || !Number.isFinite(parcel) || block <= 0) { skipped++; continue; }
    const x = (cv.getFloat64(4, true) + cv.getFloat64(20, true)) / 2;
    const y = (cv.getFloat64(12, true) + cv.getFloat64(28, true)) / 2;
    const ll = x > 1000 ? itmToWgs84(x, y) : { lat: y, lng: x }; // ITM metres, or already degrees
    batch.push([block, parcel, ll.lat, ll.lng]);
    if (batch.length >= 20_000) { flush(batch); parcels += batch.length; batch = []; log(`${parcels} parcels`); }
  }
  flush(batch);
  parcels += batch.length;
  db.exec(`INSERT OR REPLACE INTO block_points (block, lat, lng, parcels) SELECT block, AVG(lat), AVG(lng), COUNT(*) FROM parcel_points GROUP BY block`);
  const blocks = (db.query(`SELECT COUNT(*) AS n FROM block_points`).get() as { n: number }).n;
  return { parcels, blocks, skipped, fields: fields.map((f) => f.name), blockField: bf.name, parcelField: pf.name };
}

/** Download the national archive, import it, delete the archive. */
export async function syncParcels(db: Database, dir: string, url = PARCELS_URL, log: (s: string) => void = () => {}): Promise<ParcelImportResult> {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/parcel_all.zip`;
  const contact = process.env.CONTACT_EMAIL?.trim();
  const res = await fetch(url, {
    headers: { "user-agent": `BeitShamai/0.1 (open-data import${contact ? `; ${contact}` : ""})`, accept: "application/zip,application/octet-stream,*/*" },
    redirect: "follow",
  });
  if (res.status === 403)
    throw new Error("data.gov.il refused the download (403) – download parcel_all.zip in a browser and import it from a file (see docs/DEPLOY.md, 'Parcel layer')");
  if (!res.ok) throw new Error(`parcels download ${res.status}`);
  await Bun.write(path, res);
  log(`downloaded ${(Bun.file(path).size / 1e6).toFixed(0)} MB`);
  try {
    return await importParcelZip(db, path, log);
  } finally {
    rmSync(path, { force: true });
  }
}

/**
 * Parcels whose centre is nearest a point (e.g. a geocoded address), closest first.
 * Centres are of bounding boxes, so the nearest one is a suggestion to confirm in the
 * land-registry extract, not an identification.
 */
export function parcelsNear(db: Database, lat: number, lng: number, maxM = 80, limit = 3): { block: number; parcel: number; distanceM: number }[] {
  ensureParcelPoints(db);
  const dLat = maxM / 111320, dLng = maxM / (111320 * Math.cos((lat * Math.PI) / 180));
  const rows = db.query(`SELECT block, parcel, lat, lng FROM parcel_points WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`)
    .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng) as { block: number; parcel: number; lat: number; lng: number }[];
  return rows
    .map((r) => ({ block: r.block, parcel: r.parcel, distanceM: Math.round(Math.hypot((r.lat - lat) * 111320, (r.lng - lng) * 111320 * Math.cos((lat * Math.PI) / 180))) }))
    .filter((r) => r.distanceM <= maxM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}
