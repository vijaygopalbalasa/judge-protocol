// The hosted dry run: run the deterministic checks on a deliverable before (or
// without) an on-chain job. It must agree exactly with what the judge would
// sign, must never sign anything, and must never make a network request.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { keccak256, toHex } from "viem";

const { dryRunEvaluate } = await import("../src/evaluate.js");
const { createEvaluateHandler } = await import("../api/evaluate.js");
const { criteriaHash } = await import("../src/criteria.js");
const { evidenceHashOf } = await import("../src/evidence.js");
const { runAllChecks } = await import("../src/checkers/index.js");

const TEXT = "This analysis covers ERC-8183 escrow mechanics and USDC settlement on Arc testnet in sufficient detail to satisfy the acceptance criteria.";
const CRITERIA = { version: 1, passThreshold: 100, checks: [
  { kind: "length", params: { min: 10, max: 5000 } },
  { kind: "contains", params: { all: ["ERC-8183", "USDC"] } },
] };

function call(handler, { method = "POST", body, headers = {} } = {}) {
  const res = { code: 0, headers: {}, payload: undefined };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.payload = o; return res; };
  res.end = () => res;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  const req = { method, headers, query: {} };
  if (body !== undefined) req.body = body;
  return Promise.resolve(handler(req, res)).then(() => res);
}

test("the dry run returns exactly what the judge would sign for the same job", async () => {
  const r = await dryRunEvaluate({ criteria: CRITERIA, deliverable: TEXT, jobId: "186740" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const content = Buffer.from(TEXT);
  const want = await runAllChecks(CRITERIA, { content });
  const deliverable = keccak256(content);
  assert.equal(r.body.deliverable, deliverable);
  assert.equal(r.body.criteriaHash, criteriaHash(CRITERIA));
  assert.equal(r.body.score, want.score);
  assert.equal(r.body.pass, want.pass);
  assert.equal(r.body.evidenceHash, evidenceHashOf({ jobId: "186740", criteriaHash: criteriaHash(CRITERIA), deliverable,
    criteria: CRITERIA, results: want.results, score: want.score, threshold: want.threshold, pass: want.pass }));
});

test("the dry run reproduces live job 186740's on-chain hashes exactly", async () => {
  // The exact criteria and deliverable of the job the hosted judge settled on Sep 27, 2026.
  const live = { version: 1, jobType: "doc", passThreshold: 100, checks: [
    { kind: "length", params: { min: 10, max: 5000 }, weight: 1 },
    { kind: "contains", params: { all: ["ERC-8183", "USDC"] }, weight: 1 },
  ] };
  const r = await dryRunEvaluate({ criteria: live, deliverable: TEXT, jobId: "186740" });
  assert.equal(r.body.criteriaHash, "0x9b2b732563a22ef61ba2a48dd6f9eae1a59724926c1d7a3e21bfda21dcfff2d6");
  assert.equal(r.body.deliverable, "0x4c5568398a9872a61017f57d995c215d9f2d1a2554c8a8834b5ab00b0d136d3a");
  assert.equal(r.body.evidenceHash, "0xfab7532bdb819bb43a7a2e0697dbfef9ad7614ee1349f54d82b518776e9fe329");
  assert.equal(r.body.score, 100);
});

test("one changed character changes the commitment and the evidence (no false match)", async () => {
  const a = await dryRunEvaluate({ criteria: CRITERIA, deliverable: TEXT, jobId: "1" });
  const b = await dryRunEvaluate({ criteria: CRITERIA, deliverable: TEXT.replace("USDC", "USDT"), jobId: "1" });
  assert.notEqual(a.body.deliverable, b.body.deliverable);
  assert.notEqual(a.body.evidenceHash, b.body.evidenceHash);
  assert.equal(b.body.pass, false, "missing a required term must fail");
});

test("binary deliverables are checked as raw bytes", async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x41]);
  const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const r = await dryRunEvaluate({ criteria: { checks: [{ kind: "checksum", params: { sha256: sha } }] }, deliverableBase64: bytes.toString("base64") });
  assert.equal(r.body.pass, true);
  assert.equal(r.body.deliverable, keccak256(bytes));
});

test("invalid criteria are refused (422) with the reason, never scored", async () => {
  for (const bad of [{ checks: [] }, { passThreshold: 101, checks: [{ kind: "length" }] }, { checks: [{ kind: "code-test" }] }, { checks: [{ kind: "length", weight: -1 }] }]) {
    const r = await dryRunEvaluate({ criteria: bad, deliverable: TEXT });
    assert.equal(r.status, 422, JSON.stringify(bad));
    assert.equal(r.body.valid, false);
    assert.ok(r.body.reason);
    assert.equal(r.body.score, undefined);
  }
});

// Every live probe resolves its hostname first (safe-fetch.js), so a spy on the
// resolver catches any attempt without touching the network.
async function withDnsSpy(fn) {
  const dnsP = (await import("node:dns/promises")).default;
  const real = dnsP.lookup;
  const looked = [];
  dnsP.lookup = async (host) => { looked.push(host); throw new Error("no network in tests"); };
  try { return await fn(looked); } finally { dnsP.lookup = real; }
}
const PROBE = { checks: [{ kind: "length", params: { min: 3 } }, { kind: "http-endpoint", params: { url: "https://probe.judge-test.invalid/x" } }] };

