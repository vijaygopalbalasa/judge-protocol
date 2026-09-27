// Paid rulings over x402, settled through Circle Gateway on Arc testnet.
// Payments here are signed by Circle's own client code (BatchEvmScheme and
// GatewayClient from @circle-fin/x402-batching), so these tests prove wire
// compatibility with the real buyer, not just agreement with ourselves.
// The rules: only a job that can actually be ruled is ever asked to pay, and
// nobody is charged unless a verdict lands on chain.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BatchEvmScheme, GatewayClient } from "@circle-fin/x402-batching/client";

process.env.EVIDENCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "judge-x402-"));
const { mockChain, describe } = await import("./helpers/mock-chain.js");
const { fakeGateway, GATEWAY_WALLET, ARC, USDC } = await import("./helpers/fake-gateway.js");
const { createPaidJudge, PRICE_ATOMIC } = await import("../src/x402.js");
const { createX402JudgeHandler } = await import("../api/x402/judge.js");
const { GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS } = await import("@circle-fin/x402-batching/server");

// Throwaway keys derived at runtime (no key material in the source).
const PAYER = privateKeyToAccount(keccak256(toHex("judge-protocol x402 test payer")));
const BROKE = privateKeyToAccount(keccak256(toHex("judge-protocol x402 test payer with no balance")));
const FEE_TO = "0xf493CF092768a4B7a533359F28Db82B06D259Dc2";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

function setup({ jobs, relay, balances = { [PAYER.address]: 1_000_000n }, gateway = {} } = {}) {
  const m = mockChain({ jobs, relay });
  const gw = fakeGateway({ balances, ...gateway });
  const paid = createPaidJudge({ facilitator: gw.facilitator, balanceOf: gw.balanceOf, payTo: FEE_TO,
    resourceUrl: "https://judge.test/api/x402/judge", deps: { clients: m.clients } });
  return { m, gw, paid };
}

/** Exactly what GatewayClient.pay() sends: Circle's scheme signs, then resource + accepted are attached. */
async function payHeader(requiredHeader, signer = PAYER, tweak = (x) => x) {
  const required = unb64(requiredHeader);
  const accepted = required.accepts.find((a) => a.network === ARC && a.extra?.name === "GatewayWalletBatched");
  const created = await new BatchEvmScheme(signer).createPaymentPayload(required.x402Version, tweak(accepted));
  return b64({ ...created, resource: required.resource, accepted });
}

async function required(paid, jobId) {
  const r = await paid({ jobId });
  assert.equal(r.status, 402, JSON.stringify(r.body));
  return r.headers["PAYMENT-REQUIRED"];
}

test("a job the judge can rule gets 402 with Circle Gateway terms for Arc testnet, and nothing touches the chain", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 301 }] });
  const r = await paid({ jobId: "301" });
  assert.equal(r.status, 402);
  const req = unb64(r.headers["PAYMENT-REQUIRED"]);
  assert.equal(req.x402Version, 2);
  assert.equal(req.resource.url, "https://judge.test/api/x402/judge");
  assert.equal(req.accepts.length, 1);
  const a = req.accepts[0];
  assert.deepEqual({ scheme: a.scheme, network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo },
    { scheme: "exact", network: ARC, asset: USDC, amount: "10000", payTo: FEE_TO });
  assert.equal(PRICE_ATOMIC, "10000", "0.01 USDC");
  assert.equal(a.maxTimeoutSeconds, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS);
  assert.deepEqual({ name: a.extra.name, version: a.extra.version }, { name: "GatewayWalletBatched", version: "1" });
  assert.equal(a.extra.verifyingContract.toLowerCase(), GATEWAY_WALLET.toLowerCase());
  assert.deepEqual(r.body.accepts, req.accepts, "the body repeats the terms for humans and older clients");
  assert.equal(m.calls.writeContract.length, 0);
  assert.equal(gw.calls.verify.length + gw.calls.settle.length, 0);
});

