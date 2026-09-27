// Parity and binding: the browser must agree with the judge-service's own code
// on every deterministic check, must bind the verdict to the PROVIDER's on-chain
// commitment, and must never call something verified that it could not
// actually recompute. Each test here maps to a finding from the pre-launch
// critique round.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChain } from './helpers/fake-chain.mjs';
import { synthJob, dataUri, service, keccak256 } from './helpers/synth.mjs';

const app = await import('../app.js');
const { verifyJob, outcome } = app;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function verify(jobs, id, opts = {}, pasted) {
  const chain = fakeChain({ extraJobs: jobs, ...opts });
  globalThis.fetch = chain.fetch;
  return verifyJob(id, pasted).catch((e) => ({ jobId: id, checks: [], error: e.message }));
}
const sha256 = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const TEXT = 'This report covers ERC-8183 escrow on Arc testnet with USDC settlement in detail.';

/* --------------------------- checksum checker ------------------------------ */

test('checksum: a genuine PASS verifies (sha256 is recomputed in the browser, not stubbed)', async () => {
  const criteria = { version: 1, checks: [{ kind: 'checksum', params: { sha256: await sha256(Buffer.from(TEXT)) } }] };
  const jobs = await synthJob({ id: 900001, criteria, content: TEXT });
  const r = await verify(jobs, 900001);
  assert.equal(outcome(r), 'verified', JSON.stringify(r.checks));
});

test('checksum: a judge that wrongly REJECTS matching content is caught (never shown as verified)', async () => {
  const criteria = { version: 1, checks: [{ kind: 'checksum', params: { sha256: await sha256(Buffer.from(TEXT)) } }] };
  const lie = { results: [{ kind: 'checksum', weight: 1, pass: false }], score: 0, pass: false };
  const jobs = await synthJob({ id: 900002, criteria, content: TEXT, verdict: lie });
  const r = await verify(jobs, 900002);
  assert.equal(outcome(r), 'mismatch');
});

/* ------------------------- http-endpoint checker --------------------------- */

test('http-endpoint: cannot be replayed in a browser, so the result is unsupported, never verified or mismatch', async () => {
  const criteria = { version: 1, checks: [
    { kind: 'length', params: { min: 3 } },
    { kind: 'http-endpoint', params: { url: 'https://example.com/health' } }] };
  for (const [id, flags] of [[900003, [true, true]], [900004, [true, false]]]) {
    const jobs = await synthJob({ id, criteria, content: TEXT, assumePass: flags });
    const r = await verify(jobs, id);
    assert.equal(outcome(r), 'unsupported', `job ${id}: ${JSON.stringify(r.checks)}`);
  }
});

/* ------------------------ schema parity + validation ----------------------- */

test('schema types are enforced like the service: a genuine REJECT for a type error verifies', async () => {
  const criteria = { version: 1, checks: [{ kind: 'schema', params: { required: ['price'], types: { price: 'number' } } }] };
  const jobs = await synthJob({ id: 900005, criteria, content: '{"price":"12"}' });
  const r = await verify(jobs, 900005);
  assert.equal(r.verdict.pass, false);
  assert.equal(outcome(r), 'verified', JSON.stringify(r.checks));
});

test('schema types: a PASS that ignored the type rule is caught', async () => {
  const criteria = { version: 1, checks: [{ kind: 'schema', params: { required: ['price'], types: { price: 'number' } } }] };
  const lie = { results: [{ kind: 'schema', weight: 1, pass: true }], score: 100, pass: true };
  const jobs = await synthJob({ id: 900006, criteria, content: '{"price":"12"}', verdict: lie });
  assert.equal(outcome(await verify(jobs, 900006)), 'mismatch');
});

test('a verdict on criteria the service refuses to score (empty checks, threshold 0) is caught', async () => {
  const criteria = { version: 1, passThreshold: 0, checks: [] };
  const lie = { results: [], score: 0, threshold: 0, pass: true };
  const jobs = await synthJob({ id: 900007, criteria, content: TEXT, verdict: lie });
  const r = await verify(jobs, 900007);
  assert.equal(outcome(r), 'mismatch', JSON.stringify(r.checks));
});

