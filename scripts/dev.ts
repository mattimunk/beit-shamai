// Minimal dev server: rebuilds the single-file bundle on each page load.
import { $ } from "bun";

Bun.serve({
  port: Number(process.env.PORT ?? 5173),
  async fetch() {
    await $`bun run scripts/build.ts`.quiet();
    return new Response(Bun.file("dist/index.html"), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log("Beit Shamai dev server on http://localhost:" + (process.env.PORT ?? 5173));
