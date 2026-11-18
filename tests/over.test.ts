import { describe, expect, test } from "bun:test";
import { openDb, dealsNear, upsertDeals } from "../server/db";
import { importTaxExport } from "../server/taxImport";
import { createRequest, getRequest, reconcileRequest, uploadToItem } from "../server/requests";
import { ensureParcelPoints } from "../server/connectors/parcelsOpen";
import { OverSession, finishOverSignIn, overConnected, parseRpcBody, resourceMetadataUrl, startOverSignIn } from "../server/connectors/over";
import { blocksNear, compareWithOver, overRowToDeal, pullBlock, pullOverForRequest, type OverRow } from "../server/overDeals";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";
import type { Subject } from "../src/engine/types";

const DAY = 86_400_000;
const at = { lat: 31.7745, lng: 35.2146 };
const subject = {
  ...DEMO_SUBJECT,
  address: { ...DEMO_SUBJECT.address, city: "ירושלים" },
  location: at,
  parcel: { block: "30079", parcel: "213" },
  area: { mode: "declared", area: 100 },
} as Subject;

/** Parcel points: blocks 30079 and 30077 near the subject, 40000 far away. */
function seedParcels(db: ReturnType<typeof openDb>) {
  ensureParcelPoints(db);
  const ins = db.prepare(`INSERT INTO parcel_points (block, parcel, lat, lng) VALUES (?, ?, ?, ?)`);
  for (const [b, p, dLat] of [[30079, 213, 0.0005], [30079, 199, 0.001], [30079, 110, 0.0012], [30077, 154, 0.004], [40000, 1, 0.05]] as const) {
    ins.run(b, p, at.lat + dLat, at.lng);
  }
  db.query(`INSERT INTO block_points (block, lat, lng, parcels) VALUES (30079, ?, ?, 3)`).run(at.lat + 0.001, at.lng);
}

/** A Tax Authority export with explicit rows: [gush-helka-sub, date, amount, fraction, area, rooms]. */
function exportOf(from: string, to: string, rows: [string, string, number, number, number, number][]) {
  const d = (iso: string) => iso.split("-").reverse().join("/");
  const head = `<b>סוג נכס:</b> דירת מגורים&nbsp<b>מיום מכירה:</b> ${d(from)}&nbsp<b>עד יום מכירה:</b> ${d(to)}&nbsp<br><b>שטח מ:</b> 75&nbsp<b>שטח עד:</b> 135&nbsp<br><b>ישוב: </b>ירושלים&nbsp<br/>קיימות ${rows.length} תוצאות`;
  const th = ["גוש חלקה", "יום מכירה", "תמורה מוצהרת בש&quot;ח", "שווי מכירה בש&quot;ח", "מהות", "חלק נמכר", "ישוב", "שנת בניה", "שטח", "חדרים"].map((h) => `<th>${h}</th>`).join("");
  const tr = rows.map(([g, date, amt, frac, area, rooms]) =>
    `<tr><td>${g}</td><td>${d(date)}</td><td>${amt.toLocaleString("en")}</td><td>${amt.toLocaleString("en")}</td><td>דירה בבית קומות</td><td>${frac}</td><td>ירושלים</td><td>1960</td><td>${area}</td><td>${rooms}</td></tr>`).join("");
  return `${head}<table><tr>${th}</tr>${tr}</table>`;
}

const overRow = (gush: number, helka: number, sub: string, date: string, amount: number, extra: Partial<OverRow> = {}): OverRow => ({
  gush: String(gush), helka: String(helka), sub_parcel: sub, date, amount, declared_amount: amount, nature: "דירה בבית קומות",
  area_sqm: 90, rooms: 3, year_built: 1960, portion_fraction: 1, settlement: "ירושלים", ...extra,
});

