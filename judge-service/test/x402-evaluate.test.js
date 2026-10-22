// A deterministic evaluation sold over x402 through Circle Gateway. Payments are signed by Circle's own client
// code (BatchEvmScheme), so these tests prove wire compatibility with the real buyer. The rules: bad input and
// live-check criteria are answered free; a ready result is asked to pay; the payment is checked, verified, balance
// checked and settled before the result goes out; a used payment never buys a second result.
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";

const { fakeGateway, GATEWAY_WALLET, ARC, USDC } = await import("./helpers/fake-gateway.js");
const { createPaidEvaluate, networkFor } = await import("../src/x402-evaluate.js");
const { createX402EvaluateHandler } = await import("../api/x402/evaluate.js");
const { createOpenapiHandler } = await import("../api/openapi.js");
const { openapi } = await import("../src/openapi.js");
const { dryRunEvaluate } = await import("../src/evaluate.js");
const { PRICE_ATOMIC } = await import("../src/x402.js");

const PAYER = privateKeyToAccount(keccak256(toHex("judge-protocol x402 evaluate test payer")));
const BROKE = privateKeyToAccount(keccak256(toHex("judge-protocol x402 evaluate test payer with no balance")));
const FEE_TO = "0xf493CF092768a4B7a533359F28Db82B06D259Dc2";
const ARC_MAINNET = "eip155:5042";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

const CRITERIA = { version: 1, passThreshold: 100, checks: [
  { kind: "length", params: { min: 2, max: 200 }, weight: 1 },
  { kind: "contains", params: { all: ["deterministic"] }, weight: 1 },
] };
const INPUT = { criteria: CRITERIA, deliverable: "a short deterministic deliverable" };
const LIVE = { criteria: { version: 1, checks: [{ kind: "http-endpoint", params: { url: "https://example.com", expectStatus: 200 } }] }, deliverable: "x" };

function setup({ chainId = 5042002, network = ARC, balances = { [PAYER.address]: 1_000_000n }, gateway = {} } = {}) {
  const gw = fakeGateway({ balances, network, ...gateway });
  const paid = createPaidEvaluate({ chainId, facilitator: gw.facilitator, balanceOf: gw.balanceOf, lookupTransfer: gw.lookupTransfer, payTo: FEE_TO,
    resourceUrl: "https://judge.test/api/x402/evaluate" });
  return { gw, paid };
}

/** Exactly what GatewayClient.pay() sends: Circle's scheme signs, then resource + accepted are attached. */
async function payHeader(requiredHeader, signer = PAYER, network = ARC) {
  const required = unb64(requiredHeader);
  const accepted = required.accepts.find((a) => a.network === network && a.extra?.name === "GatewayWalletBatched");
  const created = await new BatchEvmScheme(signer).createPaymentPayload(required.x402Version, accepted);
  return b64({ ...created, resource: required.resource, accepted });
}

test("a ready result gets 402 with Circle Gateway terms, and nothing is verified or settled", async () => {
  const { gw, paid } = setup();
  const r = await paid({ input: INPUT });
  assert.equal(r.status, 402);
  const req = unb64(r.headers["PAYMENT-REQUIRED"]);
  assert.equal(req.x402Version, 2);
  assert.equal(req.resource.url, "https://judge.test/api/x402/evaluate");
  const a = req.accepts[0];
  assert.deepEqual({ scheme: a.scheme, network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo },
    { scheme: "exact", network: ARC, asset: USDC, amount: PRICE_ATOMIC, payTo: FEE_TO });
  assert.equal(a.extra.verifyingContract.toLowerCase(), GATEWAY_WALLET.toLowerCase());
  assert.deepEqual(r.body.accepts, req.accepts);
  assert.equal(r.body.charged, false);
  assert.equal(gw.calls.verify.length + gw.calls.settle.length, 0);
  assert.equal(r.body.score, undefined, "the result is not given away with the terms");
});

test("bad input is answered free, before any terms", async () => {
  const { gw, paid } = setup();
  const noCriteria = await paid({ input: { deliverable: "x" } });
  assert.equal(noCriteria.status, 400);
  assert.equal(noCriteria.body.charged, false);
  const badCriteria = await paid({ input: { criteria: { version: 1, checks: [{ kind: "nope", params: {} }] }, deliverable: "x" } });
  assert.equal(badCriteria.status, 422);
  assert.equal(badCriteria.body.charged, false);
  const both = await paid({ input: { criteria: CRITERIA, deliverable: "x", deliverableBase64: "eA==" } });
  assert.equal(both.status, 400);
  assert.equal(gw.calls.getSupported, 0, "no terms were even fetched");
  assert.equal(gw.calls.verify.length + gw.calls.settle.length, 0);
});

