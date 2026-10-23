// Where a paid route credits its payments. The built-in default wallet is the testnet relayer's hot key: fine for
// testnet, never for real money. On a mainnet network the wallet has to be named on purpose, or the paid route
// refuses to start and charges nobody.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { NETWORKS, resolvePayTo, PayoutAddressError } = await import("../src/x402.js");

const TESTNET = NETWORKS[5042002];
const MAINNET = NETWORKS[5042];
const DEFAULT = "0xf493CF092768a4B7a533359F28Db82B06D259Dc2";
const MINE = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";
const UNSET = { feeAddress: DEFAULT, feeAddressSet: false };
const SET = (a) => ({ feeAddress: a, feeAddressSet: true });

test("only Arc mainnet is marked as real money", () => {
  assert.equal(MAINNET.mainnet, true);
  assert.ok(!TESTNET.mainnet);
});

test("testnet keeps working with the built-in default wallet, so the free demo and the tests need no setup", () => {
  assert.equal(resolvePayTo(TESTNET, undefined, UNSET), DEFAULT);
  assert.equal(resolvePayTo(TESTNET, undefined, SET(MINE)), MINE);
});

test("on mainnet the built-in default is refused: no wallet named, no paid route", () => {
  assert.throws(() => resolvePayTo(MAINNET, undefined, UNSET),
    (e) => e instanceof PayoutAddressError && e.code === "NO_PAYOUT_ADDRESS" && /JUDGE_FEE_ADDRESS/.test(e.message));
});

test("on mainnet a wallet named in JUDGE_FEE_ADDRESS, or passed in, is used", () => {
  assert.equal(resolvePayTo(MAINNET, undefined, SET(MINE)), MINE);
  assert.equal(resolvePayTo(MAINNET, OTHER, UNSET), OTHER, "a wallet passed in beats the unset default");
  assert.equal(resolvePayTo(MAINNET, OTHER, SET(MINE)), OTHER, "a wallet passed in beats the environment");
});

test("a wallet that is not an address, or is the zero address, is refused on every network", () => {
  for (const bad of ["", "0x123", "not an address", `${MINE}00`, ZERO]) {
    for (const net of [TESTNET, MAINNET]) {
      assert.throws(() => resolvePayTo(net, bad, UNSET), (e) => e instanceof PayoutAddressError && e.code === "BAD_PAYOUT_ADDRESS", `${bad} on ${net.label}`);
    }
  }
  assert.throws(() => resolvePayTo(MAINNET, undefined, SET("0xnope")), (e) => e.code === "BAD_PAYOUT_ADDRESS");
  assert.throws(() => resolvePayTo(TESTNET, undefined, SET(ZERO)), (e) => e.code === "BAD_PAYOUT_ADDRESS");
});

test("a mixed-case address with a wrong checksum is refused: it is the typo check for a wallet that receives money", () => {
  const typo = "0xF493CF092768a4B7a533359F28Db82B06D259Dc2"; // the checksummed default with one letter's case flipped
  assert.notEqual(typo, DEFAULT);
  assert.throws(() => resolvePayTo(MAINNET, typo, UNSET), (e) => e.code === "BAD_PAYOUT_ADDRESS");
  assert.throws(() => resolvePayTo(MAINNET, undefined, SET(typo)), (e) => e.code === "BAD_PAYOUT_ADDRESS");
  assert.equal(resolvePayTo(MAINNET, DEFAULT, UNSET), DEFAULT, "the right checksum is accepted");
});

test("an all-lowercase address is accepted and returned checksummed", () => {
  assert.equal(resolvePayTo(MAINNET, DEFAULT.toLowerCase(), UNSET), DEFAULT);
  assert.equal(resolvePayTo(MAINNET, undefined, SET(DEFAULT.toLowerCase())), DEFAULT);
});

