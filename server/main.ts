/**
 * Beit Shamai API server (Bun). Serves the web app and the API.
 *
 *   GET  /                         the web app (dist/index.html, built by `bun run build`)
 *   GET  /health                   status and data freshness per source
 *   GET  /api/geocode?q=...        address search (GovMap)
 *   POST /api/cases/:caseId/documents  upload one document (multipart: file, kind)
 *   GET  /api/cases/:caseId/documents  list a case's documents
 *   POST /api/valuate              { subject, facts?, date?, caseId? } → ValuationResult
 *   POST /api/cases/:caseId/adverts   Madlan/Yad2 print-to-PDF (multipart: file) → cards read
 *   GET  /api/cases/:caseId/adverts   the case's adverts and whether each is used
 *   POST /api/requests             { subject } → request with its Tax Authority search plan
 *   GET  /api/requests/:id         request status (preliminary / final) and plan
 *   GET  /api/requests             open requests (inbox)                                   [admin]
 *   POST /api/requests/:id/items/:itemId/upload   Tax Authority export for one search    [admin]
 *   POST /api/tax/import           Tax Authority export without a request                 [admin]
 *   POST /api/deals/import         CSV or { source, rows } of completed deals              [admin]
 *   POST /api/listings/import      ImportRequest (licensed feeds)      → ImportResult      [admin]
 *   POST /api/jobs/:job            run a job now: deals | match | gtfs | cbs | renewal | backup [admin]
 *   GET  /api/pairs?lat&lng&radiusM                                    → matched pairs      [admin]
 *
 * Deploy in an Israeli region: GovMap / nadlan.gov.il answer Israeli IPs only.
 * Admin routes need `Authorization: Bearer $ADMIN_TOKEN`. Set SCHEDULER=1 to run the jobs.
 */
import { existsSync } from "node:fs";
import type { Subject } from "../src/engine/types";
import { valuate, type ValuationFacts } from "../src/engine/valuation";
import { lastRun, openDb, pairsNear } from "./db";
import { importFeed, type ImportRequest } from "./ledger";
import { backup, rematch, runJob, syncCbs, syncDeals, syncGtfs, syncParcelLayer, syncRenewal } from "./jobs";
import { SqliteProvider } from "./sqliteProvider";
import { loadSources, type SourcesConfig } from "./config";
import { geocode } from "./connectors/geocode";
import { startScheduler } from "./scheduler";
import { listDocuments, storeDocument } from "./documents";
import { caseListings, importAdvertPrint, listCaseAdverts } from "./caseAdverts";
import { importDeals, parseCsv } from "./dealsImport";
import { importTaxExport, relocateUnlocated } from "./taxImport";
import { createRequest, getRequest, listRequests, uploadToItem } from "./requests";

/** An upload is either multipart (field "file") or the raw file as the body. */
async function readUploadText(req: Request): Promise<string> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const f = (await req.formData()).get("file");
    if (!(f instanceof File)) throw new Error("file required");
    if (f.size > 20 * 1024 * 1024) throw new Error("file too large");
    return await f.text();
  }
  return await req.text();
}

async function importDealsFromCsv(db: ReturnType<typeof openDb>, req: Request, source: string) {
  return importDeals(db, parseCsv(await req.text()), source);
}

/** How old each source may get before /health reports it stale (hours). */
const MAX_AGE_H: Record<string, number> = { deals: 36, match: 36, gtfs: 8 * 24, renewal: 8 * 24, cbs: 40 * 24, backup: 36 };

