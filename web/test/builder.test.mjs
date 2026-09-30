// The checklist builder (web/builder.js) turns plain form answers into acceptance criteria.
// Everything it makes is held to the judge's own rules here: the judge-service validator must
// accept it, the judge-service checkers must score it exactly as the page's dry run does, the
// dry run refuses what the judge refuses, the plain words claim no more than the checks do, and
// the records template rebuilds ArcBounty job 18's checklist exactly as it was committed on Arc
// mainnet (same criteria hash), both from answers and from the page's own form state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { service } from './helpers/synth.mjs';

const b = await import('../builder.js');
const app = await import('../app.js');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ArcBounty job 18 (Arc mainnet): "Poster leads", as a form would describe it.
const JOB18 = {
  count: { min: 10, max: 10 },
  uniqueBy: { field: 'website', key: 'domain' },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'website', type: 'url', required: true },
    { name: 'network', type: 'one-of', options: ['Arc', 'Base'], required: true },
    { name: 'paid_work_evidence', type: 'url', required: true },
    { name: 'contact', type: 'email-or-url', required: true },
  ],
};
const JOB18_HASH = '0xd761b8357e12d75984f1502b113ccd4c3b0fa12302b2d0d89fe5d7b21f3a120b';

const SAMPLES = {
  text: { minWords: 50, maxWords: 300, terms: ['USDC', 'escrow'], wholeWords: true },
  records: JOB18,
  record: {
    fields: [
      { name: 'price', type: 'number', required: true },
      { name: 'currency', type: 'one-of', options: ['USD', 'EUR'], required: true },
      { name: 'note', type: 'text', required: false },
    ],
    noExtraFields: true,
  },
  file: { sha256: sha256('hello') },
  endpoint: { url: 'https://example.com/health', expectStatus: 200, bodyIncludes: ['ok'] },
};

test('every template is offered and has a sample here', () => {
  assert.deepEqual([...b.TEMPLATES].sort(), Object.keys(SAMPLES).sort());
});

test('records: rebuilds the checklist of ArcBounty job 18 with the same criteria hash as on chain', () => {
  const c = b.buildCriteria('records', JOB18);
  assert.equal(app.criteriaHash(c), JOB18_HASH);
  assert.equal(service.criteria.criteriaHash(c), JOB18_HASH);
});

test('the page\'s own form state for job 18 reaches the builder unchanged and rebuilds the on-chain hash', () => {
  const form = {
    min: ' 10', max: '10 ', uniqueRow: 2, uniqueKey: 'domain', noExtra: false,
    fields: [
      { id: 1, name: 'name', type: 'text', options: '', required: true },
      { id: 2, name: 'website', type: 'url', options: '', required: true },
      { id: 3, name: 'network', type: 'one-of', options: 'Arc, Base,', required: true },
      { id: 4, name: 'paid_work_evidence', type: 'url', options: '', required: true },
      { id: 5, name: 'contact', type: 'email-or-url', options: 'ignored unless one of', required: true },
    ],
  };
  assert.equal(app.criteriaHash(b.buildCriteria('records', b.fromForm('records', form, '100'))), JOB18_HASH);
  // The uniqueness rule follows its row, so renaming the field keeps the rule on the renamed field.
  const renamed = structuredClone(form);
  renamed.fields[1].name = 'site';
  assert.deepEqual(b.buildCriteria('records', b.fromForm('records', renamed, '100')).checks[0].params.shape.uniqueBy, { field: 'site', key: 'domain' });
  // A row that is gone takes its rule with it.
  const noRow = { ...structuredClone(form), uniqueRow: 99 };
  assert.equal(b.buildCriteria('records', b.fromForm('records', noRow, '')).checks[0].params.shape.uniqueBy, undefined);
});

test('form numbers: blank is absent, digits are numbers, anything else reaches the builder as text and is refused', () => {
  assert.equal(b.formNumber(''), undefined);
  assert.equal(b.formNumber('   '), undefined);
  assert.equal(b.formNumber(' 12 '), 12);
  assert.equal(b.formNumber('-3'), -3);
  assert.equal(b.formNumber('10.5'), 10.5);
  assert.equal(b.formNumber('1e3'), '1e3');
  assert.equal(b.formNumber('10 words'), '10 words');
  assert.throws(() => b.buildCriteria('text', b.fromForm('text', { minWords: '1e3', maxWords: '', terms: '', wholeWords: false }, '')), /whole number/);
  assert.deepEqual(b.formOptions('Arc, Base,'), ['Arc', ' Base']);
  assert.deepEqual(b.formOptions('  '), []);
});

