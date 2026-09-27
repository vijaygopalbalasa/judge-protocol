// Second critique round: cases where an HONEST verdict must not be shown as
// suspicious, and one where a lie hid behind a live probe.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChain } from './helpers/fake-chain.mjs';
import { synthJob, dataUri, keccak256 } from './helpers/synth.mjs';

const app = await import('../app.js');
const { verifyJob, outcome } = app;
const { present, pasteHeadline } = await import('../present.js');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
async function verify(jobs, id, opts = {}, pasted) {
  globalThis.fetch = fakeChain({ extraJobs: jobs, ...opts }).fetch;
  return verifyJob(id, pasted).catch((e) => ({ jobId: id, checks: [], error: e.message }));
}
const TEXT = 'This report covers ERC-8183 escrow on Arc testnet with USDC settlement in detail.';
const LEN = { version: 1, checks: [{ kind: 'length', params: { min: 3 } }] };

test('non-ASCII characters inside base64 decode exactly like Node (fuzz, incl. astral and lone surrogates)', () => {
  const pool = ['A', 'z', '0', '+', '/', '-', '_', '=', ' ', 'Ł', 'Ġ', 'é', '☃', '\u{1F600}', '\ud83d', '\udc00', 'Ā', 'Ľ', '½'];
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 3000; i++) {
    const s = Array.from({ length: rnd(30) }, () => pool[rnd(pool.length)]).join('');
    assert.equal(Buffer.from(app.decodeBase64(s)).toString('hex'), Buffer.from(s, 'base64').toString('hex'), JSON.stringify(s));
  }
});

test('an honest verdict on a data: URI with non-ASCII base64 verifies (no false MISMATCH)', async () => {
  const b64 = 'SGVsbG8gd29ybGQhŁŁŁ=';
  const content = Buffer.from(b64, 'base64'); // what the service resolves
  const jobs = await synthJob({ id: 920001, criteria: LEN, content, providerURI: `data:text/plain;base64,${b64}` });
  assert.equal(outcome(await verify(jobs, 920001)), 'verified');
});

test('a provider who submits through a contract wallet is not accused; content falls back to the description like the service', async () => {
  const jobs = await synthJob({ id: 920002, criteria: LEN, content: TEXT, viaWallet: true, descriptionURI: dataUri(Buffer.from(TEXT)) });
  const r = await verify(jobs, 920002);
  assert.equal(outcome(r), 'verified', JSON.stringify(r.checks) + JSON.stringify(r.incomplete));
  assert.equal(r.deliverableSource, 'job description (client-authored)');
  assert.equal(r.submittedVia, 'contract wallet');
});

test('contract-wallet submission without any URI: incomplete, paste allowed, paste verifies', async () => {
  const jobs = await synthJob({ id: 920003, criteria: LEN, content: TEXT, viaWallet: true, providerURI: null });
  const r = await verify(jobs, 920003);
  assert.equal(outcome(r), 'incomplete');
  assert.equal(r.incomplete.reason, 'no-uri');
  assert.equal(r.needsDeliverable, true);
  assert.equal(outcome(await verify(jobs, 920003, {}, TEXT)), 'verified');
});

test('a lie about the deterministic checks cannot hide behind a live probe', async () => {
  const criteria = { version: 1, checks: [{ kind: 'contains', params: { all: ['NOT-IN-THE-TEXT'] } }, { kind: 'http-endpoint', params: { url: 'https://example.com' } }] };
  const lie = { results: [{ kind: 'contains', weight: 1, pass: true }, { kind: 'http-endpoint', weight: 1, pass: true }], score: 100, pass: true };
  const jobs = await synthJob({ id: 920004, criteria, content: TEXT, verdict: lie, assumePass: [true, true] });
  assert.equal(outcome(await verify(jobs, 920004)), 'mismatch');
});

