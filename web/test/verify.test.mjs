// In-browser verifier, exercised against a fake chain built from real Arc
// testnet data. The contract of this suite: a genuine settled verdict comes back
// `verified`, and NO tampered, missing or partial input ever does.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  fakeChain, FIXTURE, tamperDeliverable, retargetJobId, replaceWord,
} from './helpers/fake-chain.mjs';

const app = await import('../app.js');
const { verifyJob, outcome, parseJobId } = app;

const FIXTURE_JUDGE = FIXTURE.jobs['171925'] && '6eff7d4bb514d341abed90bf4c667d0a980173ad';
const PASS_JOB = 171925; // on-chain verdict: PASS
const REJECT_JOB = 170856; // on-chain verdict: REJECT
const realFetch = globalThis.fetch;
let chain;
const use = (m) => { chain = fakeChain(m); globalThis.fetch = chain.fetch; };
beforeEach(() => use());
afterEach(() => { globalThis.fetch = realFetch; });

const run = (id, pasted) => verifyJob(id, pasted).catch((e) => ({ jobId: id, checks: [], error: e.message }));

/* ------------------------------ true positives ----------------------------- */

test('a genuine PASS verdict from August verifies end to end with no paste', async () => {
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'verified', JSON.stringify(r.checks, null, 1) + (r.fetchNote || ''));
  assert.equal(r.verdict.pass, true);
  assert.equal(r.deliverableSource, 'submit() calldata');
});

test('a genuine REJECT verdict verifies too (the refund decision is recomputed, not assumed)', async () => {
  const r = await run(REJECT_JOB);
  assert.equal(outcome(r), 'verified', JSON.stringify(r.checks, null, 1) + (r.fetchNote || ''));
  assert.equal(r.verdict.pass, false);
});

test('it respects the endpoint limits: no log query wider than 5,000 blocks, no lookup by pruned tx hash', async () => {
  await run(PASS_JOB);
  const logQueries = chain.calls.filter((c) => c.method === 'eth_getLogs');
  assert.ok(logQueries.length > 0 && logQueries.length <= 12, `log queries: ${logQueries.length}`);
  for (const q of logQueries) {
    const span = Number(BigInt(q.params[0].toBlock) - BigInt(q.params[0].fromBlock)) + 1;
    assert.ok(span <= 5000, `span ${span}`);
  }
  assert.ok(chain.calls.length <= 40, `total rpc calls: ${chain.calls.length}`);
  assert.ok(!chain.calls.some((c) => c.method === 'eth_getTransactionByHash'), 'must not rely on the pruned tx-hash index');
});

test('a transient rate limit is retried, not reported as a mismatch', async () => {
  use({ rateLimitFirst: 2 });
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'verified');
});

test('pasting the correct deliverable verifies; pasting anything else does not', async () => {
  const first = await run(PASS_JOB);
  const good = await run(PASS_JOB, first.deliverable);
  assert.equal(outcome(good), 'verified');
  const bad = await run(PASS_JOB, first.deliverable + ' ');
  assert.equal(outcome(bad), 'mismatch');
});

/* ----------------------------- false positives ----------------------------- */

test('tampered deliverable bytes in calldata: mismatch, never verified', async () => {
  use({ txInput: (id, input) => tamperDeliverable(input) });
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'mismatch');
});

test('a submit tx for a different job id is refused even if its content matches', async () => {
  use({ txInput: (id, input) => retargetJobId(input, 999) });
  const r = await run(PASS_JOB);
  assert.notEqual(outcome(r), 'verified');
});

test('job that names a different evaluator: not verified', async () => {
  use({ job: (id, h) => h.replaceAll(FIXTURE_JUDGE, 'a'.repeat(40)) });
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'mismatch');
});

test('criteria hash on the verdict does not match the job description: not verified', async () => {
  use({ verdict: (id, h) => replaceWord(h, 1, 'ff'.repeat(32)) });
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'mismatch');
});

test('verdict score altered on-chain: not verified', async () => {
  use({ verdict: (id, h) => replaceWord(h, 3, '63') }); // 99 instead of 100
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'mismatch');
});

test('evidence hash altered: not verified', async () => {
  use({ verdict: (id, h) => replaceWord(h, 6, '11'.repeat(32)) });
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'mismatch');
});

test('pass flag flipped on the verdict: not verified', async () => {
  use({ verdict: (id, h) => replaceWord(h, 5, '0') });
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'mismatch');
});

test('a job with no verdict recorded is an error, never verified', async () => {
  const r = await run(123456);
  assert.equal(outcome(r), 'error');
});

test('description without a judge-criteria block is an error, never verified', async () => {
  const tag = Buffer.from('judge-criteria').toString('hex');
  const broken = Buffer.from('judge-critirea').toString('hex');
  use({ job: (id, h) => h.replace(tag, broken) });
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'error');
});

test('if the deliverable cannot be fetched, the result is incomplete, not mismatch and not verified', async () => {
  use({ fail: 'eth_getLogs' });
  const r = await run(PASS_JOB);
  assert.equal(outcome(r), 'incomplete');
  assert.equal(r.incomplete.reason, 'rpc-error');
  assert.equal(r.needsDeliverable, false); // pasting cannot help while the commitment is unknown
});

/* ----------------------------- outcome() itself ---------------------------- */

test('outcome(): an empty check list is never verified (the every([]) trap)', () => {
  assert.notEqual(outcome({ checks: [] }), 'verified');
  assert.notEqual(outcome({ checks: [], verified: true }), 'verified');
});

test('outcome(): an error wins over any passing checks', () => {
  assert.equal(outcome({ error: 'x', checks: [{ id: 'evaluator', ok: true }] }), 'error');
});

test('outcome(): all checks ok but a required one missing is not verified', () => {
  const partial = { checks: [{ id: 'evaluator', ok: true }, { id: 'criteriaHash', ok: true }] };
  assert.notEqual(outcome(partial), 'verified');
});

/* -------------------------------- parseJobId ------------------------------- */

test('parseJobId accepts plain positive integers, with surrounding spaces', () => {
  assert.equal(parseJobId('171925'), 171925);
  assert.equal(parseJobId('  42 '), 42);
  assert.equal(parseJobId('007'), 7);
});

test('parseJobId rejects everything else instead of guessing', () => {
  for (const bad of ['', ' ', '0', '-5', '12abc', '1e5', '171925.5', '0x10', '+3', '1 2',
    '9'.repeat(20), null, undefined, '٣']) {
    assert.equal(parseJobId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