test('every template makes criteria both the judge and the page accept, version 1, every check must pass', () => {
  for (const [t, answers] of Object.entries(SAMPLES)) {
    const c = b.buildCriteria(t, answers);
    assert.deepEqual(service.checkers.validateCriteria(c), { valid: true, reason: 'ok' }, t);
    assert.deepEqual(app.validateCriteria(c), { valid: true, reason: 'ok' }, t);
    assert.equal(c.version, 1, t);
    assert.equal(c.passThreshold, 100, t);
  }
});

test('the pass mark can be lowered, and only to a whole number from 0 to 100', () => {
  assert.equal(b.buildCriteria('text', { ...SAMPLES.text, passThreshold: 50 }).passThreshold, 50);
  assert.equal(b.buildCriteria('text', { ...SAMPLES.text, passThreshold: 0 }).passThreshold, 0);
  for (const bad of [101, -1, 50.5, '50', NaN]) {
    assert.throws(() => b.buildCriteria('text', { ...SAMPLES.text, passThreshold: bad }), b.BuilderError, String(bad));
  }
});

test('field types map to the pinned json shapes', () => {
  assert.deepEqual(b.fieldShape({ type: 'text' }), { type: 'string', minLength: 1 });
  assert.deepEqual(b.fieldShape({ type: 'url' }), { type: 'string', format: 'url' });
  assert.deepEqual(b.fieldShape({ type: 'email' }), { type: 'string', format: 'email' });
  assert.deepEqual(b.fieldShape({ type: 'email-or-url' }), { anyOf: [{ type: 'string', format: 'email' }, { type: 'string', format: 'url' }] });
  assert.deepEqual(b.fieldShape({ type: 'number' }), { type: 'number' });
  assert.deepEqual(b.fieldShape({ type: 'integer' }), { type: 'integer' });
  assert.deepEqual(b.fieldShape({ type: 'yes-no' }), { type: 'boolean' });
  assert.deepEqual(b.fieldShape({ type: 'one-of', options: ['Arc', 'Base'] }), { enum: ['Arc', 'Base'] });
  assert.deepEqual([...b.FIELD_TYPES].sort(), ['email', 'email-or-url', 'integer', 'number', 'one-of', 'text', 'url', 'yes-no']);
});

test('text: the terms are trimmed, blank lines dropped, and whole words only when asked', () => {
  const c = b.buildCriteria('text', { minWords: 1, terms: ['  USDC ', '', '   ', 'escrow'] });
  assert.deepEqual(c.checks, [
    { kind: 'length', params: { min: 1 } },
    { kind: 'contains', params: { all: ['USDC', 'escrow'] } },
  ]);
  const w = b.buildCriteria('text', { terms: ['Arc'], wholeWords: true });
  assert.deepEqual(w.checks, [{ kind: 'contains', params: { all: ['Arc'], wholeWords: true } }]);
});

test('record: optional fields are described but not required, and extra fields can be refused', () => {
  const c = b.buildCriteria('record', SAMPLES.record);
  assert.deepEqual(c.checks, [{
    kind: 'json',
    params: { shape: {
      type: 'object', required: ['price', 'currency'], additionalProperties: false,
      properties: { price: { type: 'number' }, currency: { enum: ['USD', 'EUR'] }, note: { type: 'string', minLength: 1 } },
    } },
  }]);
});

test('the job description carries exactly one criteria block that reads back to the same criteria, backticks included', () => {
  const c = b.buildCriteria('text', { minWords: 1, terms: ['use `judge`', '```', 'a`b'] });
  const d = b.jobDescription('Write a short note.\nPlain words only.', c);
  assert.ok(d.startsWith('Write a short note.\nPlain words only.\n```judge-criteria\n'));
  assert.equal(d.split('```').length - 1, 2, 'one opening and one closing fence, nothing else');
  assert.deepEqual(app.extractCriteria(d), c);
  assert.deepEqual(service.criteria.extractCriteria(d), c);
  assert.equal(app.criteriaHash(app.extractCriteria(d)), service.criteria.criteriaHash(c));
});

test('an empty summary falls back to the kit default title; a summary with a code fence is refused', () => {
  const c = b.buildCriteria('file', SAMPLES.file);
  assert.ok(b.jobDescription('', c).startsWith(`${b.DEFAULT_TITLE}\n\`\`\`judge-criteria\n`));
  assert.ok(b.jobDescription('   ', c).startsWith(`${b.DEFAULT_TITLE}\n`));
  assert.throws(() => b.jobDescription('see ```code```', c), b.BuilderError);
});

