import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShotList, framesFromVideo, pickFrames, sharpness } from "../server/capture";
import { parsePgm } from "../server/connectors/advertPdf";

const hasFfmpeg = Bun.spawnSync(["which", "ffmpeg"]).exitCode === 0;

describe("visit capture", () => {
  test("shot list follows the layout, in walking order", () => {
    const shots = buildShotList({ bedrooms: 3, bathrooms: 2, toilets: 1, balconies: 1, garden: false, storage: true, parking: true });
    expect(shots.map((s) => s.id)).toEqual([
      "facade", "entrance", "stairs", "salon", "kitchen", "bedroom-1", "bedroom-2", "bedroom-3",
      "bathroom-1", "bathroom-2", "toilet-1", "balcony-1", "storage", "parking", "view",
    ]);
    expect(shots.find((s) => s.id === "balcony-1")!.n).toBeUndefined(); // only one: no number
  });

  test("sharpness: an edge pattern scores higher than a flat image; frames are spread out", () => {
    const flat = parsePgm(new Uint8Array([...new TextEncoder().encode("P5 4 4 255\n"), ...new Array(16).fill(128)]));
    const edges = parsePgm(new Uint8Array([...new TextEncoder().encode("P5 4 4 255\n"), ...[0, 255, 0, 255, 255, 0, 255, 0, 0, 255, 0, 255, 255, 0, 255, 0]]));
    expect(sharpness(edges)).toBeGreaterThan(sharpness(flat));
    expect(pickFrames([{ t: 1, s: 10 }, { t: 2, s: 9 }, { t: 8, s: 5 }], 2, 4)).toEqual([1, 8]);
  });

  test.skipIf(!hasFfmpeg)("video: the report frame comes from the sharp part of the clip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    const video = join(dir, "v.mp4");
    // 0–4 s blurred, 4–7 s sharp, 7–11 s blurred.
    const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10:duration=11",
      "-vf", "boxblur=enable='not(between(t,4,7))':luma_radius=12:luma_power=3", "-pix_fmt", "yuv420p", video]);
    expect(r.exitCode).toBe(0);
    const out = await framesFromVideo(video, dir, "salon-x");
    expect(out.duration).toBeGreaterThan(10);
    expect(out.frames[0]).toBe("salon-x-1.jpg");
    // Check the chosen moment by re-scoring the extracted frame against a blurred one.
    const score = (f: string) => {
      const p = join(dir, `${f}.pgm`);
      Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", join(dir, f), "-vf", "scale=320:-2,format=gray", p]);
      return sharpness(parsePgm(new Uint8Array(require("node:fs").readFileSync(p))));
    };
    Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", video, "-frames:v", "1", join(dir, "blur.jpg")]);
    expect(score(out.frames[0]!)).toBeGreaterThan(score("blur.jpg") * 3);
  });
});
