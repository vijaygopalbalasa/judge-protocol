// The escrow against the PayPal sandbox stand-in: a pass captures and pays the worker, a fail voids the hold, a
// missed deadline voids it, and no timeout, retry or replay ever charges twice or loses a payment.
import test from "node:test";
import assert from "node:assert/strict";
import { createEscrow, publicView, receiptOf, checkCriteria, newJobId, EscrowError } from "../src/escrow.js";
import { createPayPal } from "../src/paypal.js";
import { memoryStore } from "../src/store.js";
import { dryRunEvaluate } from "../engine/evaluate.js";
import { fakePayPal } from "./helpers/fake-paypal.js";

const CRITERIA = { version: 1, passThreshold: 100, checks: [
  { kind: "contains", params: { all: ["refund", "receipt"] }, weight: 1 },
  { kind: "length", params: { min: 5, max: 200 }, weight: 1 },
] };
const GOOD = "Every refund comes with a receipt the buyer can check.";
const BAD = "Short answer without the two words.";

function setup({ clock = { t: Date.parse("2026-10-22T10:00:00Z") }, ...opts } = {}) {
  const fake = fakePayPal({ now: () => clock.t });
  const paypal = createPayPal({ clientId: "client-id", clientSecret: "client-secret", fetchImpl: fake.fetch, now: () => clock.t });
  let n = 0;
  const escrow = createEscrow({ paypal, store: memoryStore(), now: () => clock.t, publicUrl: "https://pay.example",
    idgen: () => String(1_792_000_000_000_000 + ++n), tokengen: () => `token-${n}`, ...opts });
  return { fake, paypal, escrow, clock };
}

async function funded(env, over = {}) {
  const job = await env.escrow.postJob({ title: "Refund policy line", task: "Write one line about refunds and receipts.",
    criteria: CRITERIA, price: "5.00", workerEmail: "worker@personal.example.com", ...over });
  const { orderId } = await env.escrow.createOrder(job.id);
  env.fake.approve(orderId);
  return env.escrow.authorize(job.id, orderId);
}

test("a pass: the held payment is captured once and the worker is paid the price less the fee", async () => {
  const env = setup();
  const before = env.fake.balance;
  const job = await funded(env);
  assert.equal(job.status, "funded");
  assert.equal(env.fake.authorization(job.paypal.authorizationId).status, "CREATED", "held, not taken");
  assert.equal(env.fake.order(job.paypal.orderId).purchase_units[0].custom_id, job.criteriaHash, "the checks are pinned on PayPal's record");

  const done = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD });
  assert.equal(done.verdict.score, 100);
  assert.equal(done.decision, "release");
  assert.equal(done.status, "paid", "captured, paid out, and PayPal reported the item paid");
  const cap = env.fake.capture(done.paypal.captureId);
  assert.equal(cap.amount.value, "5.00");
  assert.equal(cap.invoice_id, `JP-${job.id}`);
  assert.match(cap.note_to_payer, /every agreed check passed/);
  const payout = env.fake.payout(done.paypal.payoutBatchId);
  assert.equal(payout.items[0].payout_item.amount.value, "4.75", "5% platform fee");
  assert.equal(payout.items[0].payout_item.receiver, "worker@personal.example.com");
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/capture")).length, 1);
  assert.equal(env.fake.balance, before + Math.round(500 - (500 * 349) / 10_000) - 49 - 475, "capture net in, payout out");
  assert.deepEqual(done.events.map((e) => e.type), ["posted", "order-created", "funded", "judged", "captured", "payout-sent", "paid"]);
});

test("a fail: the hold is voided, nothing is captured and nobody is paid", async () => {
  const env = setup();
  const job = await funded(env);
  const done = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: BAD });
  assert.equal(done.verdict.pass, false);
  assert.equal(done.verdict.score, 50);
  assert.equal(done.status, "refunded");
  assert.equal(env.fake.authorization(job.paypal.authorizationId).status, "VOIDED");
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/capture") || c.path === "/v1/payments/payouts").length, 0);
});

