// Paid rulings over x402, settled through Circle Gateway on Arc testnet.
// Payments here are signed by Circle's own client code (BatchEvmScheme and
// GatewayClient from @circle-fin/x402-batching), so these tests prove wire
// compatibility with the real buyer, not just agreement with ourselves.
// The rules: only a job waiting for a ruling is asked to pay; the payment is
// settled when the judge has a verdict ready and BEFORE it signs anything, so
// nothing is ever signed for a payment that did not settle.
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

function setup({ jobs, relay, balances = { [PAYER.address]: 1_000_000n }, gateway = {}, timeoutMs } = {}) {
  const m = mockChain({ jobs, relay });
  const gw = fakeGateway({ balances, ...gateway });
  const paid = createPaidJudge({ facilitator: gw.facilitator, balanceOf: gw.balanceOf, lookupTransfer: gw.lookupTransfer, payTo: FEE_TO,
    resourceUrl: "https://judge.test/api/x402/judge", deps: { clients: m.clients }, ...(timeoutMs ? { timeoutMs } : {}) });
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
  const want = { 302: "not-ours", 303: "not-submitted", 304: "expired", 305: "already-judged", 399: "not-found" };
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

test("a payment signed by Circle's own client is accepted: settled once, then the verdict is signed", async () => {
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

test("no ruling possible, no charge: an abstention or a retry-later leaves the payment unsettled", async () => {
  const cases = [
    { job: { id: 320, description: describe({ checks: [{ kind: "length" }, { kind: "contains", params: { all: ["x"] } }] }), content: "no" , uri: "https://deliverable-host.invalid/r.txt" }, status: 503, result: "retry-later" },
    { job: { id: 324, content: "different bytes", logDeliverable: "0x" + "ab".repeat(32) }, status: 422, result: "abstained" },
  ];
  for (const c of cases) {
    const { gw, paid } = setup({ jobs: [c.job] });
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

test("the payment settles before the verdict is signed; if the verdict transaction then fails, the answer says so", async () => {
  // a lost race: another request settled the same deterministic verdict first
  const race = setup({ jobs: [{ id: 322 }], relay: "revert-then-judged" });
  const r1 = await race.paid({ jobId: "322", paymentHeader: await payHeader(await required(race.paid, "322")) });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.result, "already-judged");
  assert.equal(r1.body.charged, true);
  assert.ok(r1.body.verdict, "the verdict that landed is returned");
  // a failed relay: charged, and the daily sweep settles the verdict
  const fail = setup({ jobs: [{ id: 323 }], relay: "revert" });
  const r2 = await fail.paid({ jobId: "323", paymentHeader: await payHeader(await required(fail.paid, "323")) });
  assert.equal(r2.status, 502, JSON.stringify(r2.body));
  assert.equal(r2.body.charged, true);
  assert.match(r2.body.error, /sweep/);
  assert.ok(r2.body.payment.transaction);
  // in both, the payment settled once and only after the verdict was ready
  for (const x of [race, fail]) assert.equal(x.gw.calls.settle.length, 1);
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

test("a transient RPC error after the payment settled is retried: judged, charged once", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 396 }], relay: "transient-then-ok" });
  const r = await paid({ jobId: "396", paymentHeader: await payHeader(await required(paid, "396")) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "judged");
  assert.equal(r.body.charged, true);
  assert.equal(gw.calls.settle.length, 1);
  assert.equal(m.calls.writeContract.length, 2);
});

test("when the verdict transaction really fails after payment, the answer keeps the underlying reason", async () => {
  const { paid } = setup({ jobs: [{ id: 397 }], relay: "revert" });
  const r = await paid({ jobId: "397", paymentHeader: await payHeader(await required(paid, "397")) });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.charged, true);
  assert.match(r.body.error, /sweep/);
  assert.match(r.body.detail, /BadSigner/, "the real error is kept for diagnosis");
});

test("if the payment does not settle, nothing is signed and nobody is charged", async () => {
  const m = mockChain({ jobs: [{ id: 380 }] });
  const gw = fakeGateway({ balances: { [PAYER.address]: 1_000_000n } });
  // The payer empties its Gateway balance between our balance check and settlement.
  const paid = createPaidJudge({ facilitator: gw.facilitator, lookupTransfer: gw.lookupTransfer, payTo: FEE_TO, resourceUrl: "https://judge.test/api/x402/judge",
    balanceOf: async (a) => { const b = await gw.balanceOf(a); gw.drain(PAYER.address); return b; }, deps: { clients: m.clients } });
  const r = await paid({ jobId: "380", paymentHeader: await payHeader(await required(paid, "380")) });
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.equal(r.body.charged, false);
  assert.match(r.body.error, /insufficient_balance/);
  assert.equal(m.calls.writeContract.length, 0, "no verdict was signed for an unsettled payment");
});

test("a payment already settled at Gateway (by anyone) buys nothing here", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 381 }] });
  const header = await payHeader(await required(paid, "381"));
  const p = unb64(header);
  const direct = await gw.facilitator.settle(p, p.accepted); // the payer settles it directly
  assert.equal(direct.success, true);
  const r = await paid({ jobId: "381", paymentHeader: header });
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.match(r.body.error, /nonce_already_used/);
  assert.equal(m.calls.writeContract.length, 0);
});

