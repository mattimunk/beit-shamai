/**
 * Client for over.org.il ("גרסאות לעם"), which mirrors the Tax Authority deals register and
 * serves it over MCP (JSON-RPC over HTTP) behind OAuth 2.1 with a Google sign-in.
 *
 * The server signs in once on an admin's behalf:
 *   1. startOverSignIn: discover the authorisation server (RFC 9728 / RFC 8414), register this
 *      server as a client (dynamic client registration, no secret), and build the sign-in link
 *      with PKCE. The admin opens it and signs in with Google on over.org.il.
 *   2. finishOverSignIn: over.org.il redirects back to /api/over/callback with a code, which is
 *      exchanged for an access token and a refresh token, kept in `over_auth`.
 *   3. callOverTool: calls a tool (initialize → tools/call), refreshing the token when needed.
 *
 * Nothing about the admin's Google account is stored; only Over's tokens for this server.
 */
import type { Database } from "bun:sqlite";

export const OVER_DEALS_MCP = process.env.OVER_MCP_URL ?? "https://www.over.org.il/deals/mcp";

export interface OverFetch {
  fetchImpl?: typeof fetch;
  proxy?: string;
}

interface AuthRow {
  client_id: string | null;
  client_secret: string | null;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  redirect_uri: string | null;
  scope: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  connected_at: string | null;
}