test("criteria that need a live probe are refused free: the paid dry run never makes network requests", async () => {
  const { gw, paid } = setup();
  const r = await paid({ input: LIVE });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /http-endpoint/);
  assert.equal(r.body.charged, false);
  assert.equal(gw.calls.getSupported, 0);
});

test("a paid request gets the exact free result plus a receipt, settled exactly once, with PAYMENT-RESPONSE", async () => {
  const { gw, paid } = setup();
  const required = (await paid({ input: INPUT })).headers["PAYMENT-REQUIRED"];
  const r = await paid({ input: INPUT, paymentHeader: await payHeader(required) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const free = (await dryRunEvaluate(INPUT)).body;
  assert.equal(r.body.score, 100);
  assert.equal(r.body.pass, true);
  assert.equal(r.body.evidenceHash, free.evidenceHash, "the paid result is the free result");
  assert.equal(r.body.criteriaHash, free.criteriaHash);
  assert.equal(r.body.charged, true);
  assert.deepEqual({ amount: r.body.payment.amount, asset: r.body.payment.asset, network: r.body.payment.network, payer: r.body.payment.payer.toLowerCase() },
    { amount: "0.01", asset: "USDC", network: ARC, payer: PAYER.address.toLowerCase() });
  assert.equal(gw.calls.verify.length, 1);
  assert.equal(gw.calls.settle.length, 1);
  const resp = unb64(r.headers["PAYMENT-RESPONSE"]);
  assert.equal(resp.success, true);
  assert.equal(resp.network, ARC);
});

test("a payer with no Gateway balance is told so and nothing is settled", async () => {
  const { gw, paid } = setup();
  const required = (await paid({ input: INPUT })).headers["PAYMENT-REQUIRED"];
  const r = await paid({ input: INPUT, paymentHeader: await payHeader(required, BROKE) });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /insufficient Gateway balance/);
  assert.equal(r.body.charged, false);
  assert.equal(gw.calls.settle.length, 0);
  assert.ok(r.headers["PAYMENT-REQUIRED"], "the terms come back so the client can retry");
});

test("a used payment never buys a second result", async () => {
  const { gw, paid } = setup();
  const required = (await paid({ input: INPUT })).headers["PAYMENT-REQUIRED"];
  const header = await payHeader(required);
  const first = await paid({ input: INPUT, paymentHeader: header });
  assert.equal(first.status, 200);
  const second = await paid({ input: { ...INPUT, deliverable: "another deterministic deliverable" }, paymentHeader: header });
  assert.equal(second.status, 402);
  assert.match(second.body.error, /already used/);
  assert.equal(second.body.score, undefined);
  assert.equal(gw.calls.settle.length, 1);
});

test("a payment that fails to settle gets no result", async () => {
  const { gw, paid } = setup({ balances: { [PAYER.address]: 1_000_000n }, gateway: { fail: { settle: true } } });
  const required = (await paid({ input: INPUT })).headers["PAYMENT-REQUIRED"];
  const r = await paid({ input: INPUT, paymentHeader: await payHeader(required) });
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.match(r.body.error, /could not be settled/);
  assert.equal(r.body.score, undefined, "no result without a settled payment");
  assert.equal(gw.calls.settle.length, 1);
});

test("a tampered payment (wrong amount) is refused locally, before Gateway is asked", async () => {
  const { gw, paid } = setup();
  const required = (await paid({ input: INPUT })).headers["PAYMENT-REQUIRED"];
  const good = unb64(await payHeader(required));
  good.payload.authorization.value = "1";
  const r = await paid({ input: INPUT, paymentHeader: b64(good) });
  assert.equal(r.status, 402);
  assert.equal(gw.calls.verify.length, 0);
  assert.equal(gw.calls.settle.length, 0);
});

test("on Arc mainnet the terms name Arc mainnet and the mainnet Gateway network", async () => {
  const { paid } = setup({ chainId: 5042, network: ARC_MAINNET });
  const r = await paid({ input: INPUT });
  assert.equal(r.status, 402);
  const a = unb64(r.headers["PAYMENT-REQUIRED"]).accepts[0];
  assert.equal(a.network, ARC_MAINNET);
  assert.equal(a.asset, USDC);
  assert.match(r.body.error, /Arc mainnet/);
  assert.equal(networkFor(5042).gatewayUrl, "https://gateway-api.circle.com");
  assert.equal(networkFor(5042002).gatewayUrl, "https://gateway-api-testnet.circle.com");
  assert.equal(networkFor(1), null);
  const paidMainnet = await paid({ input: INPUT, paymentHeader: await payHeader(r.headers["PAYMENT-REQUIRED"], PAYER, ARC_MAINNET) });
  assert.equal(paidMainnet.status, 200, JSON.stringify(paidMainnet.body));
  assert.equal(paidMainnet.body.payment.network, ARC_MAINNET);
});

/** A minimal Vercel-style req/res pair. */
function fakeReqRes({ method = "POST", body, headers = {} } = {}) {
  const req = { method, body, headers: { host: "judge.test", ...headers } };
  const res = { statusCode: 0, headers: {}, body: undefined, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; } };
  return { req, res };
}

