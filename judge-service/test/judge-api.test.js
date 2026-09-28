// Vercel handlers for the hosted judge: /api/judge, /api/health, /api/cron/sweep.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVIDENCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "judge-evidence-"));
const { mockChain, TEST_SIGNER } = await import("./helpers/mock-chain.js");
const { createJudgeHandler } = await import("../api/judge.js");
const { createHealthHandler } = await import("../api/health.js");
const { createSweepHandler } = await import("../api/cron/sweep.js");

function call(handler, { method = "POST", body, headers = {}, query = {} } = {}) {
  const res = { code: 0, headers: {}, payload: undefined };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.payload = o; return res; };
  res.send = (s) => { res.payload = s; return res; };
  res.end = () => res;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  const req = { method, headers, query };
  if (body !== undefined) req.body = body;
  return Promise.resolve(handler(req, res)).then(() => res);
}

test("POST /api/judge rules on a job and answers with CORS headers any site can use", async () => {
  const m = mockChain({ jobs: [{ id: 42 }] });
  const r = await call(createJudgeHandler({ clients: m.clients }), { body: { jobId: "42" } });
  assert.equal(r.code, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.result, "judged");
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.equal(m.calls.writeContract.length, 1);
});

test("POST accepts a raw JSON string body too", async () => {
  const m = mockChain({ jobs: [{ id: 43 }] });
  const r = await call(createJudgeHandler({ clients: m.clients }), { body: JSON.stringify({ jobId: 43 }) });
  assert.equal(r.payload.result, "judged");
});

test("OPTIONS preflight is 204; unknown methods are 405", async () => {
  const h = createJudgeHandler({ clients: mockChain({ jobs: [] }).clients });
  const pre = await call(h, { method: "OPTIONS" });
  assert.equal(pre.code, 204);
  assert.match(pre.headers["access-control-allow-methods"], /POST/);
  assert.equal((await call(h, { method: "PUT", body: {} })).code, 405);
});

test("oversized bodies are refused from content-length before parsing; malformed JSON is 400", async () => {
  const m = mockChain({ jobs: [{ id: 44 }] });
  const h = createJudgeHandler({ clients: m.clients });
  const req = { method: "POST", headers: { "content-length": "100000" }, query: {} };
  Object.defineProperty(req, "body", { get() { throw new Error("body must not be read"); } });
  const res = { code: 0, headers: {} };
  res.status = (c) => { res.code = c; return res; }; res.json = () => res; res.setHeader = () => {}; res.end = () => res;
  await h(req, res);
  assert.equal(res.code, 413);
  assert.equal((await call(h, { body: '{"jobId": ' })).code, 400);
  assert.equal(m.calls.writeContract.length, 0);
});

test("GET /api/judge?jobId= is read-only: it reports status and never signs", async () => {
  const m = mockChain({ jobs: [{ id: 45 }] });
  const h = createJudgeHandler({ clients: m.clients });
  const before = await call(h, { method: "GET", query: { jobId: "45" } });
  assert.equal(before.code, 200);
  assert.equal(before.payload.result, "pending");
  assert.equal(m.calls.writeContract.length, 0);
  await call(h, { body: { jobId: "45" } });
  const after = await call(h, { method: "GET", query: { jobId: "45" } });
  assert.equal(after.payload.result, "judged");
  assert.equal(after.payload.verdict.pass, true);
});

test("GET /api/health reports the signer, its on-chain authorization and gas, never a key", async () => {
  const m = mockChain({ jobs: [], balance: 2_500_000_000_000_000_000n });
  const r = await call(createHealthHandler({ clients: m.clients }), { method: "GET" });
  assert.equal(r.code, 200);
  assert.equal(r.payload.signer, TEST_SIGNER.address);
  assert.equal(r.payload.signerAuthorized, true);
  assert.equal(r.payload.relayerBalanceUSDC, "2.5");
  assert.equal(r.payload.ok, true);
  assert.match(r.payload.judge, /^0x6EFF7d4B/i);
  assert.doesNotMatch(JSON.stringify(r.payload), /[0-9a-f]{64}/i, "no 32-byte secrets in the health output");
});

test("health is not ok when the signer is not authorized or gas is low", async () => {
  const m = mockChain({ jobs: [], balance: 10_000_000_000_000_000n }); // 0.01 USDC
  const r = await call(createHealthHandler({ clients: m.clients }), { method: "GET" });
  assert.equal(r.payload.ok, false);
  assert.match(r.payload.warnings.join(" "), /gas/i);
});

