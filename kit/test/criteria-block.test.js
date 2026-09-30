// The kit finds the judge-criteria block exactly where the judge does (and in linear time).
import test from "node:test";
import assert from "node:assert/strict";

const kit = await import("../judge-kit.js");
const { extractCriteria } = await import("../../judge-service/src/criteria.js");
const { blockCorpus, SLOW_DESCRIPTION } = await import("../../judge-service/test/helpers/block-corpus.js");

test("the kit's extractCriteria equals the judge's on every description in the corpus", () => {
  for (const d of blockCorpus()) assert.deepEqual(kit.extractCriteria(d), extractCriteria(d), JSON.stringify(d));
});

test("the kit answers an unclosed fence in milliseconds", () => {
  const t0 = performance.now();
  assert.equal(kit.extractCriteria(SLOW_DESCRIPTION), null);
  assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms`);
});
