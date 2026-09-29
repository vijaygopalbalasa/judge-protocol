// Live check of the hosted judge. Needs no keys and moves no money.
//   node scripts/live-check.mjs [baseUrl]
// It checks the dry run against a verdict on chain (job 186740), the traps a
// judge must not fall into, and that the public endpoints refuse what they
// should. Exits non-zero on any failure.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const BASE = process.argv[2] || "https://judge-protocol-api.vercel.app";
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log("PASS", name); }
  catch (e) { failed++; console.log("FAIL", name, "::", String(e.message).split("\n")[0]); }
}
async function ev(body, { raw } = {}) {
  const res = await fetch(`${BASE}/api/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const TEXT = "This analysis covers ERC-8183 escrow mechanics and USDC settlement on Arc testnet in sufficient detail to satisfy the acceptance criteria.";
const LIVE = { version: 1, jobType: "doc", passThreshold: 100, checks: [
  { kind: "length", params: { min: 10, max: 5000 }, weight: 1 },
  { kind: "contains", params: { all: ["ERC-8183", "USDC"] }, weight: 1 },
] };

await check("the dry run reproduces job 186740's on-chain verdict exactly", async () => {
  const chain = (await (await fetch(`${BASE}/api/judge?jobId=186740`)).json()).verdict;
  const r = await ev({ criteria: LIVE, deliverable: TEXT, jobId: "186740" });
  assert.equal(r.status, 200);
  for (const k of ["criteriaHash", "deliverable", "score", "threshold", "pass", "evidenceHash"]) assert.equal(String(r.body[k]), String(chain[k]), k);
});

await check("one changed character fails and changes every hash", async () => {
  const a = await ev({ criteria: LIVE, deliverable: TEXT, jobId: "186740" });
  const b = await ev({ criteria: LIVE, deliverable: TEXT.replace("USDC", "USDc"), jobId: "186740" });
  assert.equal(b.body.pass, false);
  assert.equal(b.body.score, 50);
  assert.notEqual(a.body.deliverable, b.body.deliverable);
  assert.notEqual(a.body.evidenceHash, b.body.evidenceHash);
});

await check("contains is literal (no regex) and case-sensitive", async () => {
  assert.equal((await ev({ criteria: { checks: [{ kind: "contains", params: { all: ["U.DC"] } }] }, deliverable: "USDC" })).body.pass, false);
});

await check("wholeWords: \"Arc\" is not satisfied by \"Architecture\"", async () => {
  const c = { checks: [{ kind: "contains", params: { all: ["Arc"], wholeWords: true } }] };
  assert.equal((await ev({ criteria: c, deliverable: "A software Architecture" })).body.pass, false);
  assert.equal((await ev({ criteria: c, deliverable: "Built on Arc." })).body.pass, true);
});

await check("same work, different job: same score, different evidence hash", async () => {
  const a = await ev({ criteria: LIVE, deliverable: TEXT, jobId: "1" });
  const b = await ev({ criteria: LIVE, deliverable: TEXT, jobId: "2" });
  assert.equal(a.body.score, b.body.score);
  assert.notEqual(a.body.evidenceHash, b.body.evidenceHash);
});

await check("binary deliverables are checked as raw bytes", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x41]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const c = { checks: [{ kind: "checksum", params: { sha256: sha } }] };
  assert.equal((await ev({ criteria: c, deliverableBase64: bytes.toString("base64") })).body.pass, true);
  assert.equal((await ev({ criteria: c, deliverableBase64: Buffer.from([0x89, 0x50]).toString("base64") })).body.pass, false);
});

await check("invalid criteria are refused with a reason (422), never scored", async () => {
  for (const bad of [{ checks: [] }, { checks: [{ kind: "code-test" }] }, { passThreshold: 101, checks: [{ kind: "length" }] },
    { checks: [{ kind: "length", weight: 0 }] }, { checks: "length" }, { checks: [{ kind: "contains", params: { all: "ERC" } }] },
    { checks: [{ kind: "schema", params: { required: "id" } }] }]) {
    const r = await ev({ criteria: bad, deliverable: "x" });
    assert.equal(r.status, 422, JSON.stringify(bad));
    assert.equal(r.body.valid, false);
  }
});

await check("criteria nested 5000 levels deep are a 422, not a 500", async () => {
  const raw = `{"criteria":{"checks":[{"kind":"length","params":{"a":${'{"a":'.repeat(5000)}1${"}".repeat(5000)}}}]},"deliverable":"hello world"}`;
  assert.equal((await ev(null, { raw })).status, 422);
});

await check("a JSON deliverable that is not an object fails schema cleanly", async () => {
  const r = await ev({ criteria: { checks: [{ kind: "schema", params: { required: ["a"] } }] }, deliverable: "42" });
  assert.equal(r.status, 200);
  assert.equal(r.body.pass, false);
});

await check("json: a list of records passes its shape, and a duplicate domain or a lowercase enum fails", async () => {
  const shape = { type: "array", minItems: 2, maxItems: 2, uniqueBy: { field: "website", key: "domain" },
    items: { type: "object", required: ["website", "network"], properties: { website: { type: "string", format: "url" }, network: { enum: ["Arc", "Base"] } } } };
  const c = { checks: [{ kind: "json", params: { shape } }] };
  const good = [{ website: "https://a.xyz", network: "Arc" }, { website: "https://b.xyz", network: "Base" }];
  assert.equal((await ev({ criteria: c, deliverable: JSON.stringify(good) })).body.pass, true);
  const dup = [good[0], { website: "https://WWW.A.xyz/x", network: "Base" }];
  const d = await ev({ criteria: c, deliverable: JSON.stringify(dup) });
  assert.equal(d.body.pass, false);
  assert.match(d.body.results[0].detail, /same domain as \$\[0\]/);
  assert.equal((await ev({ criteria: c, deliverable: JSON.stringify([good[0], { ...good[1], network: "base" }]) })).body.pass, false);
  assert.equal((await ev({ criteria: { checks: [{ kind: "json", params: { shape: { minItems: 1 } } }] }, deliverable: "[]" })).status, 422);
});

await check("the hosted dry run never probes a URL (including metadata addresses)", async () => {
  for (const url of ["https://example.com", "http://169.254.169.254/latest/meta-data/"]) {
    const r = await ev({ criteria: { checks: [{ kind: "http-endpoint", params: { url } }] }, deliverable: "x", allowLiveProbes: true });
    assert.deepEqual(r.body.notRun, ["http-endpoint"]);
    assert.equal(r.body.pass, null);
  }
});

await check("input errors are 400; oversized requests are 413", async () => {
  assert.equal((await ev({ criteria: LIVE })).status, 400);
  assert.equal((await ev(null, { raw: "{not json" })).status, 400);
  assert.equal((await ev({ criteria: LIVE, deliverable: "x".repeat(300_000) })).status, 413);
});

await check("the paid endpoint asks nothing for a job it cannot rule, and says so", async () => {
  const judged = await (await fetch(`${BASE}/api/x402/judge`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jobId":"186740"}' })).json();
  assert.equal(judged.result, "already-judged");
  assert.equal(judged.charged, false);
  const missing = await fetch(`${BASE}/api/x402/judge`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jobId":"999999999"}' });
  assert.notEqual(missing.status, 402);
});

await check("a misspelled check field is refused, never silently passed", async () => {
  const r = await ev({ criteria: { checks: [{ kind: "length", param: { min: 50 } }] }, deliverable: "x" });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.match(r.body.reason, /unknown field "param"/);
});

await check("the paid endpoint says charged:false on a malformed request", async () => {
  const res = await fetch(`${BASE}/api/x402/judge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).charged, false);
});

await check("an unknown job id is not-found (read from chain), not an error", async () => {
  const res = await fetch(`${BASE}/api/judge?jobId=999999999999`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).result, "not-found");
});

await check("method guards, CORS, no source files served", async () => {
  assert.equal((await fetch(`${BASE}/api/evaluate`)).status, 405);
  const pre = await fetch(`${BASE}/api/x402/judge`, { method: "OPTIONS", headers: { origin: "https://example.org", "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") || "", /payment-signature/i);
  for (const p of ["/src/evaluate.js", "/src/signer.js", "/package.json", "/.env"]) assert.equal((await fetch(`${BASE}${p}`)).status, 404, p);
});

await check("health: the signer is authorized and the relayer has gas", async () => {
  const h = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(h.ok, true, JSON.stringify(h.warnings));
  assert.equal(h.signerAuthorized, true);
});

console.log(failed ? `\n${failed} FAILED against ${BASE}` : `\nALL PASS against ${BASE}`);
process.exit(failed ? 1 : 0);
