/**
 * Beit Shamai API server (Bun).
 *
 *   GET  /health
 *   POST /api/valuate              { subject, date? }                  → ValuationResult
 *   POST /api/listings/import      ImportRequest (licensed feeds)      → ImportResult      [admin]
 *   POST /api/jobs/sync-deals      { lat, lng, radiusM }               → { stored, unmapped } [admin]
 *   POST /api/jobs/match           { lat, lng, radiusM, sinceIso? }    → match stats        [admin]
 *   GET  /api/pairs?lat&lng&radiusM                                    → matched pairs      [admin]
 *
 * Deploy in an Israeli region: GovMap / nadlan.gov.il answer Israeli IPs only.
 * Admin routes need `Authorization: Bearer $ADMIN_TOKEN`.
 */
import type { Subject } from "../src/engine/types";
import { valuate } from "../src/engine/valuation";
import { openDb, pairsNear } from "./db";
import { importFeed, type ImportRequest } from "./ledger";
import { rematch, syncDeals } from "./jobs";
import { SqliteProvider } from "./sqliteProvider";

export function createServer(opts: { dbPath?: string; adminToken?: string; port?: number } = {}) {
  const db = openDb(opts.dbPath);
  const provider = new SqliteProvider(db);
  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const isAdmin = (req: Request) => !!adminToken && req.headers.get("authorization") === `Bearer ${adminToken}`;

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 8787),
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/health") return json({ ok: true });

        if (url.pathname === "/api/valuate" && req.method === "POST") {
          const body = (await req.json()) as { subject: Subject; date?: string };
          if (!body?.subject?.location) return json({ error: "subject with location required" }, 400);
          const date = body.date ?? new Date().toISOString().slice(0, 10);
          return json(await valuate(body.subject, provider, date));
        }

        if (url.pathname.startsWith("/api/") && !isAdmin(req)) return json({ error: "unauthorised" }, 401);

        if (url.pathname === "/api/listings/import" && req.method === "POST") {
          return json(importFeed(db, (await req.json()) as ImportRequest));
        }
        if (url.pathname === "/api/jobs/sync-deals" && req.method === "POST") {
          const b = (await req.json()) as { lat: number; lng: number; radiusM: number };
          return json(await syncDeals(db, b));
        }
        if (url.pathname === "/api/jobs/match" && req.method === "POST") {
          const b = (await req.json()) as { lat: number; lng: number; radiusM: number; sinceIso?: string };
          const since = b.sinceIso ?? new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
          return json(rematch(db, b, since));
        }
        if (url.pathname === "/api/pairs" && req.method === "GET") {
          const lat = Number(url.searchParams.get("lat"));
          const lng = Number(url.searchParams.get("lng"));
          const r = Number(url.searchParams.get("radiusM") ?? 1000);
          return json(pairsNear(db, lat, lng, r));
        }
        return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    },
  });
  return { server, db };
}

if (import.meta.main) {
  const { server } = createServer();
  console.log(`Beit Shamai API on http://localhost:${server.port}`);
}