export function health(db: ReturnType<typeof openDb>, cfg: SourcesConfig, now = new Date()) {
  const sources: Record<string, { lastOk: string | null; stale: boolean; lastError?: string }> = {};
  const check = (job: string, scope: string) => {
    const ok = lastRun(db, job, scope);
    const any = lastRun(db, job, scope, false);
    const ageH = ok ? (now.getTime() - Date.parse(ok.finished_at)) / 3_600_000 : Infinity;
    sources[scope === "*" ? job : `${job}:${scope}`] = {
      lastOk: ok?.finished_at ?? null,
      stale: ageH > (MAX_AGE_H[job] ?? 48),
      ...(any && !any.ok ? { lastError: JSON.parse(any.detail)?.error } : {}),
    };
  };
  for (const c of cfg.cities) ["deals", "match", "renewal"].forEach((j) => check(j, c.name));
  ["gtfs", "cbs", "backup"].forEach((j) => check(j, "*"));
  return { ok: true, cities: cfg.cities.map((c) => c.name), sources };
}

export function createServer(opts: { dbPath?: string; adminToken?: string; port?: number; sources?: SourcesConfig; scheduler?: boolean } = {}) {
  const db = openDb(opts.dbPath);
  const cfg = opts.sources ?? loadSources();
  const provider = new SqliteProvider(db, cfg);
  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN;
  const appFile = process.env.APP_FILE ?? "dist/index.html";

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const isAdmin = (req: Request) => !!adminToken && req.headers.get("authorization") === `Bearer ${adminToken}`;
  const cityByName = (name: string) => cfg.cities.find((c) => c.name === name);

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 8787),
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          return existsSync(appFile)
            ? new Response(Bun.file(appFile), { headers: { "content-type": "text/html; charset=utf-8" } })
            : new Response("App not built: run `bun run build`.", { status: 503 });
        }
        if (url.pathname === "/health") return json(health(db, cfg));

        if (url.pathname === "/api/geocode" && req.method === "GET") {
          const q = url.searchParams.get("q") ?? "";
          if (q.trim().length < 2) return json([]);
          return json(await geocode(q));
        }

        if (url.pathname === "/api/valuate" && req.method === "POST") {
          const body = (await req.json()) as { subject: Subject; facts?: ValuationFacts; date?: string; caseId?: string };
          if (!body?.subject?.location) return json({ error: "subject with location required" }, 400);
          const date = body.date ?? new Date().toISOString().slice(0, 10);
          const facts: ValuationFacts = { ...(body.facts ?? {}) };
          if (body.caseId && /^[A-Za-z0-9-]{16,64}$/.test(body.caseId)) facts.caseListings = caseListings(db, body.caseId, body.subject.address.city);
          return json(await valuate(body.subject, provider, date, facts));
        }

        const advRoute = url.pathname.match(/^\/api\/cases\/([A-Za-z0-9-]{16,64})\/adverts$/);
        if (advRoute) {
          const caseId = advRoute[1]!;
          if (req.method === "GET") return json(listCaseAdverts(db, caseId));
          if (req.method === "POST") {
            const city = url.searchParams.get("city") ?? undefined;
            const [stored, code] = await storeDocument(db, caseId, req, "advert_print");
            if (code !== 200) return json(stored, code);
            const doc = db.query(`SELECT path FROM documents WHERE id = ?`).get((stored as { id: string }).id) as { path: string };
            if (!/\.pdf$/i.test(doc.path)) return json({ error: "a PDF printed from Madlan or Yad2 is required" }, 415);
            return json(await importAdvertPrint(db, caseId, (stored as { id: string }).id, doc.path, city));
          }
        }

        const docRoute = url.pathname.match(/^\/api\/cases\/([A-Za-z0-9-]{16,64})\/documents$/);
        if (docRoute && req.method === "POST") {
          const [body, status] = await storeDocument(db, docRoute[1]!, req);
          return json(body, status);
        }
        if (docRoute && req.method === "GET") return json(listDocuments(db, docRoute[1]!));

        // Report requests: anyone may open one; its id is the capability to read it.
        if (url.pathname === "/api/requests" && req.method === "POST") {
          const b = (await req.json()) as { subject: Subject };
          if (!b?.subject?.address?.city) return json({ error: "subject with city required" }, 400);
          return json(createRequest(db, b.subject));
        }
        const reqRoute = url.pathname.match(/^\/api\/requests\/([0-9a-f-]{36})$/);
        if (reqRoute && req.method === "GET") {
          const r = getRequest(db, reqRoute[1]!);
          return r ? json(r) : json({ error: "not found" }, 404);
        }

        if (url.pathname.startsWith("/api/") && !isAdmin(req)) return json({ error: "unauthorised" }, 401);

        if (url.pathname === "/api/requests" && req.method === "GET") {
          return json(listRequests(db, url.searchParams.get("all") !== "1"));
        }
        const upRoute = url.pathname.match(/^\/api\/requests\/([0-9a-f-]{36})\/items\/([0-9a-f-]{36})\/upload$/);
        if (upRoute && req.method === "POST") {
          const text = await readUploadText(req);
          return json(await uploadToItem(db, upRoute[1]!, upRoute[2]!, text, cfg.layers.parcels));
        }
        if (url.pathname === "/api/tax/import" && req.method === "POST") {
          const text = await readUploadText(req);
          return json(await runJob(db, "tax-import", "*", () => importTaxExport(db, text, cfg.layers.parcels)));
        }

        if (url.pathname === "/api/deals/import" && req.method === "POST") {
          // CSV body (text/csv) or JSON { source, rows }
          const ct = req.headers.get("content-type") ?? "";
          const source = url.searchParams.get("source") ?? "import";
          if (ct.includes("csv") || ct.includes("text/plain")) {
            return json(await runJob(db, "deals-import", source, () => importDealsFromCsv(db, req, source)));
          }
          const b = (await req.json()) as { source?: string; rows: Record<string, unknown>[] };
          return json(await runJob(db, "deals-import", b.source ?? source, () => importDeals(db, b.rows ?? [], b.source ?? source)));
        }
        if (url.pathname === "/api/listings/import" && req.method === "POST") {
          return json(importFeed(db, (await req.json()) as ImportRequest));
        }
        const job = url.pathname.match(/^\/api\/jobs\/([a-z-]+)$/)?.[1];
        if (job && req.method === "POST") {
          const b = (await req.json().catch(() => ({}))) as { city?: string; lat?: number; lng?: number; radiusM?: number; sinceIso?: string };
          const area = b.city ? cityByName(b.city) : b.lat !== undefined ? { name: "adhoc", lat: b.lat, lng: b.lng!, radiusM: b.radiusM ?? 1500, district: "center" as const } : undefined;
          const scope = area?.name ?? "*";
          switch (job) {
            case "sync-deals":
            case "deals":
              if (!area) return json({ error: "city or lat/lng required" }, 400);
              return json(await runJob(db, "deals", scope, () => syncDeals(db, area)));
            case "match": {
              if (!area) return json({ error: "city or lat/lng required" }, 400);
              const since = b.sinceIso ?? new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
              return json(await runJob(db, "match", scope, () => rematch(db, area, since)));
            }
            case "renewal":
              if (!area) return json({ error: "city or lat/lng required" }, 400);
              return json(await runJob(db, "renewal", scope, () => syncRenewal(db, area, cfg.layers)));
            case "gtfs":
              return json(await runJob(db, "gtfs", "*", () => syncGtfs(db, cfg.gtfsUrl)));
            case "cbs":
              return json(await runJob(db, "cbs", "*", () => syncCbs(db, cfg.cities.map((c) => c.district), cfg.cbs.codes)));
            case "backup":
              return json(await runJob(db, "backup", "*", () => backup(db)));
            case "parcels":
              return json(await runJob(db, "parcels", "*", () => syncParcelLayer(db)));
            case "relocate":
              return json(await runJob(db, "relocate", "*", () => relocateUnlocated(db, cfg.layers.parcels)));
          }
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
  const timer = (opts.scheduler ?? process.env.SCHEDULER === "1") ? startScheduler(db, cfg) : undefined;
  return { server, db, stop: () => { if (timer) clearInterval(timer); server.stop(true); } };
}

if (import.meta.main) {
  const { server } = createServer();
  console.log(`Beit Shamai on http://localhost:${server.port}  (scheduler ${process.env.SCHEDULER === "1" ? "on" : "off"})`);
}