test("health reports separate signer and relayer keys, and warns when they are the same", async () => {
  const sep = await call(createHealthHandler({ clients: mockChain({ jobs: [] }).clients }), { method: "GET" });
  assert.notEqual(sep.payload.signer, sep.payload.relayer);
  assert.equal(sep.payload.ok, true);
  const same = await call(createHealthHandler({ clients: mockChain({ jobs: [], sameKey: true }).clients }), { method: "GET" });
  assert.equal(same.payload.ok, false);
  assert.match(same.payload.warnings.join(" "), /same key/);
});

test("health is not ok when the signer is not authorized on-chain, and says so", async () => {
  const m = mockChain({ jobs: [], signerAuthorized: false });
  const r = await call(createHealthHandler({ clients: m.clients }), { method: "GET" });
  assert.equal(r.payload.ok, false);
  assert.equal(r.payload.signerAuthorized, false);
  assert.match(r.payload.warnings.join(" "), /not authorized/);
});

test("the cron sweep refuses callers without the secret and sweeps with it", async () => {
  const m = mockChain({ jobs: [{ id: 46 }] });
  const h = createSweepHandler({ clients: m.clients, cronSecret: "s3cret-for-tests" });
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "s3cret-for-tests" }]) {
    assert.equal((await call(h, { method: "GET", headers })).code, 401);
  }
  assert.equal(m.calls.writeContract.length, 0);
  const ok = await call(h, { method: "GET", headers: { authorization: "Bearer s3cret-for-tests" } });
  assert.equal(ok.code, 200, JSON.stringify(ok.payload));
  assert.equal(ok.payload.judged, 1);
});

test("the cron sweep is closed entirely when no secret is configured", async () => {
  const m = mockChain({ jobs: [{ id: 47 }] });
  const h = createSweepHandler({ clients: m.clients, cronSecret: "" });
  assert.equal((await call(h, { method: "GET", headers: { authorization: "Bearer " } })).code, 401);
  assert.equal(m.calls.writeContract.length, 0);
});

test("POST /api/judge without content-length is still held to the 4 KB cap", async () => {
  const m = mockChain({ jobs: [{ id: 48 }] });
  const r = await call(createJudgeHandler({ clients: m.clients }), { body: { jobId: "48", padding: "x".repeat(10_000) } });
  assert.equal(r.code, 413);
  assert.equal(m.calls.writeContract.length, 0);
});

test("an unexpected failure inside any handler is a 503, never a 500 or a crash", async () => {
  const { createX402JudgeHandler } = await import("../api/x402/judge.js");
  const { createEvaluateHandler } = await import("../api/evaluate.js");
  for (const h of [createJudgeHandler({}), createX402JudgeHandler({}), createEvaluateHandler()]) {
    const res = { code: 0, payload: undefined, headers: {} };
    res.status = (c) => { res.code = c; return res; };
    res.json = (o) => { res.payload = o; return res; };
    res.end = () => res;
    res.setHeader = (k, v) => { res.headers[k] = v; };
    const req = { method: "POST", query: {} };
    Object.defineProperty(req, "headers", { get() { throw new Error("boom"); } });
    await h(req, res);
    assert.equal(res.code, 503);
  }
});

test("paid rulings run on Arc testnet only: elsewhere the x402 route refuses first and charges nothing", async () => {
  const { createX402JudgeHandler } = await import("../api/x402/judge.js");
  const touched = [];
  const facilitator = { verify: async () => { touched.push("verify"); }, settle: async () => { touched.push("settle"); }, getSupported: async () => { touched.push("supported"); return { kinds: [] }; } };
  const m = mockChain({ jobs: [{ id: 16 }] });
  const mainnet = createX402JudgeHandler({ chainId: 5042, facilitator, deps: { clients: m.clients } });
  for (const method of ["POST", "GET"]) {
    const r = await call(mainnet, { method, body: { jobId: "16" }, headers: { "payment-signature": "eyJ4IjoxfQ==" } });
    assert.equal(r.code, 404, `${method}: ${JSON.stringify(r.payload)}`);
    assert.equal(r.payload.charged, false);
    assert.match(r.payload.error, /Arc testnet only/);
    assert.match(r.payload.error, /POST \/api\/judge/, "it points to the free ruling path");
  }
  assert.deepEqual(touched, [], "Circle Gateway is never asked");
  assert.equal(m.calls.writeContract.length, 0, "nothing is signed or sent");
  // Control: on Arc testnet the same route still answers with its terms.
  const testnet = createX402JudgeHandler({ chainId: 5042002 });
  assert.equal((await call(testnet, { method: "GET" })).code, 405);
});
