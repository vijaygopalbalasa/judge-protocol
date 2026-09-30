// The checklist builder (web/builder.js) turns plain form answers into acceptance criteria.
// Everything it makes is held to the judge's own rules here: the judge-service validator must
// accept it, the judge-service checkers must score it exactly as the page's dry run does, and
// the records template must rebuild ArcBounty job 18's checklist exactly as it was committed on
// Arc mainnet (same criteria hash).
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

test('every template makes criteria both the judge and the page accept, version 1, every check must pass', () => {
  for (const [t, answers] of Object.entries(SAMPLES)) {
    const c = b.buildCriteria(t, answers);
    assert.deepEqual(service.checkers.validateCriteria(c), { valid: true, reason: 'ok' }, t);
    assert.deepEqual(app.validateCriteria(c), { valid: true, reason: 'ok' }, t);
    assert.equal(c.version, 1, t);
    assert.equal(c.passThreshold, 100, t);
  }
});

test('the pass threshold can be lowered, and only to a whole number from 0 to 100', () => {
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

// False-positive guards: answers the judge would refuse, or that would not mean what the form says,
// are refused with a message a person can act on, never turned into criteria.
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
  ['records with an unknown field type', 'records', { fields: [{ name: 'a', type: 'date' }] }, /type/],
  ['records one-of without options', 'records', { fields: [{ name: 'a', type: 'one-of', options: [] }] }, /at least one option/],
  ['records one-of with a blank option', 'records', { fields: [{ name: 'a', type: 'one-of', options: ['Arc', ' '] }] }, /blank/],
  ['records one-of with a repeated option', 'records', { fields: [{ name: 'a', type: 'one-of', options: ['Arc', 'Arc'] }] }, /twice/],
  ['records count min above max', 'records', { ...JOB18, count: { min: 5, max: 2 } }, /minimum .* above the maximum/i],
  ['records count fractional', 'records', { ...JOB18, count: { min: 1.5 } }, /whole number/],
  ['records unique by a missing field', 'records', { ...JOB18, uniqueBy: { field: 'site', key: 'domain' } }, /not one of the fields/],
  ['records unique domain of a non-address field', 'records', { ...JOB18, uniqueBy: { field: 'name', key: 'domain' } }, /web address/],
  ['records unique by an unknown key', 'records', { ...JOB18, uniqueBy: { field: 'name', key: 'host' } }, /domain.*value|value.*domain/],
  ['record with no fields', 'record', { fields: [] }, /at least one field/],
  ['file with a short hash', 'file', { sha256: 'abc' }, /64/],
  ['file with a 0x hash', 'file', { sha256: '0x' + sha256('x').slice(2) }, /64/],
  ['endpoint with no url', 'endpoint', {}, /http/],
  ['endpoint with an ftp url', 'endpoint', { url: 'ftp://example.com' }, /http/],
  ['endpoint with a status out of range', 'endpoint', { url: 'https://example.com', expectStatus: 700 }, /100 to 599/],
  ['an unknown template', 'essay', {}, /template/],
];
for (const [label, t, answers, message] of REFUSALS) {
  test(`refused: ${label}`, () => {
    assert.throws(() => b.buildCriteria(t, answers), (e) => e instanceof b.BuilderError && message.test(e.message), label);
  });
}

test('too many fields for one check is refused in plain words, not with the judge\'s internal reason', () => {
  const fields = Array.from({ length: 70 }, (_, i) => ({ name: `f${i}`, type: 'email-or-url', required: true }));
  assert.throws(() => b.buildCriteria('records', { fields }), (e) => e instanceof b.BuilderError && /too many fields/i.test(e.message));
});

test('describe says in plain words what each checklist checks', () => {
  const say = (t, a) => b.describe(b.buildCriteria(t, a));
  assert.deepEqual(say('text', SAMPLES.text), [
    'Between 50 and 300 words.',
    'Contains every one of these, as whole words: "USDC", "escrow".',
    'Every check must pass.',
  ]);
  assert.deepEqual(say('text', { minWords: 5 }), ['At least 5 words.', 'Every check must pass.']);
  assert.deepEqual(say('text', { maxWords: 5, passThreshold: 0 }), ['At most 5 words.', 'Passes at any score (pass mark 0).']);
  assert.deepEqual(say('records', JOB18), [
    'A JSON list of exactly 10 entries.',
    'Each entry has: "name" (text), "website" (web address), "network" (one of "Arc", "Base"), "paid_work_evidence" (web address), "contact" (email or web address).',
    'No two entries share the domain of "website".',
    'Every check must pass.',
  ]);
  assert.deepEqual(say('records', { count: { min: 2 }, fields: [{ name: 'n', type: 'integer' }], uniqueBy: { field: 'n', key: 'value' }, noExtraFields: true }), [
    'A JSON list of at least 2 entries.',
    'Each entry has: "n" (whole number).',
    'No two entries share the same "n".',
    'Entries have no fields other than these.',
    'Every check must pass.',
  ]);
  assert.deepEqual(say('record', SAMPLES.record), [
    'A JSON object with: "price" (number), "currency" (one of "USD", "EUR"), "note" (text, optional).',
    'It has no fields other than these.',
    'Every check must pass.',
  ]);
  assert.deepEqual(say('file', SAMPLES.file), [`Exactly the file with SHA-256 ${sha256('hello')}.`, 'Every check must pass.']);
  assert.deepEqual(say('endpoint', SAMPLES.endpoint), [
    'https://example.com/health answers with status 200, and the page includes: "ok". The judge checks this once, when it rules.',
    'Every check must pass.',
  ]);
  assert.deepEqual(say('text', { terms: ['a'], passThreshold: 50 }), ['Contains every one of these: "a".', 'Passes at a score of 50 or more out of 100.']);
});

// The dry run on the page must give exactly the judge's answer for what the builder makes.
const lead = (i, over = {}) => ({
  name: `Team ${i}`, website: `https://team${i}.example.com`, network: 'Arc',
  paid_work_evidence: `https://team${i}.example.com/work`, contact: `hello@team${i}.example.com`, ...over,
});
const tenLeads = () => Array.from({ length: 10 }, (_, i) => lead(i));
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
  test(`dry run equals the judge: ${t}`, async () => {
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
      assert.equal(got.final, true);
      seen.add(got.pass);
    }
    assert.deepEqual([...seen].sort(), [false, true], `${t}: the samples must include a pass and a fail`);
  });
}

test('dry run with a live web check says the score is not final, because only the judge runs that probe', async () => {
  const c = b.buildCriteria('endpoint', SAMPLES.endpoint);
  const r = await b.dryRun(c, new TextEncoder().encode('https://example.com/health'));
  assert.equal(r.final, false);
  assert.equal(r.results[0].notRun, true);
});
