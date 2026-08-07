// Tests for the criteria-validation safety gate. Each of the first four cases
// reproduces a confirmed escrow-steering defect that existed BEFORE the gate;
// the assertions encode the safe post-gate behavior: malformed criteria throw
// InvalidCriteriaError (→ the engine abstains) instead of being scored.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAllChecks,
  validateCriteria,
  InvalidCriteriaError,
} from "../src/checkers/index.js";

const deliverable = { content: Buffer.from("hello world"), source: "test" };

test("DEFECT 1: empty checks + passThreshold 0 no longer releases escrow", async () => {
  // Pre-gate: { results:[], score:0, pass:TRUE } → full escrow released, 0 checks run.
  const criteria = { version: 1, passThreshold: 0, checks: [] };
  assert.equal(validateCriteria(criteria).valid, false);
  await assert.rejects(() => runAllChecks(criteria, deliverable), InvalidCriteriaError);
});

test("DEFECT 2: passThreshold 101 no longer guarantees refund of good work", async () => {
  // Pre-gate: good deliverable scores 100 but pass:false → provider robbed.
  const criteria = { version: 1, passThreshold: 101, checks: [{ kind: "length", params: { min: 1 }, weight: 1 }] };
  assert.equal(validateCriteria(criteria).valid, false);
  await assert.rejects(() => runAllChecks(criteria, deliverable), InvalidCriteriaError);
});

test("DEFECT 3: negative weight no longer overflows uint8 and strands escrow", async () => {
  // Pre-gate: weights [10,-9] → score 1000 (or -25) → viem uint8 encode throws →
  // job silently dropped, escrow stranded to expiry. A client could crash the judge.
  const criteria = {
    version: 1, passThreshold: 50,
    checks: [{ kind: "length", params: { min: 1 }, weight: 10 }, { kind: "length", params: { min: 1 }, weight: -9 }],
  };
  assert.equal(validateCriteria(criteria).valid, false);
  await assert.rejects(() => runAllChecks(criteria, deliverable), InvalidCriteriaError);
});

test("DEFECT 4: unknown checker kind (e.g. code-test) no longer auto-rejects", async () => {
  // Pre-gate: code-test/onchain-state were advertised in docs but unimplemented →
  // scored as failure → anyone following the docs got auto-rejected.
  const criteria = { version: 1, passThreshold: 100, checks: [{ kind: "code-test", params: {}, weight: 1 }] };
  assert.equal(validateCriteria(criteria).valid, false);
  await assert.rejects(() => runAllChecks(criteria, deliverable), InvalidCriteriaError);
});

test("valid criteria still score correctly and encode as uint8", async () => {
  const criteria = {
    version: 1, passThreshold: 100,
    checks: [
      { kind: "length", params: { min: 1, max: 100 }, weight: 1 },
      { kind: "contains", params: { all: ["hello"] }, weight: 1 },
    ],
  };
  assert.equal(validateCriteria(criteria).valid, true);
  const r = await runAllChecks(criteria, deliverable);
  assert.equal(r.pass, true);
  assert.equal(r.score, 100);
  assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100, "score fits uint8");
});

test("partial pass computes a real weighted score in [0,100]", async () => {
  const criteria = {
    version: 1, passThreshold: 50,
    checks: [
      { kind: "contains", params: { all: ["hello"] }, weight: 1 },   // pass
      { kind: "contains", params: { all: ["ZZZ"] }, weight: 1 },     // fail
    ],
  };
  const r = await runAllChecks(criteria, deliverable);
  assert.equal(r.score, 50);
  assert.equal(r.pass, true);
  assert.ok(r.score >= 0 && r.score <= 100);
});

test("passThreshold may be omitted and defaults to all-must-pass (100)", async () => {
  const criteria = { version: 1, checks: [{ kind: "length", params: { min: 1 }, weight: 1 }] };
  assert.equal(validateCriteria(criteria).valid, true);
  const r = await runAllChecks(criteria, deliverable);
  assert.equal(r.threshold, 100);
});
