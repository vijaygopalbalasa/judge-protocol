// The dashboard's row mapping: public job views in, grid rows out. Rows carry only listed fields, so nothing private
// that ever reaches the page can show up in the grid, and the totals count money only once it has really moved.
import test from "node:test";
import assert from "node:assert/strict";
import { publicView } from "../src/escrow.js";
import { toRows, summarize, STATUS } from "../public/dashboard/rows.js";

const job = (over = {}) => ({
  id: "1792000000000201", title: "Blurb for a steel bottle", task: "Write a blurb",
  criteria: { version: 1, passThreshold: 100, checks: [{ kind: "length", params: { min: 5 } }] }, criteriaHash: "0x" + "ab".repeat(32),
  price: { currency: "USD", value: "5.00", cents: 500 }, feeBps: 500, payout: { currency: "USD", value: "4.75", cents: 475 },
  worker: { email: "worker@personal.example.com", keyHash: "secret-hash" },
  status: "posted", createdAt: "2026-10-23T08:00:00.000Z", updatedAt: "2026-10-23T08:00:00.000Z", deadline: "2026-10-26T08:00:00.000Z",
  paypal: {}, deliverable: null, verdict: null, decision: null, events: [{ at: "2026-10-23T08:00:00.000Z", type: "posted" }],
  ...over,
});
const judged = (pass, over = {}) => job({
  status: pass ? "paid" : "refunded", decision: pass ? "release" : "refund",
  deliverable: { base64: "U2VjcmV0IHdvcms=", bytes: 11, keccak: "0x" + "cd".repeat(32), contentType: "text/plain", submittedAt: "2026-10-23T09:00:00.000Z" },
  verdict: { results: [{ kind: "length", pass, weight: 1, detail: "x" }], score: pass ? 100 : 0, threshold: 100, pass, evidenceHash: "0x" + "ef".repeat(32) },
  paypal: pass ? { orderId: "O-1", authorizationId: "A-1", captureId: "C-1", payoutBatchId: "B-1", payoutStatus: "SUCCESS" } : { orderId: "O-2", authorizationId: "A-2", voided: true },
  ...over,
});

test("a row shows the terms, the state, the verdict and PayPal's ids", () => {
  const [row] = toRows([publicView(judged(true))]);
  assert.deepEqual(row, {
    id: "1792000000000201", title: "Blurb for a steel bottle", status: "paid", statusLabel: STATUS.paid,
    price: "5.00", currency: "USD", feePct: 5, payout: "4.75", score: 100, result: "PASS", decision: "release",
    checks: "length: passed", orderId: "O-1", captureId: "C-1", payoutBatchId: "B-1", payoutStatus: "SUCCESS",
    voided: false, underReview: false, createdAt: "2026-10-23T08:00:00.000Z", updatedAt: "2026-10-23T08:00:00.000Z",
    deadline: "2026-10-26T08:00:00.000Z", criteriaHash: "0x" + "ab".repeat(32), evidenceHash: "0x" + "ef".repeat(32),
  });
});

test("a refunded job shows which check failed", () => {
  const [row] = toRows([publicView(judged(false))]);
  assert.equal(row.result, "REJECT");
  assert.equal(row.checks, "length: failed");
  assert.equal(row.voided, true);
  assert.equal(row.captureId, null);
});

test("totals for no jobs, and for jobs in two currencies", () => {
  assert.deepEqual(summarize([]), { jobs: 0, paid: 0, refunded: 0, open: 0, needsAttention: 0, judged: 0, passed: 0, paidOut: "0.00", currency: null });
  const eur = publicView(judged(true, { id: "1792000000000299", price: { currency: "EUR", value: "5.00", cents: 500 } }));
  assert.equal(summarize(toRows([publicView(judged(true)), eur])).currency, "mixed");
});

test("jobs not judged yet have empty verdict cells, not zeros", () => {
  const [row] = toRows([publicView(job())]);
  assert.equal(row.score, null);
  assert.equal(row.result, null);
  assert.equal(row.checks, "");
  assert.equal(row.statusLabel, STATUS.posted);
  const [bare] = toRows([{ id: "1", status: "funded", paypal: {} }]);
  assert.equal(bare.voided, false, "a missing flag is not a void");
  assert.equal(bare.underReview, false);
});

test("nothing private reaches a row, even if a view carries it", () => {
  const leaky = { ...publicView(judged(true)), worker: { email: "worker@personal.example.com" }, buyer: { payerId: "PAYERX" },
    deliverable: { base64: "U2VjcmV0IHdvcms=", keccak: "0x00", bytes: 11 } };
  const text = JSON.stringify(toRows([leaky]));
  for (const secret of ["worker@personal.example.com", "PAYERX", "U2VjcmV0IHdvcms="]) assert.ok(!text.includes(secret), secret);
});

test("an unknown status is shown as it is, and bad input fails loudly", () => {
  const [row] = toRows([publicView(job({ status: "archived" }))]);
  assert.equal(row.statusLabel, "archived");
  assert.throws(() => toRows({ jobs: [] }), /array/);
  assert.throws(() => toRows([null]), /job 0/);
});

test("totals count money only once PayPal has moved it", () => {
  const rows = toRows([
    publicView(judged(true)),
    publicView(judged(true, { id: "1792000000000202", status: "captured", paypal: { orderId: "O-3", captureId: "C-3" } })),
    publicView(judged(false, { id: "1792000000000203" })),
    publicView(job({ id: "1792000000000204", status: "funded" })),
    publicView(job({ id: "1792000000000205", status: "failed" })),
    publicView(judged(true, { id: "1792000000000206", status: "captured", paypal: { orderId: "O-6", captureId: "C-6", payoutReview: { at: "x" } } })),
  ]);
  assert.deepEqual(summarize(rows), {
    jobs: 6, paid: 1, refunded: 1, open: 3, needsAttention: 2, judged: 4, passed: 3, paidOut: "4.75", currency: "USD",
  });
});