test("the handler: 404 on a chain with no Gateway network, 405 on GET, 402 then 200 on Arc testnet", async () => {
  const other = createX402EvaluateHandler({ chainId: 1 });
  let { req, res } = fakeReqRes();
  await other(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.charged, false);

  const gw = fakeGateway({ balances: { [PAYER.address]: 1_000_000n } });
  const h = createX402EvaluateHandler({ chainId: 5042002, facilitator: gw.facilitator, balanceOf: gw.balanceOf, lookupTransfer: gw.lookupTransfer, payTo: FEE_TO });
  ({ req, res } = fakeReqRes({ method: "GET" }));
  await h(req, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.spec, "/api/openapi");

  ({ req, res } = fakeReqRes({ body: INPUT }));
  await h(req, res);
  assert.equal(res.statusCode, 402);
  const required = res.headers["payment-required"];
  assert.equal(unb64(required).resource.url, "https://judge.test/api/x402/evaluate", "the resource URL comes from the request host");

  ({ req, res } = fakeReqRes({ body: INPUT, headers: { "payment-signature": await payHeader(required) } }));
  await h(req, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.charged, true);
  assert.ok(res.headers["payment-response"]);
});

test("GET /api/openapi describes the live routes with the right price and network", async () => {
  const h = createOpenapiHandler({ chainId: 5042 });
  const { req, res } = fakeReqRes({ method: "GET" });
  await h(req, res);
  assert.equal(res.statusCode, 200);
  const spec = res.body;
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(spec.servers, [{ url: "https://judge.test" }]);
  for (const p of ["/api/evaluate", "/api/x402/evaluate", "/api/judge", "/api/erc8412", "/api/arcbounty", "/api/health", "/api/openapi"]) {
    assert.ok(spec.paths[p], `documents ${p}`);
  }
  const paidOp = spec.paths["/api/x402/evaluate"].post;
  assert.match(paidOp.summary, /0\.01 USDC/);
  assert.match(paidOp.description, /Arc mainnet/);
  assert.ok(paidOp.responses["402"]);
  assert.ok(paidOp.requestBody.content["application/json"].schema.properties.criteria.properties.checks);
  assert.match(openapi({ chainId: 5042002 }).info.description, /Arc testnet/);
  const { req: r2, res: s2 } = fakeReqRes({ method: "POST" });
  await h(r2, s2);
  assert.equal(s2.statusCode, 405);
});

test("Gateway's own verify has the last word: a payment it rejects gets no result and is never settled", async () => {
  const gw = fakeGateway({ balances: { [PAYER.address]: 1_000_000n } });
  const facilitator = { ...gw.facilitator, verify: async () => ({ isValid: false, invalidReason: "nonce_already_used" }) };
  const paid = createPaidEvaluate({ chainId: 5042002, facilitator, balanceOf: gw.balanceOf, lookupTransfer: gw.lookupTransfer, payTo: FEE_TO });
  const required = (await paid({ input: INPUT })).headers["PAYMENT-REQUIRED"];
  const r = await paid({ input: INPUT, paymentHeader: await payHeader(required) });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /rejected by Circle Gateway: nonce_already_used/);
  assert.equal(r.body.score, undefined);
  assert.equal(gw.calls.settle.length, 0);
});
