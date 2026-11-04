// The escrow against the PayPal sandbox stand-in: a pass captures and pays the worker, a fail voids the hold, a
// missed deadline voids it, and no timeout, retry or replay ever charges twice or loses a payment. Only the holder
// of a job's private delivery key can deliver to it; the public view shows hashes and record ids, never bytes or people.
import test from "node:test";
import assert from "node:assert/strict";
import { createEscrow, publicView, receiptOf, checkCriteria, newJobId, hashSecret, EscrowError, SAFE_PAYOUT_REFUSALS } from "../src/escrow.js";
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
const WORKER = "worker@personal.example.com";
const OPERATOR = "operator-secret";

function setup({ clock = { t: Date.parse("2026-10-22T10:00:00Z") }, ...opts } = {}) {
  const fake = fakePayPal({ now: () => clock.t });
  const paypal = createPayPal({ clientId: "client-id", clientSecret: "client-secret", fetchImpl: fake.fetch, now: () => clock.t });
  let n = 0;
  const escrow = createEscrow({ paypal, store: memoryStore(), now: () => clock.t, publicUrl: "https://pay.example",
    idgen: () => String(1_792_000_000_000_000 + ++n), keygen: () => `key-${++n}`, operatorKeyHash: hashSecret(OPERATOR), ...opts });
  return { fake, paypal, escrow, clock };
}

async function posted(env, over = {}) {
  return env.escrow.postJob({ title: "Refund policy line", task: "Write one line about refunds and receipts.", criteria: CRITERIA, price: "5.00", workerEmail: WORKER, ...over });
}
async function funded(env, over = {}) {
  const job = await posted(env, over);
  const { orderId } = await env.escrow.createOrder(job.id);
  env.fake.approve(orderId);
  return { ...await env.escrow.authorize(job.id, orderId), deliveryKey: job.deliveryKey };
}
async function deliver(env, job, content) {
  return env.escrow.deliver(job.id, { workerKey: job.deliveryKey, content });
}

test("a pass: the held payment is captured once and the worker is paid the price less the fee", async () => {
  const env = setup();
  const before = env.fake.balance;
  const job = await funded(env);
  assert.equal(job.status, "funded");
  assert.equal(env.fake.authorization(job.paypal.authorizationId).status, "CREATED", "held, not taken");
  assert.equal(env.fake.order(job.paypal.orderId).purchase_units[0].custom_id, job.criteriaHash, "the checks are pinned on PayPal's record");

  const done = await deliver(env, job, GOOD);
  assert.equal(done.verdict.score, 100);
  assert.equal(done.decision, "release");
  assert.equal(done.status, "paid", "captured, paid out, and PayPal reported the item paid");
  const cap = env.fake.capture(done.paypal.captureId);
  assert.equal(cap.amount.value, "5.00");
  assert.equal(cap.invoice_id, `JP-${job.id}`);
  assert.match(cap.note_to_payer, /every agreed check passed/);
  const payout = env.fake.payout(done.paypal.payoutBatchId);
  assert.equal(payout.items[0].payout_item.amount.value, "4.75", "5% platform fee");
  assert.equal(payout.items[0].payout_item.receiver, WORKER);
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/capture")).length, 1);
  assert.equal(env.fake.balance, before + Math.round(500 - (500 * 349) / 10_000) - 49 - 475, "capture net in, payout out");
  assert.deepEqual(done.events.map((e) => e.type), ["posted", "order-created", "funded", "judged", "captured", "payout-sent", "paid"]);
});

test("a fail: the hold is voided, nothing is captured and nobody is paid", async () => {
  const env = setup();
  const job = await funded(env);
  const done = await deliver(env, job, BAD);
  assert.equal(done.verdict.pass, false);
  assert.equal(done.verdict.score, 50);
  assert.equal(done.status, "refunded");
  assert.equal(env.fake.authorization(job.paypal.authorizationId).status, "VOIDED");
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/capture") || c.path === "/v1/payments/payouts").length, 0);
});

test("the verdict is exactly Judge's: the evidenceHash is the dry run's for the same job, checks and bytes", async () => {
  const env = setup();
  const job = await funded(env);
  const done = await deliver(env, job, GOOD);
  const ref = await dryRunEvaluate({ criteria: CRITERIA, deliverable: GOOD, jobId: job.id });
  assert.equal(done.verdict.evidenceHash, ref.body.evidenceHash);
  assert.equal(done.verdict.criteriaHash, job.criteriaHash);
  const r = receiptOf(done);
  assert.equal(r.evidenceHash, ref.body.evidenceHash);
  assert.equal(r.decision, "release");
  assert.match(r.receiptHash, /^0x[0-9a-f]{64}$/);
  assert.equal(receiptOf({ ...done, decision: "refund" }).receiptHash === r.receiptHash, false, "the hash covers the decision");
});

