// The receipt checker that runs in the buyer's browser: given a Judge Pay receipt and the delivered file, it
// recomputes everything the receipt claims. Receipts here come from the escrow's own receiptOf over verdicts from
// the real engine; every tampered copy must fail at the step that owns the field, even when its hash is redone.
import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { dryRunEvaluate } from "../engine/evaluate.js";
import { receiptOf } from "../src/escrow.js";
import { toCents, fromCents, payoutCents } from "../src/money.js";
import { checkReceipt, payoutOf } from "../public/receipt/check.js";

const CRITERIA = { version: 1, passThreshold: 100, checks: [
  { kind: "contains", params: { all: ["SteelSip", "750 ml"] }, weight: 2 },
  { kind: "length", params: { min: 5, max: 40, unit: "words" }, weight: 1 },
] };
const GOOD = "SteelSip keeps 750 ml of water cold all day, and it fits every cup holder we tried.";
const BAD = "A lovely bottle for every day.";

async function judged(text, { id = "1792000000000101", price = "5.00", feeBps = 500, paypal = {} } = {}) {
  const r = await dryRunEvaluate({ criteria: CRITERIA, deliverable: text, jobId: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body;
  const cents = toCents(price);
  return {
    id, title: "Blurb for a steel bottle", task: "Write a blurb", criteria: CRITERIA, criteriaHash: v.criteriaHash,
    price: { currency: "USD", value: fromCents(cents), cents }, feeBps,
    payout: { currency: "USD", value: fromCents(payoutCents(cents, feeBps)), cents: payoutCents(cents, feeBps) },
    deliverable: { keccak: v.deliverable, bytes: Buffer.byteLength(text), contentType: "text/plain", submittedAt: "2026-10-23T09:00:00.000Z" },
    verdict: { results: v.results, score: v.score, threshold: v.threshold, pass: v.pass, evidenceHash: v.evidenceHash },
    decision: v.pass ? "release" : "refund",
    paypal,
  };
}

const bytesOf = (s) => new TextEncoder().encode(s);
const step = (out, name) => out.steps.find((s) => s.name === name);

/** A tampered receipt whose receiptHash was redone the way the server does it, so only deeper steps can catch it. */
function rehash(receipt) {
  const { receiptHash, ...rest } = receipt;
  const sort = (x) => Array.isArray(x) ? x.map(sort)
    : x && typeof x === "object" ? Object.keys(x).sort().reduce((a, k) => { a[k] = sort(x[k]); return a; }, {}) : x;
  return { ...rest, receiptHash: keccak256(toBytes(JSON.stringify(sort(rest)))) };
}

test("a genuine release receipt and its delivery check out at every step", async () => {
  const receipt = receiptOf(await judged(GOOD, { paypal: { orderId: "O-1", authorizationId: "A-1", captureId: "C-1", payoutBatchId: "B-1" } }));
  const out = await checkReceipt(receipt, bytesOf(GOOD));
  assert.equal(out.verified, true, JSON.stringify(out.steps, null, 1));
  assert.deepEqual(out.steps.map((s) => s.name), ["format", "receipt hash", "criteria hash", "delivery", "checks", "evidence hash", "decision", "payout", "paypal"]);
  assert.ok(out.steps.every((s) => s.ok === true));
  assert.equal(out.decision, "release");
});

test("a genuine refund receipt checks out too: a failed check is a correct refund, not an error", async () => {
  const receipt = receiptOf(await judged(BAD, { paypal: { orderId: "O-2", authorizationId: "A-2", voided: true } }));
  const out = await checkReceipt(receipt, bytesOf(BAD));
  assert.equal(out.verified, true, JSON.stringify(out.steps, null, 1));
  assert.equal(out.decision, "refund");
  assert.match(step(out, "checks").detail, /contains/);
});

test("without the delivered file nothing is called verified, and the page says what is missing", async () => {
  const receipt = receiptOf(await judged(GOOD));
  const out = await checkReceipt(receipt, null);
  assert.equal(out.verified, false);
  for (const name of ["delivery", "checks", "evidence hash"]) assert.equal(step(out, name).ok, null, name);
  assert.match(step(out, "delivery").detail, /add the delivered file/i);
  assert.equal(step(out, "receipt hash").ok, true, "what can be checked without the file still is");
});

test("a different delivery fails at the delivery step, even when only one character changed", async () => {
  const receipt = receiptOf(await judged(GOOD));
  const out = await checkReceipt(receipt, bytesOf(GOOD.replace("cold", "Cold")));
  assert.equal(out.verified, false);
  assert.equal(step(out, "delivery").ok, false);
  assert.match(step(out, "delivery").detail, /does not match/);
});

test("an edited receipt fails its own hash", async () => {
  const receipt = receiptOf(await judged(BAD));
  const out = await checkReceipt({ ...receipt, score: 100, pass: true }, bytesOf(BAD));
  assert.equal(step(out, "receipt hash").ok, false);
  assert.equal(out.verified, false);
});

test("a rehashed lie about the score or the result is caught by recomputing the checks", async () => {
  const receipt = receiptOf(await judged(BAD));
  const lie = rehash({ ...receipt, score: 100, pass: true, decision: "release" });
  const out = await checkReceipt(lie, bytesOf(BAD));
  assert.equal(step(out, "receipt hash").ok, true, "the forger redid the hash");
  assert.equal(step(out, "checks").ok, false);
  assert.equal(out.verified, false);
});

test("a rehashed change to the agreed checks fails the criteria hash", async () => {
  const receipt = receiptOf(await judged(GOOD));
  const softer = { ...receipt.criteria, passThreshold: 50 };
  const out = await checkReceipt(rehash({ ...receipt, criteria: softer }), bytesOf(GOOD));
  assert.equal(step(out, "criteria hash").ok, false);
  assert.equal(out.verified, false);
});

test("a rehashed evidence hash, decision or payout each fail at their own step", async () => {
  const receipt = receiptOf(await judged(GOOD));
  const cases = [
    ["evidence hash", { evidenceHash: "0x" + "11".repeat(32) }],
    ["decision", { decision: "refund" }],
    ["payout", { payout: "5.00" }],
  ];
  for (const [name, change] of cases) {
    const out = await checkReceipt(rehash({ ...receipt, ...change }), bytesOf(GOOD));
    assert.equal(step(out, name).ok, false, name);
    assert.equal(out.verified, false, name);
  }
});

test("rehashed edits that keep the overall result are still caught: a check's flag, the score alone, the threshold alone", async () => {
  const receipt = receiptOf(await judged(BAD));
  const flipped = receipt.results.map((x, i) => (i === 0 ? { ...x, pass: !x.pass } : x));
  const cases = [
    ["one check's flag", { results: flipped }],
    ["the score alone", { score: receipt.score === 0 ? 1 : receipt.score - 1 }],
    ["the threshold alone", { threshold: receipt.threshold - 1 }],
  ];
  for (const [what, change] of cases) {
    const out = await checkReceipt(rehash({ ...receipt, ...change }), bytesOf(BAD));
    assert.equal(step(out, "checks").ok, false, what);
    assert.equal(out.verified, false, what);
  }
});

test("rehashed edits to the byte count or to the pass flag alone are caught too", async () => {
  const good = receiptOf(await judged(GOOD));
  const size = await checkReceipt(rehash({ ...good, deliverable: { ...good.deliverable, bytes: good.deliverable.bytes + 1 } }), bytesOf(GOOD));
  assert.equal(step(size, "delivery").ok, false, "the same file cannot have another size");
  const bad = receiptOf(await judged(BAD));
  const flag = await checkReceipt(rehash({ ...bad, pass: true, decision: "release" }), bytesOf(BAD));
  assert.equal(step(flag, "decision").ok, true, "the forged decision agrees with the forged flag");
  assert.equal(step(flag, "checks").ok, false, "only re-running the checks shows the flag is false");
  assert.equal(flag.verified, false);
});

test("a complete receipt of another kind is refused at the format step", async () => {
  const receipt = receiptOf(await judged(GOOD));
  const out = await checkReceipt({ ...receipt, kind: "judge-pay/receipt@2" }, bytesOf(GOOD));
  assert.equal(step(out, "format").ok, false);
  assert.equal(out.steps.length, 1);
});

test("a receipt with a check that calls the network is refused, even with a matching criteria hash", async () => {
  const receipt = receiptOf(await judged(GOOD));
  const { criteriaHash } = await import("../engine/criteria.js");
  const criteria = { ...receipt.criteria, checks: [...receipt.criteria.checks, { kind: "http-endpoint", params: { url: "https://example.com", expectStatus: 200 } }] };
  const out = await checkReceipt(rehash({ ...receipt, criteria, criteriaHash: criteriaHash(criteria) }), bytesOf(GOOD));
  assert.equal(step(out, "criteria hash").ok, false);
  assert.match(step(out, "criteria hash").detail, /network/);
  assert.equal(step(out, "checks").ok, null, "never run");
  assert.equal(out.verified, false);
});

test("PayPal records that contradict the decision fail; records not made yet are pending, not wrong", async () => {
  const release = receiptOf(await judged(GOOD, { paypal: { orderId: "O-3", authorizationId: "A-3", voided: true } }));
  assert.equal(step(await checkReceipt(release, bytesOf(GOOD)), "paypal").ok, false, "released yet voided");
  const refund = receiptOf(await judged(BAD, { paypal: { orderId: "O-4", authorizationId: "A-4", captureId: "C-4" } }));
  assert.equal(step(await checkReceipt(refund, bytesOf(BAD)), "paypal").ok, false, "refunded yet captured");
  const early = receiptOf(await judged(GOOD, { paypal: { orderId: "O-5", authorizationId: "A-5" } }));
  const out = await checkReceipt(early, bytesOf(GOOD));
  assert.equal(step(out, "paypal").ok, null);
  assert.match(step(out, "paypal").detail, /not captured yet/i);
  assert.equal(out.verified, false, "money not moved yet: consistent, but not finished");
  const unpaid = receiptOf(await judged(GOOD, { paypal: { orderId: "O-6", authorizationId: "A-6", captureId: "C-6" } }));
  const u = step(await checkReceipt(unpaid, bytesOf(GOOD)), "paypal");
  assert.equal(u.ok, null, "captured, worker not paid yet");
  assert.match(u.detail, /payout has not been sent/);
  const held = receiptOf(await judged(BAD, { paypal: { orderId: "O-7", authorizationId: "A-7" } }));
  const h = step(await checkReceipt(held, bytesOf(BAD)), "paypal");
  assert.equal(h.ok, null, "refund decided, hold not voided yet");
  assert.match(h.detail, /not been released yet/);
});

test("anything that is not a Judge Pay receipt is refused cleanly", async () => {
  for (const bad of [null, "text", [], { kind: "other" }, { kind: "judge-pay/receipt@1" }]) {
    const out = await checkReceipt(bad, bytesOf(GOOD));
    assert.equal(out.verified, false);
    assert.equal(step(out, "format").ok, false, JSON.stringify(bad));
  }
});

test("the browser's payout math is the server's, to the cent", () => {
  for (const price of ["1.00", "1.01", "3.33", "5.00", "9.99", "123.45", "500.00"]) {
    for (const fee of [0, 1, 250, 500, 999, 2500, 10_000]) {
      assert.equal(payoutOf(price, fee), fromCents(payoutCents(toCents(price), fee)), `${price} at ${fee}`);
    }
  }
  assert.equal(payoutOf("5.001", 500), null);
  assert.equal(payoutOf("5.00", 10_001), null);
});