// False-positive guards: answers the judge would refuse, that could never pass, or that would not mean
// what the form says, are refused with a message a person can act on, never turned into criteria.
test('answers the judge would refuse, or that could never pass, are refused in plain words', () => {
  const REFUSALS = [
    ['text with no rule at all', 'text', {}, /word range or at least one required term/],
    ['text with only blank terms', 'text', { terms: ['', '  '] }, /word range or at least one required term/],
    ['text min above max', 'text', { minWords: 10, maxWords: 5 }, /minimum .* above the maximum/i],
    ['text negative words', 'text', { minWords: -1 }, /whole number/],
    ['text fractional words', 'text', { maxWords: 2.5 }, /whole number/],
    ['text words as a string', 'text', { minWords: '10' }, /whole number/],
    ['text term too long', 'text', { terms: ['x'.repeat(1025)] }, /1024/],
    ['text too many terms', 'text', { terms: Array.from({ length: 257 }, (_, i) => `t${i}`) }, /256/],
    ['records with no fields', 'records', { fields: [] }, /at least one field/],
    ['records with a blank field name', 'records', { fields: [{ name: ' ', type: 'text' }] }, /field name/i],
    ['records with a field named twice', 'records', { fields: [{ name: 'a', type: 'text' }, { name: 'a', type: 'url' }] }, /twice/],
    ['records with a __proto__ field', 'records', { fields: [{ name: '__proto__', type: 'text' }] }, /__proto__/],
    ['records with a padded __proto__ field', 'records', { fields: [{ name: ' __proto__ ', type: 'text' }] }, /__proto__/],
    ['records with an unknown field type', 'records', { fields: [{ name: 'a', type: 'date' }] }, /type/],
    ['records one-of without options', 'records', { fields: [{ name: 'a', type: 'one-of', options: [] }] }, /at least one option/],
    ['records one-of with a blank option', 'records', { fields: [{ name: 'a', type: 'one-of', options: ['Arc', ' '] }] }, /blank/],
    ['records one-of with a repeated option', 'records', { fields: [{ name: 'a', type: 'one-of', options: ['Arc', 'Arc'] }] }, /twice/],
    ['records count min above max', 'records', { ...JOB18, count: { min: 5, max: 2 } }, /minimum .* above the maximum/i],
    ['records count fractional', 'records', { ...JOB18, count: { min: 1.5 } }, /whole number/],
    ['records unique by a missing field', 'records', { ...JOB18, uniqueBy: { field: 'site', key: 'domain' } }, /not one of the fields/],
    ['records unique by an unnamed field', 'records', { ...JOB18, uniqueBy: { field: ' ', key: 'domain' } }, /name the field/i],
    ['records unique host of a non-address field', 'records', { ...JOB18, uniqueBy: { field: 'name', key: 'domain' } }, /web address/],
    ['records unique by an unknown key', 'records', { ...JOB18, uniqueBy: { field: 'name', key: 'host' } }, /host name.*value|value.*host name/],
    ['record with no fields', 'record', { fields: [] }, /at least one field/],
    ['file with a short hash', 'file', { sha256: 'abc' }, /64/],
    ['file with a 0x hash', 'file', { sha256: '0x' + sha256('x').slice(2) }, /64/],
    ['file larger than the judge reads', 'file', { sha256: sha256('x'), size: 1_000_001 }, /1,000,000 bytes/],
    ['endpoint with no url', 'endpoint', {}, /http/],
    ['endpoint with an ftp url', 'endpoint', { url: 'ftp://example.com' }, /http/],
    ['endpoint with an IP address', 'endpoint', { url: 'http://10.0.0.1/health' }, /http/],
    ['endpoint with port 0', 'endpoint', { url: 'https://example.com:0/health' }, /port/],
    ['endpoint with port 99999', 'endpoint', { url: 'https://example.com:99999/health' }, /port/],
    ['endpoint expecting 700', 'endpoint', { url: 'https://example.com', expectStatus: 700 }, /200 to 299 or 400 to 599/],
    ['endpoint expecting a 1xx', 'endpoint', { url: 'https://example.com', expectStatus: 101 }, /200 to 299 or 400 to 599/],
    ['endpoint expecting a redirect', 'endpoint', { url: 'https://example.com', expectStatus: 302 }, /redirects/],
    ['endpoint status as text', 'endpoint', { url: 'https://example.com', expectStatus: '200' }, /200 to 299 or 400 to 599/],
    ['an unknown template', 'essay', {}, /template/],
  ];
  for (const [label, t, answers, message] of REFUSALS) {
    assert.throws(() => b.buildCriteria(t, answers), (e) => e instanceof b.BuilderError && message.test(e.message), label);
  }
  // Ports and statuses the judge can use still build.
  assert.equal(b.buildCriteria('endpoint', { url: 'https://example.com:8443/health', expectStatus: 404 }).checks[0].params.expectStatus, 404);
  assert.equal(b.buildCriteria('file', { sha256: sha256('x'), size: 1_000_000 }).checks[0].params.sha256, sha256('x'));
});

