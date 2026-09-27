// A job that names the judge but has no ruling yet: the page must say so plainly
// and offer to ask the judge, and must never present it as verified.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChain } from './helpers/fake-chain.mjs';
import { synthJob } from './helpers/synth.mjs';

const app = await import('../app.js');
const { present } = await import('../present.js');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const LEN = { version: 1, checks: [{ kind: 'length', params: { min: 3 } }] };
const TEXT = 'Some deliverable text that is long enough.';
async function verify(jobs, id) {
  globalThis.fetch = fakeChain({ extraJobs: jobs }).fetch;
  return app.verifyJob(id).catch((e) => ({ jobId: id, checks: [], error: e.message }));
}

test('a Submitted job naming the judge with no verdict is awaiting a ruling, never verified', async () => {
  const jobs = await synthJob({ id: 940001, criteria: LEN, content: TEXT, noVerdict: true });
  const r = await verify(jobs, 940001);
  assert.equal(app.outcome(r), 'awaiting', String(r.error || ''));
  const p = present(r);
  assert.equal(p.headline, 'AWAITING RULING');
  assert.equal(p.color, 'var(--warn)');
  assert.equal(p.canRequestRuling, true);
  assert.notEqual(p.state, 'verified');
});

test('no verdict and not submitted yet: an error that says so, and no ruling button', async () => {
  const jobs = await synthJob({ id: 940002, criteria: LEN, content: TEXT, noVerdict: true, status: 'Funded' });
  const r = await verify(jobs, 940002);
  assert.equal(app.outcome(r), 'error');
  assert.match(r.error, /not been submitted/);
  assert.equal(present(r).canRequestRuling, false);
});

test('no verdict and expired: an error that says the job expired unjudged', async () => {
  const jobs = await synthJob({ id: 940003, criteria: LEN, content: TEXT, noVerdict: true, status: 'Expired' });
  const r = await verify(jobs, 940003);
  assert.equal(app.outcome(r), 'error');
  assert.match(r.error, /expired/);
});

test('a job naming a different evaluator is not ours to rule on', async () => {
  const jobs = await synthJob({ id: 940004, criteria: LEN, content: TEXT, noVerdict: true, evaluator: '0x000000000000000000000000000000000000dEaD' });
  const r = await verify(jobs, 940004);
  assert.equal(app.outcome(r), 'error');
  assert.match(r.error, /different evaluator/);
  assert.equal(present(r).canRequestRuling, false);
});

test('a job id that does not exist is an error, never awaiting', async () => {
  const r = await verify({}, 949999);
  assert.equal(app.outcome(r), 'error');
  assert.equal(present(r).canRequestRuling, false);
});

test('the page knows where the judge API is', () => {
  assert.equal(app.CFG.judgeApi, 'https://judge-protocol-api.vercel.app');
});
