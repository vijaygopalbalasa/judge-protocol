// The verifier finds the judge-criteria block exactly where the judge does (and in linear time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { service } from './helpers/synth.mjs';

const app = await import('../app.js');
const { blockCorpus, SLOW_DESCRIPTION } = await import('../../judge-service/test/helpers/block-corpus.js');

test("the verifier's extractCriteria equals the judge's on every description in the corpus", () => {
  for (const d of blockCorpus()) assert.deepEqual(app.extractCriteria(d), service.criteria.extractCriteria(d), JSON.stringify(d));
});

test('the verifier answers an unclosed fence in milliseconds', () => {
  const t0 = performance.now();
  assert.equal(app.extractCriteria(SLOW_DESCRIPTION), null);
  assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms`);
});