test('too many fields for one check is refused in plain words, not with the judge\'s internal reason', () => {
  const fields = Array.from({ length: 70 }, (_, i) => ({ name: `f${i}`, type: 'email-or-url', required: true }));
  assert.throws(() => b.buildCriteria('records', { fields }), (e) => e instanceof b.BuilderError && /too many fields/i.test(e.message));
});

test('describe says in plain words what each checklist checks, and claims nothing more', () => {
  const say = (t, a) => b.describe(b.buildCriteria(t, a));
  assert.deepEqual(say('text', SAMPLES.text), [
    'Between 50 and 300 words.',
    'Contains every one of these, as whole words: "USDC", "escrow".',
    'Every check must pass.',
  ]);
  assert.deepEqual(say('text', { minWords: 5 }), ['At least 5 words.', 'Every check must pass.']);
  assert.deepEqual(say('text', { maxWords: 5, passThreshold: 0 }), ['At most 5 words.', 'Passes whatever the delivery is (pass mark 0).']);
  assert.deepEqual(say('records', JOB18), [
    'A JSON list of exactly 10 entries.',
    'Each entry has: "name" (text of at least 1 character), "website" (web address), "network" (one of these exact texts: "Arc", "Base"), "paid_work_evidence" (web address), "contact" (email or web address).',
    'No two entries share the host name of "website" (a leading "www." is ignored; subdomains count as different).',
    'Web addresses start with http:// or https:// and use a plain ASCII host name.',
    'Every check must pass.',
  ]);
  assert.deepEqual(say('records', { count: { min: 2 }, fields: [{ name: 'n', type: 'integer' }, { name: 'ok', type: 'yes-no' }], uniqueBy: { field: 'n', key: 'value' }, noExtraFields: true }), [
    'A JSON list of at least 2 entries.',
    'Each entry has: "n" (whole number, negative allowed), "ok" (true or false).',
    'No two entries share the same "n".',
    'Entries have no fields other than these.',
    'Every check must pass.',
  ]);
  assert.deepEqual(say('records', { count: { min: 1, max: 1 }, fields: [{ name: 'e', type: 'email' }] })[0], 'A JSON list of exactly 1 entry.');
  assert.deepEqual(say('records', { fields: [{ name: 'e', type: 'email' }] })[0], 'A JSON list of any number of entries, including none.');
  assert.deepEqual(say('records', { count: { min: 0, max: 5 }, fields: [{ name: 'e', type: 'email' }] })[0], 'A JSON list of at most 5 entries, including none.');
  assert.deepEqual(say('record', SAMPLES.record), [
    'A JSON object with: "price" (number), "currency" (one of these exact texts: "USD", "EUR"), "note" (text of at least 1 character, optional).',
    'It has no fields other than these.',
    'Every check must pass.',
  ]);
  assert.deepEqual(say('file', SAMPLES.file), [`Exactly the file with SHA-256 ${sha256('hello')}.`, 'Every check must pass.']);
  assert.deepEqual(say('endpoint', SAMPLES.endpoint), [
    'https://example.com/health answers with status 200, and the page includes: "ok". The judge checks this once, when it rules.',
    'Every check must pass.',
  ]);
  // A lower pass mark is said as a number of checks, since checks pass whole or not at all.
  assert.deepEqual(say('text', { terms: ['a'], passThreshold: 50 }), ['Contains every one of these: "a".', 'Every check must pass (pass mark 50).']);
  assert.deepEqual(say('text', { minWords: 1, terms: ['a'], passThreshold: 50 }).at(-1), 'At least 1 of the 2 checks must pass (pass mark 50).');
  assert.deepEqual(say('text', { minWords: 1, terms: ['a'], passThreshold: 51 }).at(-1), 'Every check must pass (pass mark 51).');
  assert.deepEqual(say('records', { ...JOB18, passThreshold: 50 }).at(-1), 'Every check must pass (pass mark 50).');
});