test('an honest live-probe verdict: everything else is recomputed and the recorded probe result is reported', async () => {
  const criteria = { version: 1, passThreshold: 50, checks: [{ kind: 'length', params: { min: 3 } }, { kind: 'http-endpoint', params: { url: 'https://example.com' } }] };
  for (const [id, probe] of [[920005, true], [920006, false]]) {
    const jobs = await synthJob({ id, criteria, content: TEXT, assumePass: [true, probe] });
    const r = await verify(jobs, id);
    assert.equal(outcome(r), 'unsupported', JSON.stringify(r.checks));
    assert.deepEqual(r.probeRecorded, [probe]);
    for (const idc of ['score', 'threshold', 'pass', 'evidenceHash']) assert.ok(r.checks.find((c) => c.id === idc)?.ok, idc);
    assert.match(present(r).note, probe ? /recorded the live probe as pass/ : /recorded the live probe as fail/);
  }
});

test('pasted text whose Windows line endings were normalized by the browser still verifies', async () => {
  const crlf = 'line one of the ERC-8183 report\r\nline two\r\n';
  const jobs = await synthJob({ id: 920007, criteria: LEN, content: crlf, providerURI: 'https://provider.example/report.txt' });
  const r = await verify(jobs, 920007, {}, crlf.replace(/\r\n/g, '\n'));
  assert.equal(outcome(r), 'verified');
  assert.equal(r.pasteNormalized, 'crlf');
});

test('raw bytes (a chosen file) verify, including binary content', async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  const criteria = { version: 1, checks: [{ kind: 'length', params: { min: 1, unit: 'chars' } }] };
  const jobs = await synthJob({ id: 920008, criteria, content: bytes, providerURI: 'ipfs://bafyexample' });
  assert.equal(outcome(await verify(jobs, 920008, {}, bytes)), 'verified');
  assert.equal(outcome(await verify(jobs, 920008, {}, bytes.slice(1))), 'mismatch');
});

test("the relay's own JSON 502 is retried, not fatal", async () => {
  const jobs = await synthJob({ id: 920009, criteria: LEN, content: TEXT });
  assert.equal(outcome(await verify(jobs, 920009, { http502First: 1 })), 'verified');
});

test('a remote URI that came from the client-written description is labeled as such', async () => {
  const jobs = await synthJob({ id: 920010, criteria: LEN, content: TEXT, providerURI: null, descriptionURI: 'https://client.example/brief.txt' });
  const r = await verify(jobs, 920010);
  assert.equal(r.incomplete.reason, 'remote-uri');
  assert.equal(r.incomplete.from, 'job description (client-authored)');
  assert.match(present(r).incompleteText, /job description \(client-authored\) points to https:\/\/client\.example\/brief\.txt/);
  assert.doesNotMatch(present(r).incompleteText, /provider delivered/);
});

test('presentation nits: amber tone for a not-replayable paste result, no fake comparison on the availability row', async () => {
  const criteria = { version: 1, checks: [{ kind: 'length', params: { min: 3 } }, { kind: 'http-endpoint', params: { url: 'https://e.example' } }] };
  const jobs = await synthJob({ id: 920011, criteria, content: TEXT, providerURI: 'https://provider.example/x', assumePass: [true, true] });
  const first = await verify(jobs, 920011);
  const avail = first.checks.find((c) => c.id === 'deliverableAvailable');
  assert.ok(avail && !(avail.got && avail.want && avail.got !== avail.want), 'availability row must not render as a hash comparison');
  const second = await verify(jobs, 920011, {}, TEXT);
  assert.equal(outcome(second), 'unsupported');
  assert.equal(pasteHeadline(second).tone, 'warn');
  const detail = second.results.find((x) => x.kind === 'http-endpoint').detail;
  assert.doesNotMatch(detail, /not replayable/i, 'the status word is added by the page; the detail must not repeat it');
});

test('a transient upstream "internal error" (seen live under load) is retried, not shown as incomplete', async () => {
  const jobs = await synthJob({ id: 920012, criteria: LEN, content: TEXT });
  assert.equal(outcome(await verify(jobs, 920012, { internalErrorFirst: 2 })), 'verified');
});

void keccak256;