export function ensureOverTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS over_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1), client_id TEXT, client_secret TEXT, authorization_endpoint TEXT,
      token_endpoint TEXT, redirect_uri TEXT, scope TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, connected_at TEXT
    );
    CREATE TABLE IF NOT EXISTS over_signin (state TEXT PRIMARY KEY, verifier TEXT, at INTEGER);
  `);
}

const getAuth = (db: Database): AuthRow | null => {
  ensureOverTables(db);
  return db.query(`SELECT * FROM over_auth WHERE id = 1`).get() as AuthRow | null;
};

export function overConnected(db: Database): { connected: boolean; connectedAt?: string } {
  const a = getAuth(db);
  return a?.refresh_token || a?.access_token ? { connected: true, connectedAt: a.connected_at ?? undefined } : { connected: false };
}

export function disconnectOver(db: Database) {
  ensureOverTables(db);
  db.exec(`DELETE FROM over_auth; DELETE FROM over_signin;`);
}

const doFetch = (o: OverFetch, url: string, init: RequestInit = {}) => {
  const req: RequestInit & { proxy?: string } = { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) };
  if (o.proxy) req.proxy = o.proxy;
  return (o.fetchImpl ?? fetch)(url, req);
};

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function challengeOf(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** resource_metadata="…" from a WWW-Authenticate header. */
export function resourceMetadataUrl(header: string | null): string | undefined {
  return header?.match(/resource_metadata="([^"]+)"/)?.[1];
}

async function getJson(o: OverFetch, url: string): Promise<any | null> {
  try {
    const r = await doFetch(o, url, { headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Find the authorisation server's endpoints for the Over MCP server. */
export async function discoverOverAuth(o: OverFetch = {}, mcpUrl = OVER_DEALS_MCP) {
  const mcp = new URL(mcpUrl);
  // 1. Protected-resource metadata: from the 401's header, else the well-known paths.
  let prm: any = null;
  try {
    const r = await doFetch(o, mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }) });
    const hinted = resourceMetadataUrl(r.headers.get("www-authenticate"));
    if (hinted) prm = await getJson(o, hinted);
  } catch { /* fall through to well-known paths */ }
  prm ??= (await getJson(o, `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname}`)) ?? (await getJson(o, `${mcp.origin}/.well-known/oauth-protected-resource`));
  const issuer: string = prm?.authorization_servers?.[0] ?? mcp.origin;
  // 2. Authorisation-server metadata (RFC 8414, then OpenID discovery).
  const iss = new URL(issuer);
  const path = iss.pathname === "/" ? "" : iss.pathname;
  const asm =
    (await getJson(o, `${iss.origin}/.well-known/oauth-authorization-server${path}`)) ??
    (await getJson(o, `${iss.origin}/.well-known/openid-configuration${path}`)) ??
    (await getJson(o, `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`));
  if (!asm?.authorization_endpoint || !asm?.token_endpoint) throw new Error("Over: could not find its sign-in endpoints");
  const scopes: string[] = prm?.scopes_supported ?? asm?.scopes_supported ?? [];
  return {
    authorization_endpoint: asm.authorization_endpoint as string,
    token_endpoint: asm.token_endpoint as string,
    registration_endpoint: asm.registration_endpoint as string | undefined,
    scope: scopes.length ? scopes.join(" ") : undefined,
    resource: (prm?.resource as string | undefined) ?? mcpUrl,
  };
}

/** Step 1: returns the link the admin opens to sign in to Over. */
export async function startOverSignIn(db: Database, redirectUri: string, o: OverFetch = {}): Promise<{ url: string }> {
  ensureOverTables(db);
  const meta = await discoverOverAuth(o);
  let a = getAuth(db);
  if (!a?.client_id || a.redirect_uri !== redirectUri || a.token_endpoint !== meta.token_endpoint) {
    if (!meta.registration_endpoint) throw new Error("Over: no client registration endpoint; ask Over for a client id (OVER_CLIENT_ID)");
    let client: any;
    if (process.env.OVER_CLIENT_ID) {
      client = { client_id: process.env.OVER_CLIENT_ID, client_secret: process.env.OVER_CLIENT_SECRET };
    } else {
      const r = await doFetch(o, meta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "Beit Shamai appraisal server",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          ...(meta.scope ? { scope: meta.scope } : {}),
        }),
      });
      if (!r.ok) throw new Error(`Over: client registration failed (HTTP ${r.status}) ${(await r.text()).slice(0, 200)}`);
      client = await r.json();
    }
    db.query(
      `INSERT INTO over_auth (id, client_id, client_secret, authorization_endpoint, token_endpoint, redirect_uri, scope)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, client_secret = excluded.client_secret,
         authorization_endpoint = excluded.authorization_endpoint, token_endpoint = excluded.token_endpoint,
         redirect_uri = excluded.redirect_uri, scope = excluded.scope`,
    ).run(client.client_id, client.client_secret ?? null, meta.authorization_endpoint, meta.token_endpoint, redirectUri, meta.scope ?? null);
    a = getAuth(db);
  }
  const state = randomToken(24);
  const verifier = randomToken(48);
  db.query(`DELETE FROM over_signin WHERE at < ?`).run(Date.now() - 30 * 60_000);
  db.query(`INSERT INTO over_signin (state, verifier, at) VALUES (?, ?, ?)`).run(state, verifier, Date.now());
  const p = new URLSearchParams({
    response_type: "code",
    client_id: a!.client_id!,
    redirect_uri: redirectUri,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: "S256",
    state,
    resource: meta.resource,
  });
  if (a!.scope) p.set("scope", a!.scope);
  return { url: `${a!.authorization_endpoint}${a!.authorization_endpoint!.includes("?") ? "&" : "?"}${p}` };
}

async function tokenRequest(db: Database, o: OverFetch, form: Record<string, string>) {
  const a = getAuth(db)!;
  const body = new URLSearchParams({ ...form, client_id: a.client_id!, resource: OVER_DEALS_MCP });
  if (a.client_secret) body.set("client_secret", a.client_secret);
  const r = await doFetch(o, a.token_endpoint!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  const text = await r.text();
  if (!r.ok) throw new Error(`Over: token request failed (HTTP ${r.status}) ${text.slice(0, 200)}`);
  const t = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
  db.query(`UPDATE over_auth SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, connected_at = COALESCE(connected_at, ?) WHERE id = 1`).run(
    t.access_token, t.refresh_token ?? null, t.expires_in ? Date.now() + t.expires_in * 1000 : null, new Date().toISOString(),
  );
  return t.access_token;
}

/** Step 2: the callback. Throws on a wrong or expired state. */
export async function finishOverSignIn(db: Database, code: string, state: string, o: OverFetch = {}) {
  ensureOverTables(db);
  const s = db.query(`SELECT verifier, at FROM over_signin WHERE state = ?`).get(state) as { verifier: string; at: number } | null;
  if (!s || s.at < Date.now() - 30 * 60_000) throw new Error("sign-in link expired; start again");
  db.query(`DELETE FROM over_signin WHERE state = ?`).run(state);
  const a = getAuth(db);
  if (!a?.redirect_uri) throw new Error("sign-in was not started");
  db.query(`UPDATE over_auth SET connected_at = NULL WHERE id = 1`).run();
  await tokenRequest(db, o, { grant_type: "authorization_code", code, redirect_uri: a.redirect_uri, code_verifier: s.verifier });
}

async function accessToken(db: Database, o: OverFetch, forceRefresh = false): Promise<string> {
  const a = getAuth(db);
  if (!a?.access_token && !a?.refresh_token) throw new OverNotConnected();
  const fresh = a.access_token && (!a.expires_at || a.expires_at > Date.now() + 60_000);
  if (fresh && !forceRefresh) return a.access_token!;
  if (!a.refresh_token) throw new OverNotConnected("Over sign-in expired; connect again");
  return tokenRequest(db, o, { grant_type: "refresh_token", refresh_token: a.refresh_token });
}

export class OverNotConnected extends Error {
  constructor(msg = "Over is not connected") { super(msg); this.name = "OverNotConnected"; }
}

/** The JSON-RPC message with this id, from a JSON or an SSE (text/event-stream) body. */
export function parseRpcBody(text: string, contentType: string | null, id: number): any {
  if (contentType?.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg?.id === id) return msg;
      } catch { /* not JSON */ }
    }
    throw new Error("Over: no reply in the event stream");
  }
  const msg = JSON.parse(text);
  return Array.isArray(msg) ? msg.find((m) => m?.id === id) : msg;
}

/** A tool result's JSON: structuredContent, else the first text block parsed as JSON. */
export function toolPayload(result: any): any {
  if (result?.isError) {
    const msg = result?.content?.find((c: any) => c.type === "text")?.text ?? "tool error";
    throw new Error(`Over: ${String(msg).slice(0, 300)}`);
  }
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((c: any) => c.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Over: empty tool result");
  return JSON.parse(text);
}

/** A session with the Over MCP server; reuse it for a batch of calls. */
export class OverSession {
  private sessionId?: string;
  private nextId = 1;
  private ready = false;
  constructor(private db: Database, private o: OverFetch = {}, private url = OVER_DEALS_MCP) {}

  private async post(body: unknown, token: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-06-18",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return doFetch(this.o, this.url, { method: "POST", headers, body: JSON.stringify(body) });
  }

  /** One JSON-RPC request; refreshes the token once on 401 and re-opens a lost session once. */
  private async rpc(method: string, params: unknown, retried = false): Promise<any> {
    const id = this.nextId++;
    let token = await accessToken(this.db, this.o);
    let res = await this.post({ jsonrpc: "2.0", id, method, params }, token);
    if (res.status === 401 && !retried) {
      token = await accessToken(this.db, this.o, true);
      res = await this.post({ jsonrpc: "2.0", id, method, params }, token);
    }
    if (res.status === 401) throw new OverNotConnected("Over refused the sign-in; connect again");
    if (res.status === 404 && this.sessionId && !retried && method !== "initialize") {
      // Session expired on Over's side: start a new one.
      this.sessionId = undefined;
      this.ready = false;
      await this.init();
      return this.rpc(method, params, true);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Over: HTTP ${res.status} ${text.slice(0, 200)}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const msg = parseRpcBody(text, res.headers.get("content-type"), id);
    if (msg?.error) throw new Error(`Over: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg?.result;
  }

  async init() {
    if (this.ready) return;
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "beit-shamai", version: "1.0" } });
    const token = await accessToken(this.db, this.o);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, token).then((r) => r.text()).catch(() => undefined);
    this.ready = true;
  }

  async call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.init();
    return toolPayload(await this.rpc("tools/call", { name, arguments: args })) as T;
  }
}