/** A fake Over: register stats, settlements and search_deals over a fixed row set, paged. */
function fakeOver(rows: OverRow[], calls: { name: string; args: any }[] = []) {
  return {
    async call(name: string, args: any) {
      calls.push({ name, args });
      if (name === "register_stats") return { stats: { dataset_id: "ds1", scraped_at: "2026-09-19 11:07:39+00", last_deal: "2026-09-17" } };
      if (name === "list_settlements") return { settlements: [{ settlement: "ירושלים", last_deal: "2026-08-24", resolved_code: 3000 }, { settlement: "מבשרת ירושלים", last_deal: "2026-09-10", resolved_code: 1015 }] };
      if (name === "search_deals") {
        const hit = rows.filter((r) => Number(r.gush) === args.gush && r.date >= args.date_from).sort((a, b) => a.date.localeCompare(b.date));
        return { data: hit.slice(args.offset, args.offset + args.limit), total: Math.min(hit.length, 10_000) };
      }
      throw new Error("unknown tool " + name);
    },
  };
}

describe("same sale, one id", () => {
  test("identical rows in an export are kept as separate sales", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const eight = Array.from({ length: 8 }, () => ["030079-0199-063-00", "2026-06-21", 533333, 0.111, 90, 3] as [string, string, number, number, number, number]);
    const r = await importTaxExport(db, exportOf("2026-06-01", "2026-06-30", eight), undefined);
    expect(r.stored).toBe(8);
    const ids = dealsNear(db, at.lat, at.lng, 2000).map((d) => d.id).sort();
    expect(ids[0]).toBe("tax-30079-199-63-2026-06-21-533333");
    expect(ids).toContain("tax-30079-199-63-2026-06-21-533333#8");
  });

  test("an Over row gets the same id as the uploaded row, and never overwrites it", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    await importTaxExport(db, exportOf("2026-06-01", "2026-06-30", [["030079-0213-021-00", "2026-06-18", 6333600, 1, 121, 5]]), undefined);
    const d = overRowToDeal(overRow(30079, 213, "021", "2026-06-18", 6333600), { ...at, approx: false });
    expect(d.id).toBe("tax-30079-213-21-2026-06-18-6333600");
    // sub-parcel 000 means no sub-parcel, as in the export
    expect(overRowToDeal(overRow(30079, 213, "000", "2026-06-03", 5e6), { ...at, approx: false }).parcel?.subParcel).toBeUndefined();
  });
});