test("control: the resolver spy does catch a probe when probes are allowed", async () => {
  await withDnsSpy(async (looked) => {
    const r = await dryRunEvaluate({ criteria: PROBE, deliverable: TEXT }, { allowLiveProbes: true });
    assert.deepEqual(looked, ["probe.judge-test.invalid"], "the spy must see the probe, or the tests below prove nothing");
    assert.equal(r.body.results.find((x) => x.kind === "http-endpoint").pass, false);
  });
});

test("an http-endpoint check is reported as not run; the dry run makes no network request", async () => {
  await withDnsSpy(async (looked) => {
    const r = await dryRunEvaluate({ criteria: PROBE, deliverable: TEXT }, { allowLiveProbes: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.notRun, ["http-endpoint"]);
    assert.equal(r.body.score, null, "the score depends on a probe that was not run");
    assert.equal(r.body.pass, null);
    assert.equal(r.body.evidenceHash, null, "no evidence hash for a result that is not complete");
    assert.equal(r.body.results.find((x) => x.kind === "length").pass, true);
    assert.deepEqual(looked, []);
  });
});

test("the hosted endpoint never probes, and the request body cannot turn probes on", async () => {
  await withDnsSpy(async (looked) => {
    const h = createEvaluateHandler();
    for (const body of [{ criteria: PROBE, deliverable: TEXT }, { criteria: PROBE, deliverable: TEXT, allowLiveProbes: true }]) {
      const r = await call(h, { body });
      assert.equal(r.code, 200, JSON.stringify(r.payload));
      assert.deepEqual(r.payload.notRun, ["http-endpoint"]);
      assert.equal(r.payload.pass, null);
    }
    assert.deepEqual(looked, [], "the hosted dry run resolved a hostname, so it tried to probe");
  });
});

test("bad input shapes are 400; both or neither deliverable fields are rejected", async () => {
  assert.equal((await dryRunEvaluate({ deliverable: TEXT })).status, 400);
  assert.equal((await dryRunEvaluate({ criteria: CRITERIA })).status, 400);
  assert.equal((await dryRunEvaluate({ criteria: CRITERIA, deliverable: TEXT, deliverableBase64: "QQ==" })).status, 400);
  assert.equal((await dryRunEvaluate({ criteria: "not an object", deliverable: TEXT })).status, 400);
  assert.equal((await dryRunEvaluate({ criteria: CRITERIA, deliverable: TEXT, jobId: "12abc" })).status, 400);
});

test("the HTTP handler: CORS, preflight, method guard, size caps", async () => {
  const h = createEvaluateHandler();
  const ok = await call(h, { body: { criteria: CRITERIA, deliverable: TEXT } });
  assert.equal(ok.code, 200);
  assert.equal(ok.headers["access-control-allow-origin"], "*");
  assert.equal((await call(h, { method: "OPTIONS" })).code, 204);
  assert.equal((await call(h, { method: "GET" })).code, 405);
  const big = await call(h, { body: { criteria: CRITERIA, deliverable: "x".repeat(300_000) } });
  assert.equal(big.code, 413);
  const req = { method: "POST", headers: { "content-length": "999999" }, query: {} };
  Object.defineProperty(req, "body", { get() { throw new Error("must not parse"); } });
  const res = { code: 0 }; res.status = (c) => { res.code = c; return res; }; res.json = () => res; res.setHeader = () => {}; res.end = () => res;
  await h(req, res);
  assert.equal(res.code, 413);
});

test("the dry run can never sign: it does not import the signer at all", () => {
  for (const f of ["src/evaluate.js", "api/evaluate.js"]) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /signer\.js|signVerdict|privateKeyToAccount|JUDGE_SIGNER_KEY/, f);
  }
});

void toHex;

test("malformed params are a 422 from the dry run, never a 500", async () => {
  const h = createEvaluateHandler();
  for (const criteria of [
    { checks: [{ kind: "contains", params: { all: "ERC" } }] },
    { checks: [{ kind: "schema", params: { required: "id" } }] },
    JSON.parse((await import("./helpers/criteria-cases.js")).DEEP_TEXT),
  ]) {
    const r = await call(h, { body: { criteria, deliverable: "ERC text {\"id\":1}" } });
    assert.equal(r.code, 422, JSON.stringify(r.payload).slice(0, 200));
    assert.equal(r.payload.valid, false);
  }
});

test("a request without content-length (chunked) is still held to the size cap", async () => {
  const h = createEvaluateHandler();
  const terms = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(1000, "x"));
  const r = await call(h, { body: { criteria: { checks: [{ kind: "contains", params: { all: terms } }] }, deliverable: "y".repeat(250_000) } });
  assert.equal(r.code, 413, JSON.stringify(r.payload).slice(0, 120));
});
