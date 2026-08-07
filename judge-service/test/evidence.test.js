// Evidence-hashing tests. The claimed differentiator is "verifiable reasoning":
// a third party must be able to recompute evidenceHash from inputs alone. That
// only holds if the hash is a pure function of the reproducible core and is
// invariant to wall-clock time, key order, and non-reproducible probe output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceCore, evidenceHashOf } from "../src/evidence.js";

const base = {
  jobId: "170521",
  criteriaHash: "0x9b2b732563a22ef61ba2a48dd6f9eae1a59724926c1d7a3e21bfda21dcfff2d6",
  deliverable: "0x4c5568398a9872a61017f57d995c215d9f2d1a2554c8a8834b5ab00b0d136d3a",
  criteria: { version: 1, passThreshold: 100, checks: [{ kind: "length", params: { min: 1 }, weight: 1 }] },
  results: [{ kind: "length", pass: true, weight: 1, detail: "words=20 (need 1–∞)" }],
  score: 100,
  threshold: 100,
  pass: true,
};

test("evidence core excludes wall-clock timestamps and probe artifacts", () => {
  const core = evidenceCore(base);
  assert.ok(!("startedAt" in core));
  assert.ok(!("finishedAt" in core));
  assert.ok(!("judge" in core));
  // per-check detail (which can carry live bodySha) is excluded from the core
  assert.ok(core.checks.every((c) => !("detail" in c)));
});

test("evidenceHash is invariant to timestamps and extra human fields", () => {
  const withTimestamps = { ...base, startedAt: "2026-08-07T00:00:00Z", finishedAt: "2026-08-07T00:05:00Z", judge: "0xabc" };
  assert.equal(evidenceHashOf(base), evidenceHashOf(withTimestamps));
});

test("evidenceHash is invariant to key order in criteria (canonicalized)", () => {
  const reordered = {
    ...base,
    criteria: { checks: [{ weight: 1, params: { min: 1 }, kind: "length" }], passThreshold: 100, version: 1 },
  };
  assert.equal(evidenceHashOf(base), evidenceHashOf(reordered));
});

test("evidenceHash changes when a load-bearing field changes", () => {
  assert.notEqual(evidenceHashOf(base), evidenceHashOf({ ...base, score: 99 }));
  assert.notEqual(evidenceHashOf(base), evidenceHashOf({ ...base, pass: false }));
  assert.notEqual(evidenceHashOf(base), evidenceHashOf({ ...base, threshold: 50 }));
});

test("evidenceHash is a stable 32-byte hex value", () => {
  const h = evidenceHashOf(base);
  assert.match(h, /^0x[0-9a-f]{64}$/);
  assert.equal(evidenceHashOf(base), h); // repeatable
});
