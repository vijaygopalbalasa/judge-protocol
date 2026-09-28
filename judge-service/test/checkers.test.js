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
  LIMITS,
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

/* ---- one shared list of cases: the judge, the kit and the verifier must agree ---- */
import { CRITERIA_CASES } from "./helpers/criteria-cases.js";

test("every shared criteria case gets the expected answer, and invalid ones abstain instead of crashing", async () => {
  for (const [label, criteria, valid] of CRITERIA_CASES) {
    let v;
    assert.doesNotThrow(() => { v = validateCriteria(criteria); }, `${label}: the validator itself must never throw`);
    assert.equal(v.valid, valid, `${label}: ${v.reason}`);
    if (!valid) {
      await assert.rejects(runAllChecks(criteria, deliverable), InvalidCriteriaError, `${label}: must abstain, not crash`);
    } else if (!criteria.checks.some((c) => c.kind === "http-endpoint")) {
      const r = await runAllChecks(criteria, deliverable);
      assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100, label);
    }
  }
});

test("a JSON deliverable that is not an object fails the schema check instead of crashing the judge", async () => {
  const criteria = { checks: [{ kind: "schema", params: { required: ["invoiceId"], types: { total: "number" } } }] };
  for (const text of ["42", "null", "\"a string\"", "true"]) {
    const r = await runAllChecks(criteria, { content: Buffer.from(text), source: "test" });
    assert.equal(r.pass, false, text);
    assert.equal(r.score, 0, text);
    assert.match(r.results[0].detail, /not a JSON object/, text);
  }
  const ok = await runAllChecks(criteria, { content: Buffer.from('{"invoiceId":"A-1","total":3}'), source: "test" });
  assert.equal(ok.pass, true);
});

test("defense in depth: a checker that throws anyway becomes an abstention, never a score", async () => {
  const { runCheck } = await import("../src/checkers/index.js");
  await assert.rejects(runCheck({ kind: "contains", params: { all: "not a list" } }, deliverable), InvalidCriteriaError);
});

test("contains with wholeWords: a term must stand on its own, so \"Arc\" does not match inside \"Architecture\"", async () => {
  const c = (text, all, wholeWords = true) => runAllChecks({ checks: [{ kind: "contains", params: { all, wholeWords } }] }, { content: Buffer.from(text), source: "t" });
  assert.equal((await c("A software Architecture paid in USDC.", ["Arc"])).pass, false);
  assert.equal((await c("A software Architecture paid in USDC.", ["Arc"], false)).pass, true, "the default is still a plain substring");
  for (const ok of ["Built on Arc.", "Arc, the chain", "(Arc)", "Arc-based", "ERC-8183 on Arc"]) assert.equal((await c(ok, ["Arc"])).pass, true, ok);
  for (const no of ["Arcade", "reArc", "Arc_2", "Arcé", "ARC"]) assert.equal((await c(no, ["Arc"])).pass, false, no);
  assert.equal((await c("Pays in USDC, settles on ERC-8183.", ["ERC-8183", "USDC"])).pass, true, "terms with punctuation");
  assert.equal((await c("a.b?c", ["b?c"])).pass, true, "regex characters in a term are literal");
  assert.equal((await c("abbc", ["b?c"])).pass, false);
});

test("schema: only a real JSON object, and only its own fields, can satisfy it", async () => {
  const run = (text, params) => runAllChecks({ checks: [{ kind: "schema", params }] }, { content: Buffer.from(text), source: "t" });
  assert.equal((await run("[]", { required: [] })).pass, false, "an array is not an object");
  assert.equal((await run("[1,2]", { required: ["length"] })).pass, false, "an array's length is not a field");
  assert.equal((await run("{}", { required: ["constructor"] })).pass, false, "inherited properties are not fields");
  assert.equal((await run("{}", { types: { toString: "object" } })).pass, true, "a type check only applies to own fields that exist");
  assert.equal((await run('{"constructor":1}', { required: ["constructor"], types: { constructor: "number" } })).pass, true);
});

test("a refused list says every limit it enforces, including the per-string cap", () => {
  const long = "x".repeat(LIMITS.termChars + 1);
  for (const [kind, params] of [["http-endpoint", { bodyIncludes: [long] }], ["schema", { required: [long] }], ["contains", { all: [long] }]]) {
    const v = validateCriteria({ checks: [{ kind, params }] });
    assert.equal(v.valid, false, kind);
    assert.match(v.reason, new RegExp(`at most ${LIMITS.termChars} characters`), kind);
  }
});

test("a failed probe says what kind of failure it was, never the addresses behind it", async () => {
  const { runCheck } = await import("../src/checkers/index.js");
  for (const url of ["http://localhost/x", "http://10.9.8.7/x", "https://user:pw@example.com/x"]) {
    const r = await runCheck({ kind: "http-endpoint", params: { url } }, { content: Buffer.from("x") });
    assert.equal(r.pass, false, url);
    assert.match(r.detail, /^fetch failed: /, url);
    assert.doesNotMatch(r.detail, /127\.0\.0\.1|::1|10\.9\.8\.7|resolves to|blocked address|user:pw/, r.detail);
  }
});

// A score used to be round(100 * passing weight / all weight), so a failing
// check whose weight rounds away (1 of 1001) still scored 100 and PASSED a
// passThreshold of 100, which the docs promise means every check must pass.
const HEAVY_LIGHT = (threshold) => ({
  version: 1, ...(threshold === undefined ? {} : { passThreshold: threshold }),
  checks: [
    { kind: "length", params: { min: 1 }, weight: 1000 },          // pass
    { kind: "contains", params: { all: ["ZZZ"] }, weight: 1 },      // fail
  ],
});

test("a threshold of 100 means every check passes, even when a failing check's weight rounds away", async () => {
  for (const threshold of [100, undefined]) {
    const r = await runAllChecks(HEAVY_LIGHT(threshold), deliverable);
    assert.equal(r.pass, false, `threshold ${threshold}: a failed check must fail the job`);
    assert.equal(r.score, 99, "a score of 100 means every check passed");
  }
});

test("the 100 rule changes nothing else: all-pass still scores 100, and lower thresholds keep the documented rounding", async () => {
  const allPass = HEAVY_LIGHT(100);
  allPass.checks[1].params.all = ["hello"];
  assert.deepEqual((({ score, pass }) => ({ score, pass }))(await runAllChecks(allPass, deliverable)), { score: 100, pass: true });
  const r99 = await runAllChecks(HEAVY_LIGHT(99), deliverable);
  assert.deepEqual({ score: r99.score, pass: r99.pass }, { score: 99, pass: true }, "99.9 still clears a threshold of 99");
  // The CRITERIA.md example: weights 2 and 1 at a threshold of 67; 2 of 3 rounds to 67 and passes.
  const doc = { version: 1, passThreshold: 67, checks: [
    { kind: "contains", params: { all: ["hello"] }, weight: 2 },
    { kind: "contains", params: { all: ["ZZZ"] }, weight: 1 },
  ] };
  const rd = await runAllChecks(doc, deliverable);
  assert.deepEqual({ score: rd.score, pass: rd.pass }, { score: 67, pass: true });
});