test("jobs that cannot be ruled are never asked to pay", async () => {
  const verdict = { jobId: 305n, criteriaHash: "0x" + "11".repeat(32), deliverable: "0x" + "22".repeat(32), score: 100, threshold: 100, pass: true, evidenceHash: "0x" + "33".repeat(32), timestamp: 1n };
  const { m, gw, paid } = setup({ jobs: [
    { id: 302, evaluator: "0x000000000000000000000000000000000000dEaD" },
    { id: 303, status: "Funded", submitted: false },
    { id: 304, status: "Expired", submitted: false },
    { id: 305, status: "Completed", verdict },
  ] });
  const want = { 302: "not-ours", 303: "not-submitted", 304: "expired", 305: "judged", 399: "not-found" };
  for (const [id, result] of Object.entries(want)) {
    const r = await paid({ jobId: id });
    assert.notEqual(r.status, 402, `${id} must not be asked to pay`);
    assert.equal(r.headers["PAYMENT-REQUIRED"], undefined);
    assert.equal(r.body.result, result, id);
    assert.equal(r.body.charged, false);
  }
  assert.equal((await paid({ jobId: "abc" })).status, 400);
  assert.equal(m.calls.writeContract.length, 0);
  assert.equal(gw.calls.getSupported + gw.calls.verify.length + gw.calls.settle.length, 0);
});

test("a payment signed by Circle's own client is accepted: the judge rules, then settles exactly once", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 310 }] });
  const header = await payHeader(await required(paid, "310"));
  const r = await paid({ jobId: "310", paymentHeader: header });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "judged");
  assert.equal(r.body.pass, true);
  assert.equal(r.body.payment.charged, true);
  assert.equal(r.body.payment.amount, "0.01");
  assert.equal(r.body.payment.transaction, "gw-transfer-1");
  assert.equal(r.body.payment.payer.toLowerCase(), PAYER.address.toLowerCase());
  const resp = unb64(r.headers["PAYMENT-RESPONSE"]);
  assert.deepEqual({ success: resp.success, transaction: resp.transaction, network: resp.network }, { success: true, transaction: "gw-transfer-1", network: ARC });
  assert.equal(m.calls.writeContract.length, 1);
  assert.equal(gw.calls.settle.length, 1);
  assert.equal(gw.balance(PAYER.address), 1_000_000n - 10_000n);
});

