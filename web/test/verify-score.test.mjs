// A score of 100 means every check passed. The score used to be
// round(100 * passing weight / all weight), so a failing check whose weight
// rounds away (1 of 1001) still scored 100 and passed a passThreshold of 100,
// which the docs promise means every check must pass. The browser must score
// exactly like the fixed judge, including when it replays a live probe.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChain } from './helpers/fake-chain.mjs';
import { synthJob } from './helpers/synth.mjs';

const app = await import('../app.js');
const { verifyJob, outcome, runChecks } = app;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const bytes = (s) => new TextEncoder().encode(s);
const TEXT = 'This report covers ERC-8183 escrow on Arc testnet with USDC settlement in detail.';

const heavyLight = (threshold, lightTerm) => ({ version: 1, passThreshold: threshold, checks: [
  { kind: 'length', params: { min: 3 }, weight: 1000 },
  { kind: 'contains', params: { all: [lightTerm] }, weight: 1 },
] });

test('a failing check whose weight rounds away scores 99 and fails a threshold of 100', async () => {
  const r = await runChecks(heavyLight(100, 'NOT-IN-THE-TEXT'), bytes(TEXT));
  assert.deepEqual({ score: r.score, pass: r.pass }, { score: 99, pass: false });
});

test('the same weights with every check passing still score 100, and a threshold of 99 keeps its rounding', async () => {
  const all = await runChecks(heavyLight(100, 'USDC'), bytes(TEXT));
  assert.deepEqual({ score: all.score, pass: all.pass }, { score: 100, pass: true });
  const r99 = await runChecks(heavyLight(99, 'NOT-IN-THE-TEXT'), bytes(TEXT));
  assert.deepEqual({ score: r99.score, pass: r99.pass }, { score: 99, pass: true });
});

test('a live probe that failed with a tiny weight: the judge signs 99 and FAIL, and the browser reproduces it', async () => {
  const criteria = { version: 1, passThreshold: 100, checks: [
    { kind: 'length', params: { min: 3 }, weight: 1000 },
    { kind: 'http-endpoint', params: { url: 'https://example.com/health' }, weight: 1 },
  ] };
  const jobs = await synthJob({ id: 940001, criteria, content: TEXT, assumePass: [true, false] });
  const chain = fakeChain({ extraJobs: jobs });
  globalThis.fetch = chain.fetch;
  const r = await verifyJob(940001);
  assert.equal(r.verdict.score, 99, 'the signed verdict');
  assert.equal(r.verdict.pass, false);
  assert.equal(outcome(r), 'unsupported', JSON.stringify(r.checks));
  assert.deepEqual(r.probeRecorded, [false]);
  for (const id of ['score', 'pass', 'evidenceHash']) assert.ok(r.checks.find((c) => c.id === id)?.ok, id);
});