test("the verdict is exactly Judge's: the evidenceHash is the dry run's for the same job, checks and bytes", async () => {
  const env = setup();
  const job = await funded(env);
  const done = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD });
  const ref = await dryRunEvaluate({ criteria: CRITERIA, deliverable: GOOD, jobId: job.id });
  assert.equal(done.verdict.evidenceHash, ref.body.evidenceHash);
  assert.equal(done.verdict.criteriaHash, job.criteriaHash);
  const r = receiptOf(done);
  assert.equal(r.evidenceHash, ref.body.evidenceHash);
  assert.equal(r.decision, "release");
  assert.match(r.receiptHash, /^0x[0-9a-f]{64}$/);
  assert.equal(receiptOf({ ...done, decision: "refund" }).receiptHash === r.receiptHash, false, "the hash covers the decision");
  assert.equal(publicView(done).workerToken, undefined, "the public view never shows the worker's token");
});

test("only the named worker can deliver, only once, and only while funded", async () => {
  const env = setup();
  const job = await env.escrow.postJob({ title: "t", task: "x", criteria: CRITERIA, price: "5", workerEmail: "w@personal.example.com" });
  await assert.rejects(env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD }), (e) => e.status === 409 && /only while it is funded/.test(e.message), "not funded yet");
  const f = await funded(env);
  await assert.rejects(env.escrow.deliver(f.id, { workerToken: "token-x", content: GOOD }), (e) => e.status === 403);
  await assert.rejects(env.escrow.deliver(f.id, { workerToken: "", content: GOOD }), (e) => e.status === 403);
  await assert.rejects(env.escrow.deliver(f.id, { workerToken: f.workerToken }), (e) => e.status === 400, "no content");
  await assert.rejects(env.escrow.deliver(f.id, { workerToken: f.workerToken, content: "" }), /empty/);
  await env.escrow.deliver(f.id, { workerToken: f.workerToken, content: GOOD });
  await assert.rejects(env.escrow.deliver(f.id, { workerToken: f.workerToken, content: GOOD }), (e) => e.status === 409, "a second delivery");
});

test("authorize checks the order is this job's, on this job's terms", async () => {
  const env = setup();
  const a = await env.escrow.postJob({ title: "a", task: "x", criteria: CRITERIA, price: "5", workerEmail: "w@personal.example.com" });
  const b = await env.escrow.postJob({ title: "b", task: "x", criteria: CRITERIA, price: "50", workerEmail: "w@personal.example.com" });
  const oa = await env.escrow.createOrder(a.id);
  const ob = await env.escrow.createOrder(b.id);
  env.fake.approve(oa.orderId);
  env.fake.approve(ob.orderId);
  await assert.rejects(env.escrow.authorize(b.id, oa.orderId), /does not belong/, "a cheaper job's approval cannot fund this one");
  env.fake.order(ob.orderId).purchase_units[0].amount.value = "1.00"; // tampered terms
  await assert.rejects(env.escrow.authorize(b.id, ob.orderId), /terms/);
  const ok = await env.escrow.authorize(a.id, oa.orderId);
  assert.equal(ok.status, "funded");
  assert.equal((await env.escrow.authorize(a.id, oa.orderId)).paypal.authorizationId, ok.paypal.authorizationId, "authorize is idempotent");
});

