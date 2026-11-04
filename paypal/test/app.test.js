import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { createEscrow } from "../src/escrow.js";
import { createPayPal } from "../src/paypal.js";
import { memoryStore } from "../src/store.js";
import { fakePayPal } from "./helpers/fake-paypal.js";

const CRITERIA = { version: 1, passThreshold: 100, checks: [
  { kind: "contains", params: { all: ["refund", "receipt"] }, weight: 1 },
  { kind: "length", params: { min: 5, max: 80 }, weight: 1 },
] };
const GOOD = "Every refund includes a receipt the buyer can verify.";
const WORKER = "worker@personal.example.com";

async function setup(t, { ai = null, local = true, aiLimits, demoWorkerEmail } = {}) {
  const fake = fakePayPal();
  const paypal = createPayPal({ clientId: "client-id", clientSecret: "client-secret", fetchImpl: fake.fetch });
  let n = 0;
  const escrow = createEscrow({ paypal, store: memoryStore(), publicUrl: "http://localhost",
    idgen: () => String(1_792_000_000_000_000 + ++n), keygen: () => `worker-key-${++n}` });
  const app = createApp({ escrow, ai, clientId: "public-client-id", local: local ? fake : null, aiLimits, demoWorkerEmail, logger: { error() {} } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = "GET", body, headers = {} } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { res, data };
  };
  return { fake, escrow, request };
}

async function createAndFund(env) {
  const created = await env.request("/api/jobs", { method: "POST", body: {
    title: "Support reply", task: "Write a support reply mentioning a refund and a receipt.", criteria: CRITERIA, price: "5.00", workerEmail: WORKER,
  } });
  assert.equal(created.res.status, 201);
  const order = await env.request(`/api/jobs/${created.data.id}/order`, { method: "POST", body: {} });
  assert.equal(order.res.status, 200);
  const funded = await env.request(`/api/local/jobs/${created.data.id}/approve`, { method: "POST", body: { orderId: order.data.orderId } });
  assert.equal(funded.res.status, 200);
  assert.equal(funded.data.status, "funded");
  assert.ok(created.data.workerAccess.key);
  return { job: created.data, key: created.data.workerAccess.key };
}

test("the browser API runs a complete pass: post, hold, private delivery, capture and payout", async (t) => {
  const env = await setup(t);
  const { job, key } = await createAndFund(env);
  const funded = await env.request(`/api/jobs/${job.id}`);
  assert.equal(funded.data.paypal.authorizationId !== null, true);
  assert.equal(funded.data.worker, undefined);

  const delivered = await env.request(`/api/jobs/${job.id}/deliver`, { method: "POST", body: { workerKey: key, content: GOOD } });
  assert.equal(delivered.res.status, 200);
  assert.equal(delivered.data.status, "paid");
  assert.equal(delivered.data.verdict.pass, true);
  assert.equal(delivered.data.paypal.captureId !== null, true);
  assert.equal(delivered.data.paypal.payoutItemStatus, "SUCCESS");
  assert.equal(JSON.stringify(delivered.data).includes(GOOD), false, "public responses never expose the delivered bytes");
  assert.equal(JSON.stringify(delivered.data).includes(WORKER), false, "public responses never expose the worker email");

  const list = await env.request("/api/jobs");
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].status, "paid");
  const receipt = await env.request(`/api/jobs/${job.id}/receipt`);
  assert.equal(receipt.res.status, 200);
  assert.equal(receipt.data.decision, "release");
  assert.equal(receipt.data.paypal.captureId, delivered.data.paypal.captureId);
  assert.match(receipt.data.receiptHash, /^0x[0-9a-f]{64}$/);

  const privateDelivery = await env.request(`/api/jobs/${job.id}/delivery`, { method: "POST", body: { workerKey: key } });
  assert.equal(Buffer.from(privateDelivery.data.base64, "base64").toString(), GOOD);
  const denied = await env.request(`/api/jobs/${job.id}/delivery`, { method: "POST", body: { workerKey: "wrong" } });
  assert.equal(denied.res.status, 403);
});

test("a failed delivery through the web API voids the hold and never captures or pays out", async (t) => {
  const env = await setup(t);
  const { job, key } = await createAndFund(env);
  const before = env.fake.calls.length;
  const done = await env.request(`/api/jobs/${job.id}/deliver`, { method: "POST", body: { workerKey: key, content: "This does not meet the agreed terms." } });
  assert.equal(done.data.status, "refunded");
  assert.equal(done.data.verdict.pass, false);
  assert.equal(done.data.paypal.voided, true);
  const calls = env.fake.calls.slice(before);
  assert.equal(calls.some((c) => c.path.endsWith("/capture") || c.path === "/v1/payments/payouts"), false);
  const receipt = await env.request(`/api/jobs/${job.id}/receipt`);
  assert.equal(receipt.data.decision, "refund");
  assert.equal(receipt.data.paypal.voided, true);
});

test("AI work requires the named worker before any model call and only a passing draft is delivered", async (t) => {
  let calls = 0;
  const ai = { async work() { calls++; return { content: GOOD, passed: true, trace: [{ round: 1, score: 100, pass: true }] }; } };
  const env = await setup(t, { ai });
  const { job, key } = await createAndFund(env);
  const denied = await env.request(`/api/jobs/${job.id}/ai-work`, { method: "POST", body: { workerKey: "wrong" } });
  assert.equal(denied.res.status, 403);
  assert.equal(calls, 0);
  const done = await env.request(`/api/jobs/${job.id}/ai-work`, { method: "POST", body: { workerKey: key } });
  assert.equal(done.res.status, 200);
  assert.equal(done.data.job.status, "paid");
  assert.equal(done.data.trace[0].pass, true);
  assert.equal(calls, 1);
});

