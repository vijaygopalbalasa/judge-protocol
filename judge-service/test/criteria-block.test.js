// Where the judge finds the judge-criteria block in a job description. The answer must be exactly the
// one /```judge-criteria\s*([\s\S]*?)```/ gives, in linear time: a job description on chain is as long
// as its author likes, and that expression backtracks quadratically on an unclosed fence.
import test from "node:test";
import assert from "node:assert/strict";
import { criteriaBlockText, extractCriteria } from "../src/criteria.js";
import { ORACLE, blockCorpus, SLOW_DESCRIPTION } from "./helpers/block-corpus.js";

test("the block text is exactly what the expression finds, on every description in the corpus", () => {
  for (const d of blockCorpus()) assert.equal(criteriaBlockText(d), ORACLE(d), JSON.stringify(d));
});

test("extractCriteria parses that block text and nothing else", () => {
  for (const d of blockCorpus()) {
    const text = ORACLE(d);
    let want = null;
    if (text !== null) { try { want = JSON.parse(text); } catch { want = null; } }
    assert.deepEqual(extractCriteria(d), want, JSON.stringify(d));
  }
  assert.equal(extractCriteria(null), null);
  assert.equal(extractCriteria(undefined), null);
});

test("an unclosed fence followed by two million spaces is answered in milliseconds", () => {
  const t0 = performance.now();
  assert.equal(criteriaBlockText(SLOW_DESCRIPTION), null);
  assert.equal(extractCriteria(SLOW_DESCRIPTION + "```"), null);
  assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms`);
});
