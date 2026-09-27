// What the page says for each outcome. Pure function, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { present, pasteHeadline } from '../present.js';

const base = { jobId: 1, verdict: { pass: true, score: 100, threshold: 100 }, job: { status: 'Completed', budget: 1000000n } };
const ck = (id, ok) => ({ id, ok, label: id });
const ALL = ['evaluator', 'criteriaValid', 'criteriaHash', 'providerCommitment', 'deliverable', 'score', 'threshold', 'pass', 'evidenceHash'];

test('verified, mismatch, incomplete and unsupported each get their own headline and color', () => {
  const v = present({ ...base, checks: ALL.map((i) => ck(i, true)) });
  assert.equal(v.headline, 'VERIFIED'); assert.equal(v.color, 'var(--ok)');
  const m = present({ ...base, checks: ALL.map((i) => ck(i, i !== 'score')) });
  assert.equal(m.headline, 'MISMATCH'); assert.equal(m.color, 'var(--bad)');
  const inc = present({ ...base, needsDeliverable: true, incomplete: { reason: 'rpc-error', note: 'eth_getLogs unavailable' }, checks: [ck('evaluator', true)] });
  assert.equal(inc.headline, 'INCOMPLETE'); assert.equal(inc.color, 'var(--warn)');
  const u = present({ ...base, unsupported: ['http-endpoint'], checks: [ck('evaluator', true)] });
  assert.equal(u.color, 'var(--warn)'); assert.match(u.note, /http-endpoint/); assert.match(u.note, /live network probe/);
  assert.doesNotMatch(u.note, /verify the rest with the CLI/i, 'the CLI cannot replay the probe as the judge saw it either');
});

test('the INCOMPLETE explanation names the real cause', () => {
  const t = (incomplete) => present({ ...base, needsDeliverable: true, incomplete, checks: [] }).incompleteText;
  assert.match(t({ reason: 'remote-uri', uri: 'https://p.example/x' }), /https:\/\/p\.example\/x/);
  assert.match(t({ reason: 'rpc-error', note: 'rate limit exceeded' }), /rate limit exceeded/);
  assert.match(t({ reason: 'rpc-error', note: 'x' }), /try again/i);
  assert.match(t({ reason: 'not-found' }), /hours/i);
  assert.match(t({ reason: 'tx-mismatch', note: 'does not match this job' }), /does not match/i);
  for (const r of ['remote-uri', 'rpc-error', 'not-found', 'tx-mismatch']) {
    assert.doesNotMatch(t({ reason: r, note: 'n', uri: 'u' }), /older than the RPC log window/);
  }
});

test('pill text has no doubled colon and the source line has no doubled word', () => {
  assert.equal(present({ ...base, checks: [] }).pill, 'PASS (escrow released)');
  assert.equal(present({ ...base, verdict: { ...base.verdict, pass: false }, checks: [] }).pill, 'REJECT (client refunded)');
  const s = present({ ...base, deliverableSource: 'submit() calldata', checks: [] }).sourceText;
  assert.equal(s, "Deliverable read from the provider's submit() calldata");
  assert.doesNotMatch(s, /provider's provider/);
  assert.equal(present({ ...base, deliverableSource: 'job description (client-authored)', checks: [] }).sourceText,
    'Deliverable read from the job description (client-authored)');
});

test('the paste headline blames the paste only when the paste is what failed', () => {
  assert.equal(pasteHeadline({ ...base, checks: ALL.map((i) => ck(i, true)) }).text, 'VERIFIED with the pasted deliverable');
  assert.match(pasteHeadline({ ...base, checks: [ck('evaluator', true), ck('deliverable', false)] }).text, /does not match/);
  const other = pasteHeadline({ ...base, checks: ALL.map((i) => ck(i, i !== 'evidenceHash')) });
  assert.match(other.text, /matches, but the recomputation disagrees/);
  assert.equal(pasteHeadline({ ...base, checks: [] }).ok, false);
});