test("no verdict, no charge: abstain, retry-later, a lost race and a failed relay all leave the payment unsettled", async () => {
  const cases = [
    { job: { id: 320, description: describe({ checks: [] }) }, status: 422, result: "abstained" },
    { job: { id: 321, uri: "https://deliverable-host.invalid/report.txt" }, status: 503, result: "retry-later" },
    { job: { id: 322 }, relay: "revert-then-judged", status: 200, result: "already-judged" },
    { job: { id: 323 }, relay: "revert", status: 502, result: "error" },
  ];
  for (const c of cases) {
    const { gw, paid } = setup({ jobs: [c.job], relay: c.relay });
    const id = String(c.job.id);
    const r = await paid({ jobId: id, paymentHeader: await payHeader(await required(paid, id)) });
    assert.equal(r.status, c.status, `${id} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.result, c.result, id);
    assert.equal(r.body.charged, false, id);
    assert.match(r.body.error, /not charged/, `${id}: an x402 client surfaces body.error`);
    assert.equal(r.headers["PAYMENT-RESPONSE"], undefined, id);
    assert.equal(gw.calls.settle.length, 0, `${id} must not settle`);
    assert.equal(gw.balance(PAYER.address), 1_000_000n, id);
  }
});

test("control: Gateway's verify passes an unfunded payer, exactly like the real testnet API", async () => {
  const { gw, paid } = setup({ jobs: [{ id: 330 }], balances: {} });
  const header = unb64(await payHeader(await required(paid, "330"), BROKE));
  const v = await gw.facilitator.verify(header, header.accepted);
  assert.equal(v.isValid, true, "if this ever fails, the next test proves nothing");
});

test("an unfunded payer is refused before any ruling (verify alone is not enough)", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 331 }], balances: {} });
  const r = await paid({ jobId: "331", paymentHeader: await payHeader(await required(paid, "331"), BROKE) });
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.match(r.body.error, /Gateway balance/);
  assert.equal(m.calls.writeContract.length, 0, "no ruling for an unfunded payer");
  assert.equal(gw.calls.settle.length, 0);
});

test("payments for the wrong price, recipient, network or asset are refused before Gateway is asked", async () => {
  const tweaks = {
    "a lower amount": (a) => ({ ...a, amount: "1" }),
    "another recipient": (a) => ({ ...a, payTo: "0x000000000000000000000000000000000000bEEF" }),
    "another network": (a) => ({ ...a, network: "eip155:84532" }),
  };
  for (const [what, tweak] of Object.entries(tweaks)) {
    const { m, gw, paid } = setup({ jobs: [{ id: 340 }] });
    const req = await required(paid, "340");
    let header;
    try { header = await payHeader(req, PAYER, tweak); } catch { continue; } // Circle's client refused to sign: also fine
    // Claim the honest terms in `accepted` while the signature covers the tweaked ones.
    const p = unb64(header);
    p.accepted = unb64(req).accepts[0];
    const r = await paid({ jobId: "340", paymentHeader: b64(p) });
    assert.equal(r.status, 402, `${what}: ${JSON.stringify(r.body)}`);
    assert.equal(gw.calls.verify.length, 0, `${what}: rejected locally`);
    assert.equal(m.calls.writeContract.length, 0, what);
  }
  const { gw, paid } = setup({ jobs: [{ id: 341 }] });
  const p = unb64(await payHeader(await required(paid, "341")));
  p.accepted = { ...p.accepted, asset: "0x1c7d4B196Cb0C7B01d743Fbc6116a902379C7238" };
  assert.equal((await paid({ jobId: "341", paymentHeader: b64(p) })).status, 402, "another asset");
  assert.equal(gw.calls.verify.length, 0);
});

test("a forged signature is refused locally, before Gateway is asked, and nothing is ruled", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 350 }] });
  const p = unb64(await payHeader(await required(paid, "350")));
  p.payload.signature = p.payload.signature.slice(0, -6) + "00001b";
  const r = await paid({ jobId: "350", paymentHeader: b64(p) });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /signature/);
  assert.equal(gw.calls.verify.length, 0);
  assert.equal(m.calls.writeContract.length, 0);
  // Signed by someone else on behalf of the payer: also refused.
  const q = unb64(await payHeader(await required(paid, "350"), BROKE));
  q.payload.authorization.from = PAYER.address;
  assert.equal((await paid({ jobId: "350", paymentHeader: b64(q) })).status, 402);
  assert.equal(m.calls.writeContract.length, 0);
});

test("Gateway's own verdict on a payment is respected even when the local checks pass", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 351 }] });
  gw.facilitator.verify = async () => ({ isValid: false, invalidReason: "authorization_validity_too_short" });
  const r = await paid({ jobId: "351", paymentHeader: await payHeader(await required(paid, "351")) });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /authorization_validity_too_short/);
  assert.equal(m.calls.writeContract.length, 0);
});

test("an authorization that is expired or not yet valid is refused locally", async () => {
  for (const [label, shift] of [["expired", 8 * 24 * 3600], ["not yet valid", -3600]]) {
    const m = mockChain({ jobs: [{ id: 420 }] });
    const gw = fakeGateway({ balances: { [PAYER.address]: 1_000_000n } });
    const base = Math.floor(Date.now() / 1000);
    const paid = createPaidJudge({ facilitator: gw.facilitator, balanceOf: gw.balanceOf, payTo: FEE_TO, resourceUrl: "https://judge.test/api/x402/judge",
      deps: { clients: m.clients }, now: () => base + shift });
    const r = await paid({ jobId: "420", paymentHeader: await payHeader(await required(paid, "420")) });
    assert.equal(r.status, 402, `${label}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /not valid now/, label);
    assert.equal(gw.calls.verify.length, 0, label);
    assert.equal(m.calls.writeContract.length, 0, label);
  }
});

test("malformed or oversized payment headers are 400, with no Gateway call", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 360 }] });
  for (const bad of ["not base64 json", b64("a string"), b64({ x402Version: 2 })]) {
    const r = await paid({ jobId: "360", paymentHeader: bad });
    assert.equal(r.status, 400, bad.slice(0, 20));
  }
  // A correctly signed payment, padded past the cap: only the size limit stops it.
  const valid = unb64(await payHeader(await required(paid, "360")));
  const big = b64({ ...valid, resource: { ...valid.resource, description: "x".repeat(9_000) } });
  const r = await paid({ jobId: "360", paymentHeader: big });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(gw.calls.verify.length, 0);
  assert.equal(m.calls.writeContract.length, 0);
});

test("one payment cannot buy two rulings", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 370 }, { id: 371 }] });
  const header = await payHeader(await required(paid, "370"));
  const first = await paid({ jobId: "370", paymentHeader: header });
  assert.equal(first.body.payment.charged, true);
  const second = await paid({ jobId: "371", paymentHeader: header });
  assert.equal(second.status, 402, JSON.stringify(second.body));
  assert.match(second.body.error, /already used/);
  assert.equal(m.calls.writeContract.length, 1, "the second job was not ruled on the reused payment");
  assert.equal(gw.calls.settle.length, 1);
});