/* ----------------------- binding to the provider ---------------------------- */

test("a verdict that graded the CLIENT's content instead of the provider's commitment is caught", async () => {
  const clientText = 'Client-written substitute content that the provider never delivered.';
  const criteria = { version: 1, checks: [{ kind: 'length', params: { min: 3 } }] };
  const lie = { deliverable: keccak256(Buffer.from(clientText)) };
  const jobs = await synthJob({
    id: 900008, criteria, content: TEXT,
    providerURI: 'https://provider.example/out.txt',
    descriptionURI: dataUri(Buffer.from(clientText)),
    verdict: lie,
  });
  const r = await verify(jobs, 900008);
  assert.equal(outcome(r), 'mismatch', JSON.stringify(r.checks));
  assert.notEqual(r.deliverableSource, 'submit() calldata');
});

test('provider delivered via https: genuine verdict is incomplete (named URI), never mismatch; paste decides', async () => {
  const criteria = { version: 1, checks: [{ kind: 'contains', params: { all: ['ERC-8183'] } }] };
  const jobs = await synthJob({
    id: 900009, criteria, content: TEXT,
    providerURI: 'https://provider.example/report.txt',
    descriptionURI: dataUri(Buffer.from('client text that must be ignored')),
  });
  const r = await verify(jobs, 900009);
  assert.equal(outcome(r), 'incomplete', JSON.stringify(r.checks));
  assert.equal(r.incomplete.reason, 'remote-uri');
  assert.equal(r.incomplete.uri, 'https://provider.example/report.txt');
  assert.equal(outcome(await verify(jobs, 900009, {}, TEXT)), 'verified');
  assert.equal(outcome(await verify(jobs, 900009, {}, 'client text that must be ignored')), 'mismatch');
});

test('no provider URI at all: falls back to the description, labeled client-authored, still bound to the commitment', async () => {
  const criteria = { version: 1, checks: [{ kind: 'length', params: { min: 3 } }] };
  const jobs = await synthJob({ id: 900010, criteria, content: TEXT, providerURI: null, descriptionURI: dataUri(Buffer.from(TEXT)) });
  const r = await verify(jobs, 900010);
  assert.equal(outcome(r), 'verified', JSON.stringify(r.checks));
  assert.equal(r.deliverableSource, 'job description (client-authored)');
});

test('pasted text cannot reach verified when the provider commitment could not be read', async () => {
  const criteria = { version: 1, checks: [{ kind: 'length', params: { min: 3 } }] };
  const jobs = await synthJob({ id: 900011, criteria, content: TEXT });
  const r = await verify(jobs, 900011, { fail: 'eth_getLogs' }, TEXT);
  assert.equal(outcome(r), 'incomplete');
  assert.equal(r.incomplete.reason, 'rpc-error');
});

/* ------------------------------ raw bytes ---------------------------------- */

test('a binary (non-UTF-8) deliverable is hashed as raw bytes, like the service', async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x41]);
  const criteria = { version: 1, checks: [{ kind: 'checksum', params: { sha256: await sha256(bytes) } }] };
  const jobs = await synthJob({ id: 900012, criteria, content: bytes });
  assert.equal(outcome(await verify(jobs, 900012)), 'verified');
});

test('a base64url data: URI decodes the same way the service decodes it', async () => {
  const bytes = Buffer.from('ü>?~ base64url needs - and _ ' + 'ÿ'.repeat(3), 'utf8');
  const criteria = { version: 1, checks: [{ kind: 'length', params: { min: 1, unit: 'chars' } }] };
  const jobs = await synthJob({ id: 900013, criteria, content: bytes, providerURI: dataUri(bytes, { url: true }) });
  assert.equal(outcome(await verify(jobs, 900013)), 'verified');
});

test('base64 decoding matches Node Buffer on messy input (fuzz)', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_= \n$%.';
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 2000; i++) {
    const s = Array.from({ length: rnd(40) }, () => alphabet[rnd(alphabet.length)]).join('');
    assert.equal(Buffer.from(app.decodeBase64(s)).toString('hex'), Buffer.from(s, 'base64').toString('hex'), JSON.stringify(s));
  }
});