test("the same payment on two server instances rules at most once", async () => {
  const m = mockChain({ jobs: [{ id: 382 }, { id: 383 }] });
  const gw = fakeGateway({ balances: { [PAYER.address]: 1_000_000n } });
  const make = () => createPaidJudge({ facilitator: gw.facilitator, balanceOf: gw.balanceOf, lookupTransfer: gw.lookupTransfer, payTo: FEE_TO,
    resourceUrl: "https://judge.test/api/x402/judge", deps: { clients: m.clients } });
  const a = make(), b = make();
  const header = await payHeader(await required(a, "382"));
  assert.equal((await a({ jobId: "382", paymentHeader: header })).body.charged, true);
  const second = await b({ jobId: "383", paymentHeader: header });
  assert.equal(second.status, 402, JSON.stringify(second.body));
  assert.equal(m.calls.writeContract.length, 1, "the replayed payment bought no second ruling");
});

test("a burst of payments against one balance buys exactly one ruling", async () => {
  const m = mockChain({ jobs: [{ id: 384 }, { id: 385 }, { id: 386 }] });
  const gw = fakeGateway({ balances: { [PAYER.address]: 10_000n } }); // exactly one ruling's worth
  const paid = createPaidJudge({ facilitator: gw.facilitator, balanceOf: gw.balanceOf, lookupTransfer: gw.lookupTransfer, payTo: FEE_TO,
    resourceUrl: "https://judge.test/api/x402/judge", deps: { clients: m.clients } });
  const headers = [];
  for (const id of ["384", "385", "386"]) headers.push([id, await payHeader(await required(paid, id))]);
  const rs = await Promise.all(headers.map(([jobId, paymentHeader]) => paid({ jobId, paymentHeader })));
  assert.equal(rs.filter((r) => r.body.charged === true).length, 1, JSON.stringify(rs.map((r) => [r.status, r.body.result, r.body.error])));
  assert.equal(m.calls.writeContract.length, 1, "only the settled payment got a ruling");
});

test("jobs the judge will not rule are not asked to pay: too small, invalid criteria, no signer", async () => {
  const { gw, paid } = setup({ jobs: [{ id: 387, budget: 5_000n }, { id: 388, description: describe({ checks: [] }) }] });
  const small = await paid({ jobId: "387" });
  assert.notEqual(small.status, 402, JSON.stringify(small.body));
  assert.equal(small.body.result, "skipped");
  const invalid = await paid({ jobId: "388" });
  assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
  assert.equal(invalid.body.result, "abstained");
  const m = mockChain({ jobs: [{ id: 389 }] });
  const keyless = createPaidJudge({ facilitator: gw.facilitator, balanceOf: gw.balanceOf, payTo: FEE_TO, resourceUrl: "x",
    deps: { makeClients: () => { throw new Error("JUDGE_SIGNER_KEY is not set"); }, makePublicClient: () => m.clients.publicClient } });
  const nokey = await keyless({ jobId: "389" });
  assert.equal(nokey.status, 503, JSON.stringify(nokey.body));
  assert.match(nokey.body.error, /signer/);
  for (const r of [small, invalid, nokey]) { assert.equal(r.headers["PAYMENT-REQUIRED"], undefined); assert.equal(r.body.charged, false); }
});