// The same rules, through the real environment variable, the real config and the real route. Gateway is stubbed:
// nothing here reaches the network.
const root = fileURLToPath(new URL("..", import.meta.url));
function run(script, env = {}) {
  const clean = { ...process.env };
  delete clean.JUDGE_FEE_ADDRESS;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: { ...clean, ...env }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").at(-1));
}
const STUB = `{ getSupported: async () => ({ kinds: [{ scheme: "exact", network: NET, extra: { verifyingContract: "0x" + "ab".repeat(20) } }] }) }`;
/** Build the paid route the way the handler does (no payTo passed), ask for a result, report the wallet in the terms. */
const TERMS = (chainId, network) => `
  import { createPaidEvaluate } from "./src/x402-evaluate.js";
  const NET = ${JSON.stringify(network)};
  try {
    const paid = createPaidEvaluate({ chainId: ${chainId}, facilitator: ${STUB} });
    const r = await paid({ input: { criteria: { version: 1, checks: [{ kind: "length", params: { min: 1 } }] }, deliverable: "x" } });
    console.log(JSON.stringify({ status: r.status, payTo: r.body.accepts?.[0]?.payTo ?? null }));
  } catch (e) { console.log(JSON.stringify({ threw: e.code ?? e.message })); }
`;
const HANDLER = (chainId) => `
  import { createX402EvaluateHandler } from "./api/x402/evaluate.js";
  const h = createX402EvaluateHandler({ chainId: ${chainId} });
  const req = { method: "POST", body: { criteria: { version: 1, checks: [{ kind: "length", params: { min: 1 } }] }, deliverable: "x" }, headers: { host: "judge.test" } };
  const res = { statusCode: 0, headers: {}, body: undefined, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await h(req, res);
  console.log(JSON.stringify({ status: res.statusCode, body: res.body }));
`;

test("mainnet with JUDGE_FEE_ADDRESS unset: the paid route cannot be built", () => {
  assert.deepEqual(run(TERMS(5042, "eip155:5042")), { threw: "NO_PAYOUT_ADDRESS" });
});

test("mainnet with JUDGE_FEE_ADDRESS set: the 402 terms credit exactly that wallet", () => {
  assert.deepEqual(run(TERMS(5042, "eip155:5042"), { JUDGE_FEE_ADDRESS: MINE }), { status: 402, payTo: MINE });
});

test("testnet with nothing set: the 402 terms credit the built-in default, as before", () => {
  assert.deepEqual(run(TERMS(5042002, "eip155:5042002")), { status: 402, payTo: DEFAULT });
});

test("the mainnet route with no JUDGE_FEE_ADDRESS answers 503 and says why, before it asks anyone to pay", () => {
  const r = run(HANDLER(5042));
  assert.equal(r.status, 503);
  assert.equal(r.body.charged, false);
  assert.match(r.body.error, /payout wallet/i);
  assert.match(r.body.error, /JUDGE_FEE_ADDRESS/);
  assert.match(r.body.error, /free POST \/api\/evaluate/);
  assert.equal(r.body.accepts, undefined, "no payment terms are offered");
});

test("a malformed JUDGE_FEE_ADDRESS fails closed on mainnet with a clear message", () => {
  const r = run(HANDLER(5042), { JUDGE_FEE_ADDRESS: "0xnope" });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not a valid address/i);
  assert.equal(r.body.charged, false);
});

test("a malformed JUDGE_FEE_ADDRESS also stops a testnet route: a typo never silently falls back to the default", () => {
  assert.deepEqual(run(TERMS(5042002, "eip155:5042002"), { JUDGE_FEE_ADDRESS: "0xnope" }), { threw: "BAD_PAYOUT_ADDRESS" });
});

test("an unexpected failure while building the paid route is not explained to the caller", async () => {
  const { createX402EvaluateHandler } = await import("../api/x402/evaluate.js");
  const opts = { chainId: 5042002, get timeoutMs() { throw new Error("secret internal detail"); } };
  const req = { method: "POST", body: { criteria: { version: 1, checks: [{ kind: "length", params: { min: 1 } }] }, deliverable: "x" }, headers: { host: "judge.test" } };
  const res = { statusCode: 0, headers: {}, body: undefined, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await createX402EvaluateHandler(opts)(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.charged, false);
  assert.equal(res.body.error, "temporary failure; you were not charged");
  assert.doesNotMatch(JSON.stringify(res.body), /secret internal detail/);
});