test("the public view is an allowlist: hashes and record ids, never the bytes, the worker or the buyer", async () => {
  const env = setup();
  const job = await funded(env);
  const done = await deliver(env, job, GOOD);
  const pub = publicView(done);
  assert.deepEqual(Object.keys(pub).sort(), ["createdAt", "criteria", "criteriaHash", "deadline", "decision", "deliverable", "events", "feeBps", "id", "paypal", "payout", "price", "status", "task", "title", "updatedAt", "verdict"].sort());
  assert.equal(pub.deliverable.base64, undefined, "not the delivered bytes");
  assert.equal(pub.deliverable.keccak, done.deliverable.keccak, "only their hash and size");
  assert.equal(pub.worker, undefined, "not the worker's email");
  assert.equal(pub.buyer, undefined, "not the buyer's details");
  assert.deepEqual(Object.keys(pub.paypal).sort(), ["authorizationId", "captureId", "orderId", "payoutBatchId", "payoutItemStatus", "payoutStatus", "underReview", "voided"].sort());
  assert.equal(pub.paypal.payoutBatchId, done.paypal.payoutBatchId);
  assert.equal(JSON.stringify(pub).includes(WORKER), false);
  assert.equal(JSON.stringify(pub).includes("buyer@"), false);
  assert.equal(publicView(null), null);
});

test("each job issues a private delivery key once and stores only its hash", async () => {
  const env = setup();
  const job = await posted(env);
  assert.match(job.deliveryKey, /^key-/);
  const stored = await env.escrow.get(job.id);
  assert.equal(stored.deliveryKeyHash, hashSecret(job.deliveryKey));
  assert.equal(JSON.stringify(stored).includes(job.deliveryKey), false, "the clear key is never persisted");
  assert.equal(JSON.stringify(publicView(job)).includes(job.deliveryKey), false, "the public job never exposes the key");
  assert.equal(JSON.stringify(publicView(job)).includes(job.deliveryKeyHash), false, "the key hash stays private too");
  assert.equal(hashSecret("x"), hashSecret("x"));
  assert.notEqual(hashSecret("x"), hashSecret("y"));
});

test("only the private key for this job can deliver, only once, and only while funded", async () => {
  const env = setup();
  const job = await posted(env);
  await assert.rejects(deliver(env, job, GOOD), (e) => e.status === 409 && /only while it is funded/.test(e.message), "not funded yet");
  const f = await funded(env);
  const other = await posted(env);
  for (const workerKey of ["key-x", "", other.deliveryKey, undefined]) {
    await assert.rejects(env.escrow.deliver(f.id, { workerKey, content: GOOD }), (e) => e.status === 403);
  }
  await assert.rejects(env.escrow.deliver(f.id, { workerKey: f.deliveryKey }), (e) => e.status === 400, "no content");
  await assert.rejects(deliver(env, f, ""), /empty/);
  await deliver(env, f, GOOD);
  await assert.rejects(deliver(env, f, GOOD), (e) => e.status === 409, "a second delivery");
});

test("a worker needs no PayPal login, only the private key for the named payout job", async () => {
  const env = setup();
  const job = await funded(env, { workerEmail: "late@personal.example.com" });
  await assert.rejects(env.escrow.deliver(job.id, { workerKey: "anything", content: GOOD }), (e) => e.status === 403);
  const done = await deliver(env, job, GOOD);
  assert.equal(done.status, "paid");
});

test("authorize checks the order is this job's, on this job's terms", async () => {
  const env = setup();
  const a = await posted(env, { title: "a" });
  const b = await posted(env, { title: "b", price: "50" });
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
    const job = await posted(env);
    const { orderId } = await env.escrow.createOrder(job.id);
    env.fake.approve(orderId);
    change(env.fake.order(orderId).purchase_units[0]);
    await assert.rejects(env.escrow.authorize(job.id, orderId), /terms/, field);
    assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/authorize")).length, 0, `${field}: nothing held`);
  }
  const env = setup();
  const job = await posted(env);
  const { orderId } = await env.escrow.createOrder(job.id);
  env.fake.approve(orderId);
  env.fake.order(orderId).intent = "CAPTURE";
  await assert.rejects(env.escrow.authorize(job.id, orderId), /terms/, "an immediate-capture order is not a hold");
});