test("every term on PayPal's order is checked one by one before the hold is accepted", async () => {
  const tamper = {
    reference_id: (pu) => { pu.reference_id = "9999999999999999"; },
    custom_id: (pu) => { pu.custom_id = "0x" + "00".repeat(32); },
    invoice_id: (pu) => { pu.invoice_id = "JP-other"; },
    currency: (pu) => { pu.amount.currency_code = "EUR"; },
    amount: (pu) => { pu.amount.value = "4.99"; },
  };
  for (const [field, change] of Object.entries(tamper)) {
    const env = setup();
    const job = await env.escrow.postJob({ title: "t", task: "x", criteria: CRITERIA, price: "5", workerEmail: "w@personal.example.com" });
    const { orderId } = await env.escrow.createOrder(job.id);
    env.fake.approve(orderId);
    change(env.fake.order(orderId).purchase_units[0]);
    await assert.rejects(env.escrow.authorize(job.id, orderId), /terms/, field);
    assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/authorize")).length, 0, `${field}: nothing held`);
  }
  const env = setup();
  const job = await env.escrow.postJob({ title: "t", task: "x", criteria: CRITERIA, price: "5", workerEmail: "w@personal.example.com" });
  const { orderId } = await env.escrow.createOrder(job.id);
  env.fake.approve(orderId);
  env.fake.order(orderId).intent = "CAPTURE";
  await assert.rejects(env.escrow.authorize(job.id, orderId), /terms/, "an immediate-capture order is not a hold");
});

test("a payout PayPal has not confirmed (unclaimed) leaves the job captured, not paid", async () => {
  const env = setup();
  const job = await funded(env, { workerEmail: "unclaimed@personal.example.com" });
  const done = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD });
  assert.equal(done.status, "captured");
  assert.equal(done.paypal.payoutItemStatus, "UNCLAIMED");
  assert.equal(done.events.some((e) => e.type === "paid"), false);
});

test("unapproved orders cannot be authorized; a lost authorize answer is recovered from PayPal's order", async () => {
  const env = setup();
  const job = await env.escrow.postJob({ title: "t", task: "x", criteria: CRITERIA, price: "5", workerEmail: "w@personal.example.com" });
  const { orderId } = await env.escrow.createOrder(job.id);
  await assert.rejects(env.escrow.authorize(job.id, orderId), (e) => e.status === 409 && /not approved/.test(e.message));
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/authorize")).length, 0, "PayPal is not asked before approval, so no refusal is ever cached under the real request id");
  env.fake.approve(orderId);
  env.fake.fault("POST /v2/checkout/orders/", "after"); // PayPal authorizes; the answer is lost
  await assert.rejects(env.escrow.authorize(job.id, orderId), /timeout/i);
  const ok = await env.escrow.authorize(job.id, orderId);
  assert.equal(ok.status, "funded");
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/authorize")).length, 1, "authorized once: the retry read the order");
});

test("a capture whose answer was lost is confirmed from PayPal at once: one capture, one payout, paid", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.fault("/capture", "after"); // PayPal captures; the answer never arrives
  const done = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD });
  assert.equal(done.status, "paid", "the authorization reads CAPTURED and the order lists the capture");
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/capture")).length, 1, "never captured twice");
  assert.equal(env.fake.calls.filter((c) => c.path === "/v1/payments/payouts").length, 1);
  assert.equal(done.paypal.captureId, env.fake.order(job.paypal.orderId).purchase_units[0].payments.captures[0].id);
});

test("a capture that failed before PayPal acted is retried on the next sweep with the same request id", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.fault("/capture", "before", 503);
  const mid = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD });
  assert.equal(mid.status, "judged", "verdict recorded, money not moved yet");
  assert.equal(mid.events.at(-1).type, "settle-retry");
  const done = await env.escrow.sweep(job.id);
  assert.equal(done.status, "paid");
  const ids = env.fake.calls.filter((c) => c.path.endsWith("/capture")).map((c) => c.requestId);
  assert.deepEqual(ids, [`${job.id}-capture`, `${job.id}-capture`], "a 5xx keeps the request id");
});

test("a payout that fails for lack of balance is retried on the next sweep until it goes through", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.balance = -10_000; // the capture's net will not cover the payout
  const mid = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD });
  assert.equal(mid.status, "captured");
  assert.equal(mid.events.at(-1).type, "payout-retry");
  env.fake.balance = 100_000;
  const done = await env.escrow.sweep(job.id);
  assert.equal(done.status, "paid");
});

