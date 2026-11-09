/**
 * Guided capture of a property visit ("car-rental style"): a shot list built from the flat's
 * layout, one short video or photo per shot, and the sharpest frames picked for the report.
 *
 * Videos are sampled at one frame per second (small greyscale frames), each frame is scored
 * for sharpness (variance of the Laplacian), and up to two sharp frames at least a few
 * seconds apart are extracted at full size as JPEGs. Photos are resized to the same size.
 * Needs ffmpeg / ffprobe on the server.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePgm, type Gray } from "./connectors/advertPdf";

export const MAX_CAPTURE_BYTES = 600 * 1024 * 1024;

export type ShotKind =
  | "facade" | "entrance" | "stairs" | "salon" | "kitchen" | "bedroom" | "bathroom" | "toilet"
  | "extra" | "balcony" | "garden" | "storage" | "parking" | "view";

export interface Layout {
  bedrooms: number;
  bathrooms: number;
  toilets: number; // separate guest toilets
  balconies: number;
  garden: boolean;
  storage: boolean;
  parking: boolean;
  /** Other rooms the owner named (study, utility room…), filmed after the bedrooms and bathrooms. */
  extra?: string[];
}

export interface Shot { id: string; kind: ShotKind; n?: number }

/** The shot list, in walking order: outside, in, living areas, rooms, outdoor, extras. */
export function buildShotList(l: Layout): Shot[] {
  const many = (kind: ShotKind, count: number): Shot[] =>
    Array.from({ length: Math.max(0, Math.min(12, Math.floor(count))) }, (_, i) => ({ id: `${kind}-${i + 1}`, kind, n: count > 1 ? i + 1 : undefined }));
  return [
    { id: "facade", kind: "facade" },
    { id: "entrance", kind: "entrance" },
    { id: "stairs", kind: "stairs" },
    { id: "salon", kind: "salon" },
    { id: "kitchen", kind: "kitchen" },
    ...many("bedroom", l.bedrooms),
    ...many("bathroom", l.bathrooms),
    ...many("toilet", l.toilets),
    ...(l.extra ?? []).slice(0, 12).map((_, i) => ({ id: `extra-${i + 1}`, kind: "extra" as const, n: i + 1 })),
    ...many("balcony", l.balconies),
    ...(l.garden ? [{ id: "garden", kind: "garden" as const }] : []),
    ...(l.storage ? [{ id: "storage", kind: "storage" as const }] : []),
    ...(l.parking ? [{ id: "parking", kind: "parking" as const }] : []),
    { id: "view", kind: "view" },
  ];
}

export function ensureCaptureTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS captures (
      case_id TEXT, shot_id TEXT, media TEXT, file TEXT, frames TEXT, duration REAL, at TEXT,
      PRIMARY KEY (case_id, shot_id)
    );
    CREATE TABLE IF NOT EXISTS case_layouts (case_id TEXT PRIMARY KEY, layout TEXT, at TEXT);
  `);
}

const dataDir = () => process.env.DATA_DIR ?? "data";
const caseDir = (caseId: string) => join(dataDir(), "docs", caseId, "capture");

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(-300)}`);
  return out;
}

