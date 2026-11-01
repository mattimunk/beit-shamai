// Builds a single self-contained dist/index.html (JS and CSS inlined) so the app can be
// opened from disk, attached to an email or hosted as one file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const out = await Bun.build({
  entrypoints: ["./src/main.tsx"],
  minify: true,
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!out.success) {
  for (const log of out.logs) console.error(log);
  process.exit(1);
}
const js = await out.outputs[0]!.text();
const css = readFileSync("./src/styles.css", "utf8");
const html = readFileSync("./index.html", "utf8")
  .replace('<link rel="stylesheet" href="./src/styles.css" />', `<style>${css}</style>`)
  .replace('<script type="module" src="./src/main.tsx"></script>', `<script type="module">${js.replace(/<\/script/g, "<\\/script")}</script>`);

mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
console.log(`dist/index.html written (${Math.round(html.length / 1024)} KB)`);