test("a capture that went through long ago, whose replay window passed, is recovered from PayPal's order", async () => {
  const env = setup();
  const job = await funded(env);
  // PayPal captured under the first request id, the answer was lost, and the replay is no longer available.
  await env.paypal.captureAuthorization(job.paypal.authorizationId, { requestId: "someone-else", invoiceId: `JP-${job.id}` });
  const done = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD });
  assert.equal(done.status, "paid");
  assert.ok(done.paypal.captureId, "the capture id came from the order record");
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/capture")).length, 2, "the test's own capture and one refused retry: never a second charge");
});

test("a void whose answer was lost still ends refunded, without a second void", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.fault("/void", "after");
  const mid = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: BAD });
  assert.equal(mid.status, "refunded", "the authorization reads VOIDED, so the refund is confirmed from PayPal");
});

test("no delivery by the deadline: the next read voids the hold and the job expires", async () => {
  const env = setup();
  const job = await funded(env);
  env.clock.t += 73 * 3600_000;
  const done = await env.escrow.sweep(job.id);
  assert.equal(done.status, "expired");
  assert.equal(env.fake.authorization(job.paypal.authorizationId).status, "VOIDED");
  await assert.rejects(env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD }), (e) => e.status === 409);
});

test("a pass on a hold PayPal already voided ends failed, not retried forever, and nobody is charged", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.voidAuthorizationNow(job.paypal.authorizationId);
  const done = await env.escrow.deliver(job.id, { workerToken: job.workerToken, content: GOOD });
  assert.equal(done.status, "failed");
  assert.match(done.events.at(-1).detail, /VOIDED/);
});

test("a stale order is replaced; an authorized one never is", async () => {
  const env = setup();
  const job = await env.escrow.postJob({ title: "t", task: "x", criteria: CRITERIA, price: "5", workerEmail: "w@personal.example.com" });
  const first = await env.escrow.createOrder(job.id);
  assert.equal((await env.escrow.createOrder(job.id)).orderId, first.orderId, "the same order while it is live");
  env.fake.dropOrder(first.orderId);
  const second = await env.escrow.createOrder(job.id);
  assert.notEqual(second.orderId, first.orderId, "PayPal no longer knows the first one");
  env.fake.approve(second.orderId);
  env.fake.fault("POST /v2/checkout/orders/", "after");
  await assert.rejects(env.escrow.authorize(job.id, second.orderId));
  assert.equal((await env.escrow.createOrder(job.id)).orderId, second.orderId, "an authorized order is kept, never replaced");
  assert.equal((await env.escrow.authorize(job.id, second.orderId)).status, "funded");
});

test("jobs take only valid, deterministic checks and sane terms", async () => {
  const env = setup();
  const base = { title: "t", task: "x", criteria: CRITERIA, price: "5", workerEmail: "w@personal.example.com" };
  const live = { version: 1, checks: [{ kind: "http-endpoint", params: { url: "https://example.com" } }] };
  await assert.rejects(env.escrow.postJob({ ...base, criteria: live }), /deterministic checks only.*http-endpoint/);
  await assert.rejects(env.escrow.postJob({ ...base, criteria: { version: 1, checks: [{ kind: "nope", params: {} }] } }), /invalid criteria/);
  await assert.rejects(env.escrow.postJob({ ...base, price: "0.50" }), /between/);
  await assert.rejects(env.escrow.postJob({ ...base, price: "5.001" }), /amount/);
  await assert.rejects(env.escrow.postJob({ ...base, workerEmail: "not-an-email" }), /PayPal email/);
  await assert.rejects(env.escrow.postJob({ ...base, title: "x".repeat(81) }), /title/);
  await assert.rejects(env.escrow.get("../etc/passwd"), (e) => e instanceof EscrowError && e.status === 400);
  await assert.rejects(env.escrow.get("1234567"), (e) => e.status === 404);
  assert.equal(checkCriteria(CRITERIA), CRITERIA);
  assert.match(newJobId(1_792_000_000_000), /^1792000000000[0-9]{3}$/);
});