test("a verdict that lands between the 402 and the paid retry: already-judged, not charged, same as the free path", async () => {
  const { m, gw, paid } = setup({ jobs: [{ id: 390 }] });
  const header = await payHeader(await required(paid, "390"));
  const { judgeNow } = await import("../src/judge-now.js");
  assert.equal((await judgeNow({ jobId: "390" }, { clients: m.clients })).body.result, "judged"); // the free path rules first
  const r = await paid({ jobId: "390", paymentHeader: header });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "already-judged");
  assert.equal(r.body.charged, false);
  assert.ok(r.body.verdict);
  assert.equal(gw.calls.settle.length, 0);
});

test("a chain read failing after the 402 is a 503 (paid and free), never a crash", async () => {
  const { m, paid } = setup({ jobs: [{ id: 391 }] });
  const header = await payHeader(await required(paid, "391"));
  m.clients.publicClient.getLogs = async () => { throw new Error("HTTP 429 Too Many Requests"); };
  const r = await paid({ jobId: "391", paymentHeader: header });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.charged, false);
  const { judgeNow } = await import("../src/judge-now.js");
  const free = await judgeNow({ jobId: "391" }, { clients: m.clients });
  assert.equal(free.status, 503);
  assert.equal(free.body.result, "retry-later");
});

test("a Gateway that hangs is cut off quickly; a settle that hangs is resolved by asking Gateway", async () => {
  // verify hangs: 503 fast, no ruling
  const hangV = setup({ jobs: [{ id: 392 }], gateway: { fail: { verifyHang: true } }, timeoutMs: 150 });
  const t0 = Date.now();
  const rv = await hangV.paid({ jobId: "392", paymentHeader: await payHeader(await required(hangV.paid, "392")) });
  assert.equal(rv.status, 503, JSON.stringify(rv.body));
  assert.ok(Date.now() - t0 < 2000, "cut off by the timeout");
  assert.equal(hangV.m.calls.writeContract.length, 0);
  // settle processed by Gateway but the call hangs: the lookup finds it, so it counts as charged and the ruling proceeds
  const hangS = setup({ jobs: [{ id: 393 }], gateway: { fail: { settleProcessedThenHang: true } }, timeoutMs: 150 });
  const rs = await hangS.paid({ jobId: "393", paymentHeader: await payHeader(await required(hangS.paid, "393")) });
  assert.equal(rs.status, 200, JSON.stringify(rs.body));
  assert.equal(rs.body.result, "judged");
  assert.equal(rs.body.payment.charged, true);
  // settle hangs and Gateway has no record: not charged, nothing signed
  const lost = setup({ jobs: [{ id: 394 }], gateway: { fail: { settleHang: true } }, timeoutMs: 150 });
  const rl = await lost.paid({ jobId: "394", paymentHeader: await payHeader(await required(lost.paid, "394")) });
  assert.equal(rl.body.charged, false, JSON.stringify(rl.body));
  assert.equal(lost.m.calls.writeContract.length, 0);
});

test("payment numbers must be canonical decimal strings, and the header a single value", async () => {
  const { gw, paid } = setup({ jobs: [{ id: 395 }] });
  const p = unb64(await payHeader(await required(paid, "395")));
  for (const v of [" 10000", "010000", "0x2710", "10000.0", 10000]) {
    const q = structuredClone(p); q.payload.authorization.value = v;
    const r = await paid({ jobId: "395", paymentHeader: b64(q) });
    assert.equal(r.status, 400, `value ${JSON.stringify(v)}: ${JSON.stringify(r.body)}`);
  }
  const arr = await paid({ jobId: "395", paymentHeader: ["a", "b"] });
  assert.equal(arr.status, 400);
  assert.match(arr.body.error, /single/);
  assert.equal(gw.calls.verify.length, 0);
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
    assert.equal(again.data.result, "already-judged");
    assert.equal(again.data.charged, false);
    assert.equal(again.amount, 0n);
    assert.equal(gw.calls.settle.length, 1);
  } finally {
    server.close();
  }
});