test("an AI draft that still fails is shown to the worker but is not delivered and does not move money", async (t) => {
  const ai = { async work() { return { content: "not good enough", passed: false, trace: [{ round: 3, score: 50, pass: false, failed: ["contains"] }] }; } };
  const env = await setup(t, { ai });
  const { job, key } = await createAndFund(env);
  const done = await env.request(`/api/jobs/${job.id}/ai-work`, { method: "POST", body: { workerKey: key } });
  assert.equal(done.res.status, 422);
  assert.equal(done.data.job.status, "funded");
  assert.equal(done.data.content, "not good enough");
  assert.equal(done.data.trace.length, 1);
  const current = await env.request(`/api/jobs/${job.id}`);
  assert.equal(current.data.status, "funded");
  assert.equal(current.data.verdict, null);
  assert.equal(env.fake.calls.some((c) => c.path.endsWith("/capture") || c.path.endsWith("/void")), false);
});

test("configuration exposes only the public client id and the real mode never enables local simulator routes", async (t) => {
  const env = await setup(t, { local: false });
  const config = await env.request("/api/config");
  assert.equal(config.data.clientId, "public-client-id");
  assert.equal(config.data.localMode, false);
  assert.equal(JSON.stringify(config.data).includes("client-secret"), false);
  const local = await env.request("/api/local/worker-login", { method: "POST", body: { email: WORKER } });
  assert.equal(local.res.status, 404);
  const health = await env.request("/api/health");
  assert.deepEqual(health.data, { ok: true, service: "judge-pay", environment: "sandbox", paypal: "rest", ai: false });
});

test("the app serves the product pages and blocks cross-origin writes, invalid JSON and oversized requests", async (t) => {
  const env = await setup(t);
  const home = await env.request("/");
  assert.equal(home.res.status, 200);
  assert.match(home.data, /Pay for verified work/);
  const example = JSON.parse(home.data.match(/<textarea id="criteria"[^>]*>([\s\S]*?)<\/textarea>/)[1]);
  const ids = example.checks[0].params.shape.properties.receipt_ids;
  assert.equal(ids.uniqueItems, true);
  assert.deepEqual(ids.items.enum, ["RCPT-1042", "RCPT-1048", "RCPT-1051"]);
  assert.match(home.res.headers.get("content-type"), /text\/html/);
  const worker = await env.request("/worker");
  assert.equal(worker.res.status, 200);
  const missing = await env.request("/not-a-page");
  assert.equal(missing.res.status, 404);

  const crossOrigin = await env.request("/api/jobs", { method: "POST", headers: { origin: "https://attacker.example" }, body: {} });
  assert.equal(crossOrigin.res.status, 403);
  const invalid = await env.request("/api/jobs", { method: "POST", body: "{not-json" });
  assert.equal(invalid.res.status, 400);
  const wrongType = await env.request("/api/jobs", { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
  assert.equal(wrongType.res.status, 415);
  const large = await env.request("/api/jobs", { method: "POST", body: { task: "x".repeat(400_100) } });
  assert.equal(large.res.status, 413);
});

test("an unconfigured AI returns a clear 503 and an unjudged job has no receipt", async (t) => {
  const env = await setup(t);
  const drafted = await env.request("/api/ai/draft", { method: "POST", body: { request: "write something" } });
  assert.equal(drafted.res.status, 503);
  const created = await env.request("/api/jobs", { method: "POST", body: {
    title: "Support reply", task: "Write a reply.", criteria: CRITERIA, price: "5.00", workerEmail: WORKER,
  } });
  const receipt = await env.request(`/api/jobs/${created.data.id}/receipt`);
  assert.equal(receipt.res.status, 409);
});

test("AI calls are capped per caller and per day, so a stranger cannot spend the model budget", async (t) => {
  let calls = 0;
  const ai = { provider: "test", async draftCriteria() { calls++; return { criteria: CRITERIA }; } };
  const env = await setup(t, { ai, aiLimits: { perCallerPerHour: 2, perDay: 3 } });
  const draft = (ip) => env.request("/api/ai/draft", { method: "POST", body: { request: "write something" }, headers: { "x-forwarded-for": ip } });
  assert.equal((await draft("1.1.1.1")).res.status, 200);
  assert.equal((await draft("1.1.1.1")).res.status, 200);
  const third = await draft("1.1.1.1");
  assert.equal(third.res.status, 429);
  assert.match(third.data.error, /limit/i);
  assert.equal((await draft("2.2.2.2")).res.status, 200);
  const overDay = await draft("3.3.3.3");
  assert.equal(overDay.res.status, 429);
  assert.equal(calls, 3);
});

test("the AI cap keys callers by the address the host sets, not a header the visitor can change", async (t) => {
  const ai = { provider: "test", async draftCriteria() { return { criteria: CRITERIA }; } };
  const env = await setup(t, { ai, aiLimits: { perCallerPerHour: 1, perDay: 100 } });
  const draft = (spoof) => env.request("/api/ai/draft", { method: "POST", body: { request: "x" },
    headers: { "x-vercel-forwarded-for": "9.9.9.9", "x-forwarded-for": spoof } });
  assert.equal((await draft("1.1.1.1")).res.status, 200);
  assert.equal((await draft("2.2.2.2")).res.status, 429, "changing x-forwarded-for does not reset the cap");
});

test("the hosted demo can name its sandbox worker so judges' payouts reach a real sandbox account", async (t) => {
  const env = await setup(t, { demoWorkerEmail: "sb-worker@personal.example.com" });
  const { data } = await env.request("/api/config");
  assert.equal(data.demoWorkerEmail, "sb-worker@personal.example.com");
  const plain = await setup(t);
  assert.equal((await plain.request("/api/config")).data.demoWorkerEmail, null);
});