test('the plain-words pass rule agrees with the judge\'s own scoring for every pass mark', async () => {
  const c0 = b.buildCriteria('text', { minWords: 3, terms: ['USDC'] });
  for (let t = 0; t <= 100; t++) {
    const c = { ...c0, passThreshold: t };
    const line = b.describe(c).at(-1);
    const oneOfTwo = await service.checkers.runAllChecks(c, { content: Buffer.from('USDC') });
    const noneOfTwo = await service.checkers.runAllChecks(c, { content: Buffer.from('nothing') });
    if (/^Every check must pass/.test(line)) assert.equal(oneOfTwo.pass, false, `${t}: ${line}`);
    if (/^At least 1 of the 2/.test(line)) assert.deepEqual([oneOfTwo.pass, noneOfTwo.pass], [true, false], `${t}: ${line}`);
    if (/^Passes whatever/.test(line)) assert.equal(noneOfTwo.pass, true, `${t}: ${line}`);
  }
});

// The dry run on the page must give exactly the judge's answer for what the builder makes.
const lead = (i, over = {}) => ({
  name: `Team ${i}`, website: `https://team${i}.example.com`, network: 'Arc',
  paid_work_evidence: `https://team${i}.example.com/work`, contact: `hello@team${i}.example.com`, ...over,
});
const tenLeads = () => Array.from({ length: 10 }, (_, i) => lead(i));

test('the dry run gives the judge\'s own score for every template, on passing and failing deliveries', async () => {
  const DRY = [
    ['text', SAMPLES.text, [`USDC escrow ${'word '.repeat(60)}`, 'USDC escrow too short', `USDCs escrowed ${'word '.repeat(60)}`]],
    ['records', JOB18, [
      JSON.stringify(tenLeads()),
      JSON.stringify(tenLeads().slice(0, 9)),
      JSON.stringify(tenLeads().map((l, i) => (i === 3 ? { ...l, network: 'arc' } : l))),
      JSON.stringify(tenLeads().map((l, i) => (i === 4 ? { ...l, website: 'https://www.team0.example.com/x' } : l))),
    ]],
    ['record', SAMPLES.record, ['{"price":3,"currency":"USD"}', '{"price":"3","currency":"USD"}', '{"price":3,"currency":"USD","x":1}']],
    ['file', SAMPLES.file, ['hello', 'hello\n']],
  ];
  for (const [t, answers, contents] of DRY) {
    const c = b.buildCriteria(t, answers);
    const seen = new Set();
    for (const s of contents) {
      const bytes = Buffer.from(s, 'utf8');
      const want = await service.checkers.runAllChecks(c, { content: bytes });
      const got = await b.dryRun(c, new Uint8Array(bytes));
      assert.deepEqual(
        { score: got.score, pass: got.pass, flags: got.results.map((r) => r.pass) },
        { score: want.score, pass: want.pass, flags: want.results.map((r) => r.pass) },
        `${t} on ${s.slice(0, 60)}`,
      );
      assert.equal(got.final, true, t);
      seen.add(got.pass);
    }
    assert.deepEqual([...seen].sort(), [false, true], `${t}: the samples must include a pass and a fail`);
  }
});

test('the dry run refuses what the judge refuses: nothing over 1,000,000 bytes is ever ruled', async () => {
  const { MAX_BYTES } = await import('../../judge-service/src/safe-fetch.js');
  assert.equal(b.MAX_DELIVERABLE_BYTES, MAX_BYTES);
  const c = b.buildCriteria('text', { minWords: 1 });
  const over = await b.dryRun(c, new Uint8Array(MAX_BYTES + 1).fill(0x61));
  assert.deepEqual({ final: over.final, tooLarge: over.tooLarge, pass: over.pass, results: over.results }, { final: false, tooLarge: true, pass: null, results: [] });
  const at = await b.dryRun(c, new Uint8Array(MAX_BYTES).fill(0x61));
  assert.deepEqual({ final: at.final, pass: at.pass }, { final: true, pass: true });
});

test('dry run with a live web check says the score is not final, because only the judge runs that probe', async () => {
  const c = b.buildCriteria('endpoint', SAMPLES.endpoint);
  const r = await b.dryRun(c, new TextEncoder().encode('https://example.com/health'));
  assert.equal(r.final, false);
  assert.equal(r.results[0].notRun, true);
  assert.equal(r.results[0].pass, false);
});