describe("pulling Over by block", () => {
  test("blocks within the radius, not the far one", () => {
    const db = openDb(":memory:");
    seedParcels(db);
    expect(blocksNear(db, at.lat, at.lng, 1000)).toEqual([30077, 30079]);
  });

  test("pages to the end of a block (Over's total is not trusted)", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => overRow(30079, 1 + (i % 40), "001", "2026-03-01", 1_000_000 + i));
    const calls: any[] = [];
    const got = await pullBlock(fakeOver(rows, calls), 30079, "2025-11-01");
    expect(got.length).toBe(450);
    expect(calls.filter((c) => c.name === "search_deals").map((c) => c.args.offset)).toEqual([0, 200, 400]);
  });

  test("a request pulls every nearby block, keeps part-sales and 000 rows, counts other types, and shrinks the plan", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const rows = [
      overRow(30079, 110, "011", "2026-05-30", 4_200_000, { rooms: 3, area_sqm: 63 }),
      overRow(30079, 213, "021", "2026-06-18", 6_333_600, { rooms: 5, area_sqm: 121 }),
      overRow(30079, 199, "063", "2026-06-21", 533_333, { portion_fraction: 0.111 }), // Over keeps one of 8
      overRow(30077, 154, "027", "2026-06-01", 3_180_000, { rooms: 2.5, area_sqm: 65 }), // no address in Over
      overRow(30079, 213, "000", "2025-12-11", 24_090_000, { area_sqm: 268, rooms: 7 }),
      overRow(30079, 213, "005", "2026-04-01", 900_000, { nature: "חנות", rooms: null }),
      overRow(40000, 1, "001", "2026-06-01", 1_000_000), // far block: not pulled
    ];
    const req = createRequest(db, subject, "2026-11-18");
    const d = await pullOverForRequest(db, req.id, { session: fakeOver(rows), today: "2026-11-18", marginDays: 30 });
    expect(d.error).toBeUndefined();
    expect(d.blocks).toEqual([30077, 30079]);
    expect(d.rows).toBe(5);
    expect(d.excluded).toEqual({ "חנות": 1 });
    expect(d.cityLastDeal).toBe("2026-08-24"); // Jerusalem itself, not Mevaseret
    expect(d.through).toBe("2026-07-25"); // 24 Aug − 30 days
    const ids = dealsNear(db, at.lat, at.lng, 2000).map((x) => x.id);
    expect(ids).toContain("tax-30077-154-27-2026-06-01-3180000");
    expect(ids).toContain("tax-30079-199-63-2026-06-21-533333");
    expect(ids).toContain("tax-30079-213--2025-12-11-24090000");

    reconcileRequest(db, req.id, Date.parse("2026-11-18") / DAY);
    const r = getRequest(db, req.id)!;
    const live = r.items.filter((i) => i.status !== "split");
    const over = live.filter((i) => i.status === "over");
    const pending = live.filter((i) => i.status === "pending");
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((i) => i.to <= "2026-07-25")).toBe(true);
    expect(pending.every((i) => i.from >= "2026-07-26")).toBe(true);
    expect(pending.some((i) => i.from === "2026-07-26")).toBe(true); // the search that straddled the date was split
    expect(r.status).toBe("preliminary");
    expect(r.over?.status).toBe("done");

    // Uploading the months after Over's cover makes the report final.
    for (const it of pending) {
      await uploadToItem(db, req.id, it.id, exportOf(it.from, it.to, [["030079-0105-020-00", "2026-08-30", 3_424_000, 1, 63, 2]].filter(() => it.from <= "2026-08-30" && it.to >= "2026-08-30") as any), undefined);
    }
    expect(getRequest(db, req.id)!.status).toBe("final");
  });

  test("a second request near the same blocks uses the cached pull", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const calls: any[] = [];
    const s = fakeOver([overRow(30079, 213, "021", "2026-06-18", 6_333_600)], calls);
    const a = createRequest(db, subject, "2026-11-18");
    await pullOverForRequest(db, a.id, { session: s, today: "2026-11-18" });
    const n = calls.filter((c) => c.name === "search_deals").length;
    const b = createRequest(db, subject, "2026-11-18");
    const d = await pullOverForRequest(db, b.id, { session: s, today: "2026-11-18" });
    expect(calls.filter((c) => c.name === "search_deals").length).toBe(n);
    expect(d.blocksCached).toBe(2);
    expect(d.rows).toBe(1);
  });

  test("a failed pull leaves the plan as it was", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const req = createRequest(db, subject, "2026-11-18");
    const d = await pullOverForRequest(db, req.id, { session: { call: async () => { throw new Error("Over: HTTP 503"); } }, today: "2026-11-18" });
    expect(d.error).toContain("503");
    reconcileRequest(db, req.id, Date.parse("2026-11-18") / DAY);
    expect(getRequest(db, req.id)!.items.some((i) => i.status === "over")).toBe(false);
  });
});

describe("upload against Over", () => {
  test("Yirmiyahu case: missing, merged and newer rows are found", async () => {
    const db = openDb(":memory:");
    seedParcels(db);
    const req = createRequest(db, subject, "2026-11-18");
    await pullOverForRequest(db, req.id, {
      session: fakeOver([
        overRow(30079, 110, "011", "2026-05-30", 4_200_000),
        overRow(30079, 213, "021", "2026-06-18", 6_333_600),
        overRow(30079, 199, "063", "2026-06-21", 533_333, { portion_fraction: 0.111 }),
        overRow(30077, 154, "027", "2026-06-01", 3_180_000),
      ]),
      today: "2026-11-18",
    });
    const file = exportOf("2026-05-18", "2026-11-18", [
      ["030079-0110-011-00", "2026-05-30", 4_200_000, 1, 63, 3],
      ["030079-0213-021-00", "2026-06-18", 6_333_600, 1, 121, 5],
      ["030077-0154-027-00", "2026-06-01", 3_180_000, 1, 65, 2.5],
      ...Array.from({ length: 8 }, () => ["030079-0199-063-00", "2026-06-21", 533_333, 0.111, 90, 3] as [string, string, number, number, number, number]),
      ["030079-0213-000-00", "2026-06-03", 5_000_000, 1, 98, 4],
      ["030079-0105-020-00", "2026-08-30", 3_424_000, 1, 63, 2],
    ]);
    await importTaxExport(db, file, undefined);
    const c = compareWithOver(db, req.id)!;
    expect(c.matched).toBe(4);
    expect(c.missing.map((x) => x.parcel)).toEqual(["30079/213"]);
    expect(c.merged).toEqual([expect.objectContaining({ parcel: "30079/199/63", copies: 8 })]);
    expect(c.newer.map((x) => x.date)).toEqual(["2026-08-30"]);
  });
});

