import { describe, expect, test } from "bun:test";
import {
  extractApiRefs,
  fetchSettlementIndex,
  mergeRefs,
  scriptUrls,
  settlementIndexUrl,
  shapeOf,
} from "../server/connectors/nadlanGov";

describe("nadlan.gov.il probe helpers", () => {
  test("script URLs are made absolute and de-duplicated", () => {
    const html = `<script src="/assets/index-a1.js"></script><script type="module" src='https://www.google.com/recaptcha/api.js?render=x'></script><script src="/assets/index-a1.js"></script>`;
    expect(scriptUrls(html, "https://www.nadlan.gov.il/")).toEqual([
      "https://www.nadlan.gov.il/assets/index-a1.js",
      "https://www.google.com/recaptcha/api.js?render=x",
    ]);
  });

  test("API endpoints, reCAPTCHA and signing markers are found in a bundle", () => {
    const js = `const B="https://data.nadlan.gov.il/api/pages/";fetch("/api/deals/search",{headers:{"X-Signature":s}});` +
      `await grecaptcha.execute(k,{action:"deals"});u="https://cdn.example.com/x";p='/Nadlan.REST/Main/GetAssestAndDeals'`;
    const r = extractApiRefs(js);
    expect(r.urls).toEqual(["https://data.nadlan.gov.il/api/pages/"]);
    expect(r.paths).toEqual(["/Nadlan.REST/Main/GetAssestAndDeals", "/api/deals/search"]);
    expect(r.captcha).toEqual(["grecaptcha.execute"]);
    expect(r.signing).toEqual(["x-signature"]);
  });

  test("a plain bundle reports nothing, and merging de-duplicates", () => {
    const empty = extractApiRefs("console.log('hello')");
    expect(empty).toEqual({ urls: [], paths: [], captcha: [], signing: [] });
    const m = mergeRefs([extractApiRefs(`"/api/a"`), extractApiRefs(`"/api/a" "/api/b"`)]);
    expect(m.paths).toEqual(["/api/a", "/api/b"]);
  });

  test("shape summary and settlement index fetch", async () => {
    expect(shapeOf({ a: 1, b: [{ c: 1 }, { c: 2 }] })).toBe("{ a, b: [2] of {1 keys} }");
    expect(settlementIndexUrl(5000)).toBe("https://data.nadlan.gov.il/api/pages/settlement/buy/5000.json");
    let seen = "";
    const fake = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ settlementName: "תל אביב -יפו" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchSettlementIndex(5000, { fetchImpl: fake })).toEqual({ settlementName: "תל אביב -יפו" });
    expect(seen).toContain("/settlement/buy/5000.json");
    const denied = (async () => new Response("Forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchSettlementIndex(5000, { fetchImpl: denied })).rejects.toThrow("HTTP 403");
  });
});