test("a payout PayPal has not confirmed (unclaimed) leaves the job captured, not paid", async () => {
  const env = setup();
  const job = await funded(env, { workerEmail: "unclaimed@personal.example.com" });
  const done = await deliver(env, job, GOOD, "unclaimed@personal.example.com");
  assert.equal(done.status, "captured");
  assert.equal(done.paypal.payoutItemStatus, "UNCLAIMED");
  assert.equal(done.events.some((e) => e.type === "paid"), false);
});

test("unapproved orders cannot be authorized; a lost authorize answer is recovered from PayPal's order", async () => {
  const env = setup();
  const job = await posted(env);
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
  const done = await deliver(env, job, GOOD);
  assert.equal(done.status, "paid", "the authorization reads CAPTURED and the order lists the capture");
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/capture")).length, 1, "never captured twice");
  assert.equal(env.fake.calls.filter((c) => c.path === "/v1/payments/payouts").length, 1);
  assert.equal(done.paypal.captureId, env.fake.order(job.paypal.orderId).purchase_units[0].payments.captures[0].id);
});

test("a capture that failed before PayPal acted is retried on the next sweep with the same request id", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.fault("/capture", "before", 503);
  const mid = await deliver(env, job, GOOD);
  assert.equal(mid.status, "judged", "verdict recorded, money not moved yet");
  assert.equal(mid.events.at(-1).type, "settle-retry");
  const done = await env.escrow.sweep(job.id);
  assert.equal(done.status, "paid");
  const ids = env.fake.calls.filter((c) => c.path.endsWith("/capture")).map((c) => c.requestId);
  assert.deepEqual(ids, [`${job.id}-capture`, `${job.id}-capture`], "a 5xx keeps the request id");
});

test("a capture that went through long ago, whose replay window passed, is recovered from PayPal's order", async () => {
  const env = setup();
  const job = await funded(env);
  // PayPal captured under the first request id, the answer was lost, and the replay is no longer available.
  await env.paypal.captureAuthorization(job.paypal.authorizationId, { requestId: "someone-else", invoiceId: `JP-${job.id}` });
  const done = await deliver(env, job, GOOD);
  assert.equal(done.status, "paid");
  assert.ok(done.paypal.captureId, "the capture id came from the order record");
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith("/capture")).length, 2, "the test's own capture and one refused retry: never a second charge");
});

test("a payout refused for lack of funds is retried later under a fresh batch id, once there is balance", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.balance = -10_000; // the capture's net will not cover the payout
  const mid = await deliver(env, job, GOOD);
  assert.equal(mid.status, "captured");
  assert.equal(mid.events.at(-1).type, "payout-retry");
  assert.ok(SAFE_PAYOUT_REFUSALS.has("INSUFFICIENT_FUNDS"));
  env.fake.balance = 100_000;
  const done = await env.escrow.sweep(job.id);
  assert.equal(done.status, "paid");
  const batches = env.fake.calls.filter((c) => c.path === "/v1/payments/payouts").map((c) => c.body.sender_batch_header.sender_batch_id);
  assert.deepEqual(batches, [`JP-${job.id}`, `JP-${job.id}-1`], "a refusal that created nothing allows a fresh batch id");
});

test("a payout whose lost answer can no longer be replayed stops for review: never a second payout under a new id", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.fault("POST /v1/payments/payouts", "after"); // PayPal pays; the answer is lost
  const mid = await deliver(env, job, GOOD);
  assert.equal(mid.status, "captured");
  assert.equal(mid.paypal.payoutAttempt.senderBatchId, `JP-${job.id}`, "the attempt was on record before PayPal was asked");
  const paidOnce = env.fake.balance;
  env.fake.forgetReplays(); // the first request id no longer replays; PayPal now says the batch id exists
  const stopped = await env.escrow.sweep(job.id);
  assert.equal(stopped.status, "captured");
  assert.match(stopped.paypal.payoutReview, /SENDER_BATCH_ID_ALREADY_EXISTS/);
  assert.equal(stopped.events.at(-1).type, "payout-review");
  assert.equal(env.fake.balance, paidOnce, "no second payout left the merchant balance");
  const again = await env.escrow.sweep(job.id);
  assert.equal(again.events.filter((e) => e.type === "payout-review").length, 1, "a review is not retried on its own");
  const sent = env.fake.calls.filter((c) => c.path === "/v1/payments/payouts").map((c) => c.body.sender_batch_header.sender_batch_id);
  assert.deepEqual([...new Set(sent)], [`JP-${job.id}`], "every attempt used this job's one batch id");
  assert.equal(publicView(stopped).paypal.underReview, true);
  // A person finds the batch at PayPal and records it; the job then completes from PayPal's own status.
  const known = env.fake.lastPayoutBatchId();
  await assert.rejects(env.escrow.resolvePayoutReview(job.id, { payoutBatchId: known }), (e) => e.status === 403, "no operator key");
  await assert.rejects(env.escrow.resolvePayoutReview(job.id, { operatorKey: "guess", payoutBatchId: known }), (e) => e.status === 403);
  await assert.rejects(env.escrow.resolvePayoutReview(job.id, { operatorKey: OPERATOR }), (e) => e.status === 400, "one of the two answers is required");
  const done = await env.escrow.resolvePayoutReview(job.id, { operatorKey: OPERATOR, payoutBatchId: known });
  assert.equal(done.status, "paid");
  assert.equal(done.paypal.payoutBatchId, known);
});

