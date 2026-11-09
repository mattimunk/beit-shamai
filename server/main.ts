/**
 * Beit Shamai API server (Bun). Serves the web app and the API.
 *
 *   GET  /                         the web app (dist/index.html, built by `bun run build`)
 *   GET  /health                   status and data freshness per source
 *   GET  /api/geocode?q=...        address search (GovMap)
 *   POST /api/cases/:caseId/documents  upload one document (multipart: file, kind)
 *   GET  /api/cases/:caseId/documents  list a case's documents
 *   POST /api/valuate              { subject, facts?, date?, caseId? } → ValuationResult
 *   GET  /api/parcel-at?lat&lng    nearest parcels (suggested block/parcel for an address)
 *   POST /api/cases/:caseId/adverts   Madlan/Yad2 print-to-PDF (multipart: file) → cards read
 *   GET  /api/cases/:caseId/adverts   the case's adverts and whether each is used
 *   POST /api/auth/code              { email, lang? } – send a sign-in code
 *   POST /api/auth/verify            { email, code } – sign in (session cookie)
 *   POST /api/auth/logout
 *   GET  /api/me                     signed-in user (+ isAdmin) or 401
 *   PUT  /api/me                     profile: name, phone, role, agency, license, marketingConsent
 *   GET  /api/my/cases               the signed-in user's property files
 *   POST /api/cases/:caseId/submit   owner sends the property for review (opens the data request)
 *   GET  /api/admin/cases?status=    all property files (pipeline)                     [admin]
 *   PUT  /api/admin/cases/:caseId    { status }                                         [admin]
 *   GET  /api/cases?ids=a,b          summaries of property files (the browser's own list)
 *   GET  /api/cases/:caseId          a property file (its id is its key)
 *   PUT  /api/cases/:caseId          { subject } – create or update a property file
 *   POST /api/cases/:caseId/capture-link   new filming link (48 h; replaces earlier ones)
 *   DELETE /api/cases/:caseId/capture-link revoke filming links
 *   GET  /api/t/:token               what a filming link opens (address, rooms to film)
 *   …    /api/t/:token/capture…      filming routes for that property only
 *   GET  /api/cases/:caseId/capture   visit layout + captured shots (frames for the report)
 *   PUT  /api/cases/:caseId/capture   { layout } – bedrooms, bathrooms, balconies…
 *   POST /api/cases/:caseId/capture/:shotId   one video or photo (multipart: file)
 *   GET  /api/cases/:caseId/frames/:name      a report frame (JPEG)
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
import { parcelsNear } from "./connectors/parcelsOpen";
import { captureLinkCase, newCaptureLink, revokeCaptureLinks } from "./cases";
import { tourLayout, upgradeDossier, type Dossier } from "../src/dossier/schema";
import { adoptOrphans, allCases, caseSummaries, getCase, saveCase, setCaseStatus, userCases, CASE_STATUSES, type CaseStatus } from "./cases";
import { adminEmails, endSession, isAdminUser, requestCode, sessionCookie, sessionUser, updateProfile, verifyCode, type ProfileInput } from "./auth";
import { sendMail } from "./mailer";
import { MAX_CAPTURE_BYTES, framePath, getLayout, listCaptures, saveLayout, storeCapture, type Layout } from "./capture";
import { importDeals, parseCsv } from "./dealsImport";
import { importTaxExport, relocateUnlocated } from "./taxImport";
import { createRequest, ensureRequestTables, getRequest, listRequests, reconcileAll, uploadToItem } from "./requests";

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
  // Admin: the server's admin token (scripts, the data-requests inbox) or a signed-in admin.
  const isAdmin = (req: Request) =>
    (!!adminToken && req.headers.get("authorization") === `Bearer ${adminToken}`) || isAdminUser(sessionUser(db, req));
  const cityByName = (name: string) => cfg.cities.find((c) => c.name === name);

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 8787),
    maxRequestBodySize: MAX_CAPTURE_BYTES + 1024 * 1024, // visit videos
    async fetch(req) {
      let url = new URL(req.url);
      // Filming links: /api/t/<token>/capture… act on that one property's filming only.
      let tokenCase: string | null = null;
      const tok = url.pathname.match(/^\/api\/t\/([A-Za-z0-9_-]{16,40})(\/.*)?$/);
      if (tok) {
        tokenCase = captureLinkCase(db, tok[1]!);
        if (!tokenCase) return json({ error: "link expired or replaced" }, 410);
        const rest = tok[2] ?? "";
        if (!rest) {
          const c = getCase(db, tokenCase);
          if (!c) return json({ error: "not found" }, 404);
          const a = c.subject.address;
          return json({
            appNo: c.appNo,
            address: [a.street, a.number].filter(Boolean).join(" ") + (a.city ? `, ${a.city}` : ""),
            layout: c.dossier ? tourLayout(c.dossier) : null,
            skipped: c.dossier?.tourSkipped ?? [],
          });
        }
        if (!/^\/(capture(\/[a-z]+(-\d{1,2})?)?|frames\/[^/]+)$/.test(rest)) return json({ error: "not found" }, 404);
        url = new URL(`/api/cases/${tokenCase}${rest}${url.search}`, url);
      }
      /** Who may open a property file: its owner, an admin, a filming link (filming only), or
       * anyone while the file has no owner yet (a new, unsaved file or one from before accounts). */
      const canAccess = (caseId: string, filming = false): boolean => {
        if (filming && tokenCase === caseId) return true;
        if (tokenCase) return false;
        const c = getCase(db, caseId);
        if (!c || !c.ownerId) return true;
        const u = sessionUser(db, req);
        return !!u && (u.id === c.ownerId || isAdminUser(u));
      };
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

        if (url.pathname === "/api/parcel-at" && req.method === "GET") {
          const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "lat and lng required" }, 400);
          return json(parcelsNear(db, lat, lng));
        }

        if (url.pathname === "/api/valuate" && req.method === "POST") {
          const body = (await req.json()) as { subject: Subject; facts?: ValuationFacts; date?: string; caseId?: string };
          if (!body?.subject?.location) return json({ error: "subject with location required" }, 400);
          const date = body.date ?? new Date().toISOString().slice(0, 10);
          const facts: ValuationFacts = { ...(body.facts ?? {}) };
          if (body.caseId && /^[A-Za-z0-9-]{16,64}$/.test(body.caseId)) facts.caseListings = caseListings(db, body.caseId, body.subject.address.city);
          return json(await valuate(body.subject, provider, date, facts));
        }

        // ---- Accounts ------------------------------------------------------------------------
        if (url.pathname === "/api/auth/code" && req.method === "POST") {
          const b = (await req.json()) as { email?: string; lang?: "he" | "en" };
          try { return json(await requestCode(db, b.email ?? "", b.lang === "en" ? "en" : "he")); }
          catch (e) { return json({ error: (e as Error).message }, 400); }
        }
        if (url.pathname === "/api/auth/verify" && req.method === "POST") {
          const b = (await req.json()) as { email?: string; code?: string };
          try {
            const r = verifyCode(db, b.email ?? "", b.code ?? "");
            return new Response(JSON.stringify({ user: r.user, isNew: r.isNew, isAdmin: isAdminUser(r.user) }), {
              headers: { "content-type": "application/json; charset=utf-8", "set-cookie": sessionCookie(r.token, req) },
            });
          } catch (e) { return json({ error: (e as Error).message }, 400); }
        }
        if (url.pathname === "/api/auth/logout" && req.method === "POST") {
          endSession(db, req);
          return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": sessionCookie("", req, true) } });
        }
        if (url.pathname === "/api/me") {
          const u = sessionUser(db, req);
          if (!u) return json({ error: "not signed in" }, 401);
          if (req.method === "PUT") return json({ user: updateProfile(db, u.id, (await req.json()) as ProfileInput), isAdmin: isAdminUser(u) });
          return json({ user: u, isAdmin: isAdminUser(u) });
        }
        if (url.pathname === "/api/my/cases" && req.method === "GET") {
          const u = sessionUser(db, req);
          if (!u) return json({ error: "not signed in" }, 401);
          if (isAdminUser(u)) { ensureRequestTables(db); adoptOrphans(db, u.id); } // files from before accounts
          return json(userCases(db, u.id));
        }
        const submitRoute = url.pathname.match(/^\/api\/cases\/([A-Za-z0-9-]{16,64})\/submit$/);
        if (submitRoute && req.method === "POST") {
          const u = sessionUser(db, req);
          if (!u) return json({ error: "not signed in" }, 401);
          const c = getCase(db, submitRoute[1]!);
          if (!c) return json({ error: "not found" }, 404);
          if (c.ownerId && c.ownerId !== u.id && !isAdminUser(u)) return json({ error: "not your property" }, 403);
          if (!c.ownerId) saveCase(db, c.id, c.subject, u.id);
          if (c.status === "draft") setCaseStatus(db, c.id, "submitted");
          // Open the Tax Authority data request for it (once).
          ensureRequestTables(db);
          const existing = db.query(`SELECT id FROM requests WHERE case_id = ? LIMIT 1`).get(c.id) as { id: string } | null;
          const request = existing ? getRequest(db, existing.id, true) : c.subject.address.city ? createRequest(db, c.subject, undefined, c.id) : null;
          const addr = [c.subject.address.street, c.subject.address.number].filter(Boolean).join(" ") + (c.subject.address.city ? `, ${c.subject.address.city}` : "");
          for (const to of adminEmails()) {
            sendMail({ to, subject: `נכס חדש הוגש: ${addr}`, text: `נכס חדש הוגש לבדיקה.\n\nכתובת: ${addr}\nמגיש: ${u.name ?? ""} <${u.email}> (${u.role ?? "—"})\n\nהיכנסו לאזור הניהול כדי לטפל.` }).catch(() => {});
          }
          return json({ case: getCase(db, c.id), request });
        }
        if (url.pathname === "/api/admin/cases" && req.method === "GET") {
          if (!isAdmin(req)) return json({ error: "unauthorised" }, 401);
          const adminUser = sessionUser(db, req);
          if (adminUser && isAdminUser(adminUser)) { ensureRequestTables(db); adoptOrphans(db, adminUser.id); }
          const st = url.searchParams.get("status") as CaseStatus | null;
          return json(allCases(db, st && CASE_STATUSES.includes(st) ? st : undefined));
        }
        const adminCaseRoute = url.pathname.match(/^\/api\/admin\/cases\/([A-Za-z0-9-]{16,64})$/);
        if (adminCaseRoute && req.method === "PUT") {
          if (!isAdmin(req)) return json({ error: "unauthorised" }, 401);
          const b = (await req.json()) as { status?: CaseStatus };
          if (!b.status || !CASE_STATUSES.includes(b.status)) return json({ error: "bad status" }, 400);
          setCaseStatus(db, adminCaseRoute[1]!, b.status);
          return json(getCase(db, adminCaseRoute[1]!));
        }

        if (url.pathname === "/api/cases" && req.method === "GET") {
          return json(caseSummaries(db, (url.searchParams.get("ids") ?? "").split(",").filter(Boolean)));
        }
        const caseRoute = url.pathname.match(/^\/api\/cases\/([A-Za-z0-9-]{16,64})$/);
        if (caseRoute && !canAccess(caseRoute[1]!)) return json({ error: "no access to this property" }, 403);
        if (caseRoute) {
          if (req.method === "GET") {
            const c = getCase(db, caseRoute[1]!);
            if (!c) return json({ error: "not found" }, 404);
            // Its latest order, so the report shows preliminary / final.
            ensureRequestTables(db);
            const r = db.query(`SELECT id FROM requests WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`).get(c.id) as { id: string } | null;
            return json({ ...c, request: r ? getRequest(db, r.id, true) : null });
          }
          if (req.method === "PUT") {
            const b = (await req.json()) as { subject: Subject; dossier?: Dossier };
            if (!b?.subject?.address) return json({ error: "subject required" }, 400);
            return json(saveCase(db, caseRoute[1]!, b.subject, sessionUser(db, req)?.id, b.dossier ? upgradeDossier(b.dossier) : undefined));
          }
        }

        const capRoute = url.pathname.match(/^\/api\/cases\/([A-Za-z0-9-]{16,64})\/capture(?:\/([a-z]+(?:-\d{1,2})?))?$/);
        if (capRoute && !canAccess(capRoute[1]!, true)) return json({ error: "no access to this property" }, 403);
        if (capRoute) {
          const caseId = capRoute[1]!, shotId = capRoute[2];
          if (!shotId && req.method === "GET") return json({ layout: getLayout(db, caseId), captures: listCaptures(db, caseId) });
          if (!shotId && req.method === "PUT") {
            const b = (await req.json()) as { layout?: Layout; skip?: string; skipped?: boolean };
            if (b?.skip && /^[a-z]+(-\d{1,2})?$/.test(b.skip)) {
              // "Skip for now" on a tour step, kept in the dossier.
              const c = getCase(db, caseId);
              if (!c) return json({ error: "not found" }, 404);
              const d = upgradeDossier(c.dossier);
              d.tourSkipped = b.skipped ? [...new Set([...d.tourSkipped, b.skip])] : d.tourSkipped.filter((x) => x !== b.skip);
              db.query(`UPDATE cases SET dossier = ? WHERE id = ?`).run(JSON.stringify(d), caseId);
              return json({ skipped: d.tourSkipped });
            }
            if (!b?.layout) return json({ error: "layout required" }, 400);
            saveLayout(db, caseId, b.layout);
            return json({ ok: true });
          }
          if (shotId && req.method === "POST") {
            const f = (await req.formData()).get("file");
            if (!(f instanceof File)) return json({ error: "file required" }, 400);
            try { return json(await storeCapture(db, caseId, shotId, f)); } catch (e) { return json({ error: (e as Error).message }, 400); }
          }
        }
        const frameRoute = url.pathname.match(/^\/api\/cases\/([A-Za-z0-9-]{16,64})\/frames\/([^/]+)$/);
        if (frameRoute && !canAccess(frameRoute[1]!, true)) return json({ error: "no access to this property" }, 403);
        if (frameRoute && req.method === "GET") {
          const p = framePath(frameRoute[1]!, frameRoute[2]!);
          if (!p || !existsSync(p)) return json({ error: "not found" }, 404);
          return new Response(Bun.file(p), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
        }

        const advRoute = url.pathname.match(/^\/api\/cases\/([A-Za-z0-9-]{16,64})\/adverts$/);
        if (advRoute && !canAccess(advRoute[1]!)) return json({ error: "no access to this property" }, 403);
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
        if (docRoute && !canAccess(docRoute[1]!)) return json({ error: "no access to this property" }, 403);
        // New filming link (QR / WhatsApp) for a property; earlier links stop working.
        const linkRoute = url.pathname.match(/^\/api\/cases\/([A-Za-z0-9-]{16,64})\/capture-link$/);
        if (linkRoute && req.method === "POST") {
          if (tokenCase || !canAccess(linkRoute[1]!)) return json({ error: "no access to this property" }, 403);
          if (!getCase(db, linkRoute[1]!)) return json({ error: "save the property first" }, 400);
          const l = newCaptureLink(db, linkRoute[1]!);
          return json({ ...l, path: `/?film=${l.token}` });
        }
        if (linkRoute && req.method === "DELETE") {
          if (tokenCase || !canAccess(linkRoute[1]!)) return json({ error: "no access to this property" }, 403);
          revokeCaptureLinks(db, linkRoute[1]!);
          return json({ ok: true });
        }
        if (docRoute && req.method === "POST") {
          const [body, status] = await storeDocument(db, docRoute[1]!, req);
          return json(body, status);
        }
        if (docRoute && req.method === "GET") return json(listDocuments(db, docRoute[1]!));

        // Report requests: anyone may open one; its id is the capability to read it.
        if (url.pathname === "/api/requests" && req.method === "POST") {
          const b = (await req.json()) as { subject: Subject; caseId?: string };
          if (!b?.subject?.address?.city) return json({ error: "subject with city required" }, 400);
          const caseId = b.caseId && /^[A-Za-z0-9-]{16,64}$/.test(b.caseId) ? b.caseId : undefined;
          return json(createRequest(db, b.subject, undefined, caseId));
        }
        const reqRoute = url.pathname.match(/^\/api\/requests\/([0-9a-f-]{36})$/);
        if (reqRoute && req.method === "GET") {
          const r = getRequest(db, reqRoute[1]!, true);
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
          const out = await runJob(db, "tax-import", "*", () => importTaxExport(db, text, cfg.layers.parcels));
          reconcileAll(db);
          return json(out);
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