describe("Over sign-in and calls", () => {
  /** A fake over.org.il: OAuth discovery, client registration, tokens and an MCP endpoint answering in SSE. */
  function fakeServer() {
    const log: { url: string; body?: string; auth?: string | null }[] = [];
    let token = "tok-1";
    const f = (async (url: string, init: RequestInit = {}) => {
      const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined;
      const auth = new Headers(init.headers).get("authorization");
      log.push({ url, body, auth });
      const u = new URL(url);
      const j = (v: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...h } });
      if (u.pathname === "/deals/mcp") {
        if (auth !== `Bearer ${token}`) return j({ error: "invalid_token" }, 401, { "www-authenticate": `Bearer realm="over-mcp", resource_metadata="https://www.over.org.il/.well-known/oauth-protected-resource/deals/mcp"` });
        const m = JSON.parse(body!);
        if (!("id" in m)) return new Response(null, { status: 202 });
        const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : { content: [{ type: "text", text: JSON.stringify({ data: [{ gush: "30079", tool: m.params.name }] }) }] };
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1" } });
      }
      if (u.pathname === "/.well-known/oauth-protected-resource/deals/mcp") return j({ resource: "https://www.over.org.il/deals/mcp", authorization_servers: ["https://www.over.org.il"] });
      if (u.pathname === "/.well-known/oauth-authorization-server") return j({ authorization_endpoint: "https://www.over.org.il/oauth/authorize", token_endpoint: "https://www.over.org.il/oauth/token", registration_endpoint: "https://www.over.org.il/oauth/register" });
      if (u.pathname === "/oauth/register") return j({ client_id: "client-123" }, 201);
      if (u.pathname === "/oauth/token") {
        const p = new URLSearchParams(body);
        if (p.get("grant_type") === "authorization_code" && p.get("code") === "good" && p.get("code_verifier")) return j({ access_token: token, refresh_token: "ref-1", expires_in: 3600 });
        if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "ref-1") return j({ access_token: token, expires_in: 3600 });
        return j({ error: "invalid_grant" }, 400);
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { f, log, rotate: (t: string) => { token = t; } };
  }

  test("reads resource_metadata from a 401", () => {
    expect(resourceMetadataUrl(`Bearer realm="over-mcp", error="invalid_token", resource_metadata="https://x/.well-known/a"`)).toBe("https://x/.well-known/a");
  });

  test("parses an SSE reply", () => {
    expect(parseRpcBody(`event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":1}}\n\n`, "text/event-stream", 7).result).toEqual({ ok: 1 });
  });

  test("sign in with PKCE, call a tool, refresh on 401", async () => {
    const db = openDb(":memory:");
    const s = fakeServer();
    const { url } = await startOverSignIn(db, "https://app.example/api/over/callback", { fetchImpl: s.f });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.over.org.il/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("client-123");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("resource")).toBe("https://www.over.org.il/deals/mcp");
    await expect(finishOverSignIn(db, "good", "wrong-state", { fetchImpl: s.f })).rejects.toThrow("expired");
    await finishOverSignIn(db, "good", u.searchParams.get("state")!, { fetchImpl: s.f });
    expect(overConnected(db).connected).toBe(true);

    const session = new OverSession(db, { fetchImpl: s.f });
    expect(await session.call("search_deals", { gush: 30079 })).toEqual({ data: [{ gush: "30079", tool: "search_deals" }] });

    s.rotate("tok-2"); // the server stops accepting the old token; a refresh hands out the new one
    const before = s.log.filter((l) => l.url.endsWith("/oauth/token")).length;
    expect(await session.call("search_deals", { gush: 1 })).toEqual({ data: [{ gush: "30079", tool: "search_deals" }] });
    expect(s.log.filter((l) => l.url.endsWith("/oauth/token")).length).toBe(before + 1);
  });
});