/* -------------------------- network conditions ----------------------------- */

test('a service clock lagging the chain by 10 minutes still verifies', async () => {
  const criteria = { version: 1, checks: [{ kind: 'length', params: { min: 3 } }] };
  const jobs = await synthJob({ id: 900014, criteria, content: TEXT, clockSkewSec: 600 });
  assert.equal(outcome(await verify(jobs, 900014)), 'verified');
});

test('an HTTP 429 with a non-JSON body (Cloudflare style) is retried, not surfaced as an error', async () => {
  const criteria = { version: 1, checks: [{ kind: 'length', params: { min: 3 } }] };
  const jobs = await synthJob({ id: 900015, criteria, content: TEXT });
  assert.equal(outcome(await verify(jobs, 900015, { http429First: 1 })), 'verified');
});

/* ------------------------------ checker parity ----------------------------- */

test('browser checkers and validation agree with the judge-service on a battery of inputs', async () => {
  const contents = ['', 'hello', '{"a":1,"b":"x"}', '{"a":"1"}', 'not json', 'ERC-8183 USDC Arc', '  many   words here  ',
    '42', 'null', '"a string"', 'true', '[1,2]', // valid JSON that is not an object: a failed schema check, never a crash
    Buffer.from([0xff, 0xfe, 0x00]).toString('latin1'), Buffer.from([0xef, 0xbb, 0xbf, 0x41]).toString('latin1')];
  const criteriaList = [
    { checks: [{ kind: 'length', params: { min: 2, max: 3 } }] },
    { checks: [{ kind: 'length', params: { min: 5, unit: 'chars' } }, { kind: 'contains', params: { all: ['USDC'] }, weight: 3 }] },
    { passThreshold: 50, checks: [{ kind: 'schema', params: { required: ['a'], types: { a: 'number', b: 'string' } } }, { kind: 'contains', params: { all: ['a'] } }] },
    { checks: [{ kind: 'checksum', params: { sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' } }] },
    { passThreshold: 0, checks: [{ kind: 'contains', params: { all: [] } }] },
    { checks: [{ kind: 'length', params: { min: 2, max: 2, unit: 'chars' } }] }, // a UTF-8 BOM must be kept, as Buffer does
  ];
  for (const criteria of criteriaList) {
    for (const c of contents) {
      const bytes = Buffer.from(c, 'latin1');
      const want = await service.checkers.runAllChecks(criteria, { content: bytes });
      const got = await app.runChecks(criteria, new Uint8Array(bytes));
      assert.deepEqual(
        { score: got.score, pass: got.pass, threshold: got.threshold, flags: got.results.map((r) => r.pass) },
        { score: want.score, pass: want.pass, threshold: want.threshold, flags: want.results.map((r) => r.pass) },
        `${JSON.stringify(criteria)} on ${JSON.stringify(c)}`,
      );
    }
  }
  const invalid = [null, {}, { checks: [] }, { checks: 'x' }, { checks: [{ kind: 'code-test' }] },
    { checks: [{ kind: 'length', weight: 0 }] }, { checks: [{ kind: 'length', weight: -1 }] },
    { checks: [{ kind: 'length', weight: 'heavy' }] }, { passThreshold: 101, checks: [{ kind: 'length' }] },
    { passThreshold: 50.5, checks: [{ kind: 'length' }] }, { checks: [null] }];
  for (const c of invalid) {
    assert.equal(app.validateCriteria(c).valid, service.checkers.validateCriteria(c).valid, JSON.stringify(c));
  }
});

test('the verifier refuses exactly what the judge refuses, on every shared criteria case', async () => {
  const { CRITERIA_CASES } = await import('../../judge-service/test/helpers/criteria-cases.js');
  for (const [label, c, valid] of CRITERIA_CASES) {
    let v;
    assert.doesNotThrow(() => { v = app.validateCriteria(c); }, label);
    assert.equal(v.valid, valid, `${label}: ${v.reason}`);
  }
});

test('the verifier and the judge enforce the same bounds', () => {
  assert.deepEqual(app.LIMITS, service.checkers.LIMITS);
});