test("if settlement fails after the verdict, the ruling stands and the answer says not charged", async () => {
  const m = mockChain({ jobs: [{ id: 380 }] });
  const gw = fakeGateway({ balances: { [PAYER.address]: 1_000_000n } });
  // The payer empties its Gateway balance between our balance check and settlement.
  const paid = createPaidJudge({ facilitator: gw.facilitator, payTo: FEE_TO, resourceUrl: "https://judge.test/api/x402/judge",
    balanceOf: async (a) => { const b = await gw.balanceOf(a); gw.drain(PAYER.address); return b; }, deps: { clients: m.clients } });
  const r = await paid({ jobId: "380", paymentHeader: await payHeader(await required(paid, "380")) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "judged");
  assert.equal(r.body.payment.charged, false);
  assert.match(r.body.payment.reason, /insufficient_balance/);
  assert.equal(r.headers["PAYMENT-RESPONSE"], undefined);
  assert.equal(m.calls.writeContract.length, 1);
});

test("Gateway unreachable: fail closed with 503 and no ruling", async () => {
  for (const which of ["getSupported", "verify", "balance"]) {
    const ok = setup({ jobs: [{ id: 390 }] });
    const header = await payHeader(await required(ok.paid, "390"));
    const { m, paid } = setup({ jobs: [{ id: 390 }], gateway: { fail: { [which]: true } } });
    const r = await paid({ jobId: "390", paymentHeader: which === "getSupported" ? undefined : header });
    assert.equal(r.status, 503, `${which}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /free POST \/api\/judge/, "points to the free path");
    assert.equal(m.calls.writeContract.length, 0, which);
  }
});

/* ------------------------------ HTTP handler ------------------------------ */

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

test("the handler: CORS lets browsers send the payment and read the terms; preflight, methods, size cap", async () => {
  const m = mockChain({ jobs: [{ id: 400 }] });
  const gw = fakeGateway({ balances: { [PAYER.address]: 1_000_000n } });
  const h = createX402JudgeHandler({ facilitator: gw.facilitator, balanceOf: gw.balanceOf, payTo: FEE_TO, deps: { clients: m.clients } });
  const r = await call(h, { body: { jobId: "400" } });
  assert.equal(r.code, 402);
  assert.ok(r.headers["payment-required"]);
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.match(r.headers["access-control-allow-headers"], /payment-signature/i);
  assert.match(r.headers["access-control-expose-headers"], /PAYMENT-REQUIRED/);
  assert.match(r.headers["access-control-expose-headers"], /PAYMENT-RESPONSE/);
  assert.equal((await call(h, { method: "OPTIONS" })).code, 204);
  const get = await call(h, { method: "GET" });
  assert.equal(get.code, 405);
  assert.match(get.payload.price, /0\.01 USDC/);
  const big = await call(h, { body: { jobId: "400" }, headers: { "content-length": "999999" } });
  assert.equal(big.code, 413);
});

test("end to end with Circle's real GatewayClient.pay() over HTTP: 402, sign, retry, ruled and charged", async () => {
  const m = mockChain({ jobs: [{ id: 410 }] });
  const gw = fakeGateway({ balances: { [PAYER.address]: 1_000_000n } });
  const h = createX402JudgeHandler({ facilitator: gw.facilitator, balanceOf: gw.balanceOf, payTo: FEE_TO, deps: { clients: m.clients } });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const vreq = { method: req.method, headers: req.headers, query: {}, body: raw ? JSON.parse(raw) : undefined };
    const vres = { status(c) { res.statusCode = c; return vres; }, json(o) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); return vres; },
      end() { res.end(); return vres; }, setHeader(k, v) { res.setHeader(k, v); } };
    await h(vreq, vres);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/x402/judge`;
    const key = keccak256(toHex("judge-protocol x402 test payer"));
    const client = new GatewayClient({ chain: "arcTestnet", privateKey: key });
    const out = await client.pay(url, { method: "POST", body: { jobId: "410" } });
    assert.equal(out.status, 200);
    assert.equal(out.data.result, "judged");
    assert.equal(out.data.payment.charged, true);
    assert.equal(out.transaction, "gw-transfer-1");
    assert.equal(out.amount, 10_000n);
    // Paying again for the same (now judged) job is answered without asking for money.
    const again = await client.pay(url, { method: "POST", body: { jobId: "410" } });
    assert.equal(again.data.result, "judged");
    assert.equal(again.amount, 0n);
    assert.equal(gw.calls.settle.length, 1);
  } finally {
    server.close();
  }
});