test("a recorded batch must be this job's payout at PayPal: its batch id, amount and receiver", async () => {
  const env = setup();
  const other = await funded(env, { title: "other" });
  await deliver(env, other, GOOD); // a real payout for another job
  const otherBatch = env.fake.lastPayoutBatchId();
  const job = await funded(env);
  env.fake.fault("POST /v1/payments/payouts", "before", 400);
  const stopped = await deliver(env, job, GOOD);
  assert.equal(stopped.events.at(-1).type, "payout-review");
  await assert.rejects(env.escrow.resolvePayoutReview(job.id, { operatorKey: OPERATOR, payoutBatchId: otherBatch }), (e) => e.status === 400 && /not this job's payout/.test(e.message));
  await assert.rejects(env.escrow.resolvePayoutReview(job.id, { operatorKey: OPERATOR, payoutBatchId: "BATCH-NOPE" }), (e) => e.status === 400);
  assert.equal((await env.escrow.get(job.id)).paypal.payoutReview !== undefined, true, "still under review");
});

test("without an operator key configured, a review cannot be resolved at all", async () => {
  const env = setup({ operatorKeyHash: undefined });
  const job = await funded(env);
  env.fake.fault("POST /v1/payments/payouts", "before", 400);
  await deliver(env, job, GOOD);
  await assert.rejects(env.escrow.resolvePayoutReview(job.id, { operatorKey: OPERATOR, confirmedNoBatch: true }), (e) => e.status === 403);
});

test("a review resolved as 'no batch exists' retries with a fresh batch id", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.fault("POST /v1/payments/payouts", "before", 400); // a definitive refusal that is not on the safe list
  const stopped = await deliver(env, job, GOOD);
  assert.equal(stopped.events.at(-1).type, "payout-review");
  await assert.rejects(env.escrow.resolvePayoutReview(`${Number(job.id) + 1}`, { operatorKey: OPERATOR, confirmedNoBatch: true }), (e) => e.status === 404);
  await assert.rejects(env.escrow.resolvePayoutReview(job.id, { operatorKey: OPERATOR, confirmedNoBatch: "yes" }), (e) => e.status === 400, "the confirmation is an explicit true");
  const done = await env.escrow.resolvePayoutReview(job.id, { operatorKey: OPERATOR, confirmedNoBatch: true });
  assert.equal(done.status, "paid");
  assert.equal(env.fake.calls.filter((c) => c.path === "/v1/payments/payouts").at(-1).body.sender_batch_header.sender_batch_id, `JP-${job.id}-1`);
  await assert.rejects(env.escrow.resolvePayoutReview(job.id, { operatorKey: OPERATOR, confirmedNoBatch: true }), (e) => e.status === 409, "not under review any more");
});

test("a void whose answer was lost still ends refunded, without a second void", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.fault("/void", "after");
  const mid = await deliver(env, job, BAD);
  assert.equal(mid.status, "refunded", "the authorization reads VOIDED, so the refund is confirmed from PayPal");
});

test("no delivery by the deadline: the next read voids the hold and the job expires", async () => {
  const env = setup();
  const job = await funded(env);
  env.clock.t += 73 * 3600_000;
  const done = await env.escrow.sweep(job.id);
  assert.equal(done.status, "expired");
  assert.equal(env.fake.authorization(job.paypal.authorizationId).status, "VOIDED");
  await assert.rejects(deliver(env, job, GOOD), (e) => e.status === 409);
});

test("a pass on a hold PayPal already voided ends failed, not retried forever, and nobody is charged", async () => {
  const env = setup();
  const job = await funded(env);
  env.fake.voidAuthorizationNow(job.paypal.authorizationId);
  const done = await deliver(env, job, GOOD);
  assert.equal(done.status, "failed");
  assert.match(done.events.at(-1).detail, /VOIDED/);
});

test("a stale order is replaced; an authorized one never is", async () => {
  const env = setup();
  const job = await posted(env);
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
  const base = { title: "t", task: "x", criteria: CRITERIA, price: "5", workerEmail: WORKER };
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