/** Sharpness of a greyscale image: variance of the 4-neighbour Laplacian. */
export function sharpness(img: Gray): number {
  const { w, h, px } = img;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * px[i]! - px[i - 1]! - px[i + 1]! - px[i - w]! - px[i + w]!;
      sum += v; sum2 += v * v; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/** Pick up to `k` sharp moments, at least `gap` seconds apart, best first. */
export function pickFrames(scores: { t: number; s: number }[], k = 2, gap = 4): number[] {
  const sorted = [...scores].sort((a, b) => b.s - a.s);
  const out: number[] = [];
  for (const c of sorted) {
    if (out.length >= k) break;
    if (out.every((t) => Math.abs(t - c.t) >= gap)) out.push(c.t);
  }
  return out;
}

/** Extract the report frames of a video: returns JPEG file names (in `outDir`) and duration. */
export async function framesFromVideo(video: string, outDir: string, stem: string): Promise<{ frames: string[]; duration: number }> {
  const duration = Number((await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", video])).trim()) || 0;
  const tmp = mkdtempSync(join(tmpdir(), "frames-"));
  try {
    // One small greyscale frame per second for scoring (skip the shaky first half-second).
    await run(["ffmpeg", "-v", "error", "-ss", "0.5", "-i", video, "-vf", "fps=1,scale=320:-2,format=gray", "-f", "image2", join(tmp, "s%04d.pgm")]);
    const files = readdirSync(tmp).filter((f) => f.endsWith(".pgm")).sort();
    const scores = await Promise.all(files.map(async (f, i) => ({ t: 0.5 + i, s: sharpness(parsePgm(await Bun.file(join(tmp, f)).bytes())) })));
    const times = scores.length ? pickFrames(scores, 2, Math.max(2, Math.min(6, duration / 3))) : [Math.min(1, duration / 2)];
    const frames: string[] = [];
    for (let i = 0; i < times.length; i++) {
      const name = `${stem}-${i + 1}.jpg`;
      await run(["ffmpeg", "-v", "error", "-y", "-ss", times[i]!.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale='min(1600,iw)':-2", "-q:v", "3", join(outDir, name)]);
      frames.push(name);
    }
    return { frames, duration };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A photo becomes one report frame (resized JPEG). */
export async function frameFromPhoto(photo: string, outDir: string, stem: string): Promise<string[]> {
  const name = `${stem}-1.jpg`;
  await run(["ffmpeg", "-v", "error", "-y", "-i", photo, "-frames:v", "1", "-vf", "scale='min(1600,iw)':-2", "-q:v", "3", join(outDir, name)]);
  return [name];
}

export interface CaptureRecord { shotId: string; media: "video" | "photo"; frames: string[]; duration?: number; at: string }

export async function storeCapture(db: Database, caseId: string, shotId: string, file: File): Promise<CaptureRecord> {
  ensureCaptureTables(db);
  if (!/^[a-z]+(-\d{1,2})?$/.test(shotId)) throw new Error("bad shot id");
  if (file.size > MAX_CAPTURE_BYTES) throw new Error("file too large (600 MB max)");
  const media = file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|3gp)$/i.test(file.name) ? "video" : file.type.startsWith("image/") || /\.(jpe?g|png|heic|webp)$/i.test(file.name) ? "photo" : null;
  if (!media) throw new Error(`not a video or photo: ${file.type || file.name}`);
  const dir = caseDir(caseId);
  mkdirSync(dir, { recursive: true });
  // A new take replaces the previous one for this shot.
  const prev = db.query(`SELECT file, frames FROM captures WHERE case_id = ? AND shot_id = ?`).get(caseId, shotId) as { file: string; frames: string } | null;
  const stem = `${shotId}-${Date.now().toString(36)}`;
  const ext = (file.name.match(/\.[A-Za-z0-9]{2,4}$/)?.[0] ?? (media === "video" ? ".mp4" : ".jpg")).toLowerCase();
  const original = join(dir, `${stem}${ext}`);
  await Bun.write(original, file);
  const { frames, duration } = media === "video" ? await framesFromVideo(original, dir, stem) : { frames: await frameFromPhoto(original, dir, stem), duration: undefined };
  const at = new Date().toISOString();
  db.query(`INSERT OR REPLACE INTO captures (case_id, shot_id, media, file, frames, duration, at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(caseId, shotId, media, original, JSON.stringify(frames), duration ?? null, at);
  if (prev) {
    rmSync(prev.file, { force: true });
    for (const f of JSON.parse(prev.frames) as string[]) rmSync(join(dir, f), { force: true });
  }
  return { shotId, media, frames, duration, at };
}

export function listCaptures(db: Database, caseId: string): CaptureRecord[] {
  ensureCaptureTables(db);
  return (db.query(`SELECT shot_id, media, frames, duration, at FROM captures WHERE case_id = ? ORDER BY at`).all(caseId) as any[]).map((r) => ({
    shotId: r.shot_id, media: r.media, frames: JSON.parse(r.frames), duration: r.duration ?? undefined, at: r.at,
  }));
}

/** Keeps only the known fields, in range. */
export function cleanLayout(l: Partial<Layout>): Layout {
  const n = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  return {
    bedrooms: n(l.bedrooms, 12), bathrooms: n(l.bathrooms, 12), toilets: n(l.toilets, 12), balconies: n(l.balconies, 12),
    garden: !!l.garden, storage: !!l.storage, parking: !!l.parking,
    extra: Array.isArray(l.extra) ? l.extra.filter((x) => typeof x === "string").map((x) => x.slice(0, 40)).slice(0, 12) : [],
  };
}

export function saveLayout(db: Database, caseId: string, raw: Layout) {
  ensureCaptureTables(db);
  const layout = cleanLayout(raw);
  db.query(`INSERT OR REPLACE INTO case_layouts (case_id, layout, at) VALUES (?, ?, ?)`).run(caseId, JSON.stringify(layout), new Date().toISOString());
}

export function getLayout(db: Database, caseId: string): Layout | null {
  ensureCaptureTables(db);
  const r = db.query(`SELECT layout FROM case_layouts WHERE case_id = ?`).get(caseId) as { layout: string } | null;
  return r ? JSON.parse(r.layout) : null;
}

/** Path of a frame file, or null if the name is not one of this case's frames. */
export function framePath(caseId: string, name: string): string | null {
  if (!/^[a-z]+(-\d{1,2})?-[a-z0-9]+-\d\.jpg$/.test(name)) return null;
  return join(caseDir(caseId), name);
}
