import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../server/db";
import { requestCode, verifyCode, updateProfile } from "../server/auth";
import { createServer } from "../server/main";
import { DEMO_SUBJECT } from "../src/data/demo/demoSubject";

describe("sign-in codes", () => {
  test("code by email, wrong code counted, right code signs in; new user flagged", async () => {
    const db = openDb(":memory:");
    let sent = "";
    await requestCode(db, " Dana@Example.com ", "he", async (m) => { sent = m.text; return { sent: true, via: "test" }; });
    const code = sent.match(/\b(\d{6})\b/)![1]!;
    expect(() => verifyCode(db, "dana@example.com", "000000" === code ? "111111" : "000000")).toThrow("wrong code");
    const r = verifyCode(db, "DANA@example.com", code);
    expect(r.user.email).toBe("dana@example.com");
    expect(r.isNew).toBe(true);
    expect(r.token).toMatch(/^[a-f0-9]{64}$/);
    // The code is used up.
    expect(() => verifyCode(db, "dana@example.com", code)).toThrow();
    // Profile: role must be one of the list; consent stored.
    const u = updateProfile(db, r.user.id, { name: "דנה", role: "agent", agency: "רימקס", marketingConsent: true });
    expect(u).toMatchObject({ name: "דנה", role: "agent", agency: "רימקס", marketingConsent: true });
    expect(updateProfile(db, r.user.id, { role: "king" }).role).toBeUndefined();
  });

  test("at most 5 codes an hour per address", async () => {
    const db = openDb(":memory:");
    const quiet = async () => ({ sent: true, via: "test" });
    for (let i = 0; i < 5; i++) await requestCode(db, "a@b.co", "he", quiet);
    await expect(requestCode(db, "a@b.co", "he", quiet)).rejects.toThrow("too many");
  });
});

describe("accounts over HTTP", () => {
  process.env.ADMIN_EMAILS = "boss@example.com";
  delete process.env.RESEND_API_KEY;
  delete process.env.BREVO_API_KEY;
  const { server, db } = createServer({ dbPath: ":memory:", adminToken: "t0k3n", port: 0 });
  process.env.ADMIN_TOKEN = "t0k3n";
  const base = `http://localhost:${server.port}`;
  afterAll(() => server.stop(true));

  // Sign in by reading the code straight from the database hash is impossible, so use the
  // log mailer: capture console output.
  async function signIn(email: string): Promise<string> {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try { await fetch(`${base}/api/auth/code`, { method: "POST", body: JSON.stringify({ email }) }); } finally { console.log = orig; }
    const code = lines.join("\n").match(/\b(\d{6})\b/)![1]!;
    const r = await fetch(`${base}/api/auth/verify`, { method: "POST", body: JSON.stringify({ email, code }) });
    expect(r.status).toBe(200);
    return r.headers.get("set-cookie")!.split(";")[0]!;
  }

  test("user: profile, own property, submit → data request; admin sees it in the pipeline", async () => {
    const cookie = await signIn("buyer@example.com");
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(me.isAdmin).toBe(false);
    await fetch(`${base}/api/me`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ name: "Avi", role: "buyer" }) });

    const id = "case-aaaaaaaaaaaaaaaa";
    const subject = { ...DEMO_SUBJECT, address: { city: "תל אביב-יפו", street: "בן יהודה", number: "10" } };
    await fetch(`${base}/api/cases/${id}`, { method: "PUT", headers: { cookie }, body: JSON.stringify({ subject }) });
    const mine = await (await fetch(`${base}/api/my/cases`, { headers: { cookie } })).json();
    expect(mine.map((c: any) => c.id)).toEqual([id]);
    expect(mine[0].status).toBe("draft");

    // Not signed in: no list, no admin.
    expect((await fetch(`${base}/api/my/cases`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/cases`, { headers: { cookie } })).status).toBe(401);

    const sub = await (await fetch(`${base}/api/cases/${id}/submit`, { method: "POST", headers: { cookie } })).json();
    expect(sub.case.status).toBe("submitted");
    expect(sub.request.caseId).toBe(id);

    // Admin by session (bootstrap: admin token as the code while email is not configured).
    const r = await fetch(`${base}/api/auth/verify`, { method: "POST", body: JSON.stringify({ email: "boss@example.com", code: "t0k3n" }) });
    const admin = r.headers.get("set-cookie")!.split(";")[0]!;
    expect((await r.json()).isAdmin).toBe(true);
    const all = await (await fetch(`${base}/api/admin/cases`, { headers: { cookie: admin } })).json();
    expect(all[0]).toMatchObject({ id, status: "submitted", owner: { email: "buyer@example.com", name: "Avi", role: "buyer" } });
    expect(all[0].request.total).toBeGreaterThan(0);
    // Admin moves it on; the data-requests inbox works with the session too.
    await fetch(`${base}/api/admin/cases/${id}`, { method: "PUT", headers: { cookie: admin }, body: JSON.stringify({ status: "data" }) });
    expect((await (await fetch(`${base}/api/my/cases`, { headers: { cookie } })).json())[0].status).toBe("data");
    expect((await fetch(`${base}/api/requests`, { headers: { cookie: admin } })).status).toBe(200);
    // Another user cannot submit someone else's property.
    const other = await signIn("other@example.com");
    expect((await fetch(`${base}/api/cases/${id}/submit`, { method: "POST", headers: { cookie: other } })).status).toBe(403);
    // Logout ends the session.
    await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401);
  });
});
