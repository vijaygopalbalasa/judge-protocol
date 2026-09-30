// The checklist builder: plain form answers in, acceptance criteria out (docs/CRITERIA.md).
// It never rules on anything. It writes criteria, and it refuses any answer the judge would refuse,
// or that would not mean what the form says, with a message a person can act on. Every result is
// checked by validateCriteria, this page's mirror of the judge's own rules, and the dry run uses the
// same checkers the verifier recomputes rulings with (web/test/builder.test.mjs holds both to the judge).

import { validateCriteria, runChecks, LIMITS } from './app.js';
import { isUrl, SHAPE_LIMITS } from './json-shape.js';

export class BuilderError extends Error {}
const fail = (message) => { throw new BuilderError(message); };

export const TEMPLATES = ['text', 'records', 'record', 'file', 'endpoint'];
export const FIELD_TYPES = ['text', 'url', 'email', 'email-or-url', 'number', 'integer', 'yes-no', 'one-of'];
/** The kit's default title (kit/judge-kit.js criteriaBlock), so both write the same block. */
export const DEFAULT_TITLE = 'Deliverable judged by Judge Protocol (deterministic, recomputable).';

const given = (v) => v !== undefined && v !== null && v !== '';

function whole(v, what) {
  if (!given(v)) return undefined;
  if (!Number.isInteger(v) || v < 0) fail(`${what} must be a whole number, 0 or more.`);
  return v;
}

/** Optional lower and upper bounds, as whole numbers, lower not above upper. */
function bounds(min, max, what) {
  const lo = whole(min, `The minimum ${what}`);
  const hi = whole(max, `The maximum ${what}`);
  if (lo !== undefined && hi !== undefined && lo > hi) fail(`The minimum ${what} (${lo}) is above the maximum (${hi}).`);
  return { ...(lo !== undefined && { lo }), ...(hi !== undefined && { hi }) };
}

/** A list of texts from the form: trimmed, blank lines dropped, within the judge's limits. */
function texts(list, what) {
  const out = (Array.isArray(list) ? list : []).map((t) => String(t).trim()).filter(Boolean);
  if (out.length > LIMITS.terms) fail(`At most ${LIMITS.terms} ${what}.`);
  if (out.some((t) => t.length > LIMITS.termChars)) fail(`Each of the ${what} can be at most ${LIMITS.termChars} characters.`);
  return out;
}

function options(list) {
  const raw = (Array.isArray(list) ? list : []).map((o) => String(o));
  if (!raw.length) fail('A "one of" field needs at least one option.');
  if (raw.length > SHAPE_LIMITS.terms) fail(`A "one of" field takes at most ${SHAPE_LIMITS.terms} options.`);
  const out = raw.map((o) => o.trim());
  if (out.some((o) => !o)) fail('One of the options of a "one of" field is blank.');
  if (out.some((o) => o.length > SHAPE_LIMITS.termChars)) fail(`Each option can be at most ${SHAPE_LIMITS.termChars} characters.`);
  const twice = out.find((o, i) => out.indexOf(o) !== i);
  if (twice !== undefined) fail(`The option "${twice}" is listed twice.`);
  return out;
}

/** The json shape one form field stands for. Text means non-empty text; options match exactly, case included. */
export function fieldShape(field) {
  switch (field?.type) {
    case 'text': return { type: 'string', minLength: 1 };
    case 'url': return { type: 'string', format: 'url' };
    case 'email': return { type: 'string', format: 'email' };
    case 'email-or-url': return { anyOf: [{ type: 'string', format: 'email' }, { type: 'string', format: 'url' }] };
    case 'number': return { type: 'number' };
    case 'integer': return { type: 'integer' };
    case 'yes-no': return { type: 'boolean' };
    case 'one-of': return { enum: options(field.options) };
    default: return fail(`Unknown field type "${field?.type}". Use one of: ${FIELD_TYPES.join(', ')}.`);
  }
}

/** Fields as the json shape wants them. A field is required unless the form says required: false. */
function fieldSet(list) {
  const fields = Array.isArray(list) ? list : [];
  if (!fields.length) fail('Add at least one field.');
  if (fields.length > SHAPE_LIMITS.terms) fail(`At most ${SHAPE_LIMITS.terms} fields.`);
  const byName = new Map();
  const required = [];
  const properties = {};
  for (const f of fields) {
    const name = String(f?.name ?? '').trim();
    if (!name) fail('Every field needs a field name.');
    if (name === '__proto__') fail('A field cannot be named "__proto__": the judge refuses that name.');
    if (name.length > SHAPE_LIMITS.termChars) fail(`A field name can be at most ${SHAPE_LIMITS.termChars} characters.`);
    if (byName.has(name)) fail(`The field "${name}" is listed twice.`);
    byName.set(name, f);
    properties[name] = fieldShape(f);
    if (f.required !== false) required.push(name);
  }
  return { byName, required, properties };
}

function uniqueBy(rule, byName) {
  const key = rule.key ?? 'value';
  if (key !== 'domain' && key !== 'value') fail('"No two entries share" compares either the domain of a web address or the exact value.');
  const field = String(rule.field ?? '').trim();
  if (!byName.has(field)) fail(`"${field}" is not one of the fields.`);
  if (key === 'domain' && byName.get(field).type !== 'url') fail(`To compare domains, "${field}" must be a web address field.`);
  return { field, key };
}

const BUILD = {
  text(a) {
    const { lo, hi } = bounds(a.minWords, a.maxWords, 'number of words');
    const all = texts(a.terms, 'required terms');
    const checks = [];
    if (lo !== undefined || hi !== undefined) {
      checks.push({ kind: 'length', params: { ...(lo !== undefined && { min: lo }), ...(hi !== undefined && { max: hi }) } });
    }
    if (all.length) checks.push({ kind: 'contains', params: a.wholeWords === true ? { all, wholeWords: true } : { all } });
    if (!checks.length) fail('Add a word range or at least one required term.');
    return checks;
  },
  records(a) {
    const { byName, required, properties } = fieldSet(a.fields);
    const { lo, hi } = bounds(a.count?.min, a.count?.max, 'number of entries');
    const item = { type: 'object', ...(required.length && { required }), properties };
    if (a.noExtraFields === true) item.additionalProperties = false;
    const shape = { type: 'array', ...(lo !== undefined && { minItems: lo }), ...(hi !== undefined && { maxItems: hi }) };
    if (a.uniqueBy) shape.uniqueBy = uniqueBy(a.uniqueBy, byName);
    shape.items = item;
    return [{ kind: 'json', params: { shape } }];
  },
  record(a) {
    const { required, properties } = fieldSet(a.fields);
    const shape = { type: 'object', ...(required.length && { required }), properties };
    if (a.noExtraFields === true) shape.additionalProperties = false;
    return [{ kind: 'json', params: { shape } }];
  },
  file(a) {
    const h = String(a.sha256 ?? '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(h)) fail('The file fingerprint must be a SHA-256: 64 hex characters, without "0x".');
    return [{ kind: 'checksum', params: { sha256: h.toLowerCase() } }];
  },
  endpoint(a) {
    const url = String(a.url ?? '').trim();
    if (!isUrl(url)) fail('The web address must start with http:// or https:// and name a real host (not an IP address or localhost).');
    const params = { url };
    if (given(a.expectStatus)) {
      if (!Number.isInteger(a.expectStatus) || a.expectStatus < 100 || a.expectStatus > 599) fail('The expected status must be a whole number from 100 to 599.');
      params.expectStatus = a.expectStatus;
    }
    const body = texts(a.bodyIncludes, 'texts the page must include');
    if (body.length) params.bodyIncludes = body;
    return [{ kind: 'http-endpoint', params }];
  },
};

function passMark(t) {
  if (!given(t)) return 100;
  if (!Number.isInteger(t) || t < 0 || t > 100) fail('The pass mark must be a whole number from 0 to 100.');
  return t;
}

/** Criteria for one template from its form answers. Throws BuilderError with a plain message. */
export function buildCriteria(template, answers = {}) {
  if (!Object.hasOwn(BUILD, template)) fail(`Unknown template "${template}". Use one of: ${TEMPLATES.join(', ')}.`);
  const a = answers ?? {};
  const criteria = { version: 1, passThreshold: passMark(a.passThreshold), checks: BUILD[template](a) };
  const v = validateCriteria(criteria);
  if (!v.valid) {
    if (v.reason.includes(`at most ${SHAPE_LIMITS.nodes} shapes`)) {
      fail(`Too many fields for one checklist: the judge reads at most ${SHAPE_LIMITS.nodes} parts in one check (a field counts 1, "email or web address" counts 3).`);
    }
    fail(`The judge would refuse this checklist: ${v.reason}`);
  }
  return criteria;
}

/** The block the kit's criteriaBlock writes, byte for byte (kit/test/builder-parity.test.js). */
export function criteriaBlock(criteria, { title = DEFAULT_TITLE } = {}) {
  const v = validateCriteria(criteria);
  if (!v.valid) fail(`The judge would refuse this checklist: ${v.reason}`);
  if (String(title).includes('```')) fail('The summary must not contain three backticks in a row (```): they would end the checklist early.');
  // Backticks go in as \u0060 (the same character in JSON), so no term can close the block early.
  return `${title}\n\`\`\`judge-criteria\n${JSON.stringify(criteria).replace(/`/g, '\\u0060')}\n\`\`\``;
}

/** The job description to paste: the summary a person reads, then the block the judge reads. */
export function jobDescription(summary, criteria) {
  const s = String(summary ?? '').trim();
  return criteriaBlock(criteria, { title: s || DEFAULT_TITLE });
}

/* ------------------------------ plain words ------------------------------ */

const quote = (s) => JSON.stringify(String(s));

function shapeWords(s) {
  if (Array.isArray(s.enum)) return `one of ${s.enum.map(quote).join(', ')}`;
  if (Array.isArray(s.anyOf)) {
    const forms = s.anyOf.map(shapeWords);
    return forms.length === 2 && forms[0] === 'email' && forms[1] === 'web address' ? 'email or web address' : forms.join(' or ');
  }
  if (s.type === 'string') return s.format === 'url' ? 'web address' : s.format === 'email' ? 'email' : 'text';
  return { number: 'number', integer: 'whole number', boolean: 'yes or no', object: 'object', array: 'list', null: 'null' }[s.type] ?? 'any value';
}

function fieldWords(shape) {
  const req = new Set(shape.required || []);
  return Object.entries(shape.properties || {}).map(([name, s]) => `${quote(name)} (${shapeWords(s)}${req.has(name) ? '' : ', optional'})`).join(', ');
}

function howMany(lo, hi, noun) {
  if (lo !== undefined && hi !== undefined) return lo === hi ? `exactly ${lo} ${noun}` : `${lo} to ${hi} ${noun}`;
  if (lo !== undefined) return `at least ${lo} ${noun}`;
  if (hi !== undefined) return `at most ${hi} ${noun}`;
  return `any number of ${noun}`;
}

function checkWords(c) {
  const p = c.params || {};
  switch (c.kind) {
    case 'length': {
      const unit = p.unit === 'chars' ? 'characters' : 'words';
      if (given(p.min) && given(p.max)) return [`Between ${p.min} and ${p.max} ${unit}.`];
      if (given(p.min)) return [`At least ${p.min} ${unit}.`];
      if (given(p.max)) return [`At most ${p.max} ${unit}.`];
      return [`Any number of ${unit}.`];
    }
    case 'contains':
      return [`Contains every one of these${p.wholeWords === true ? ', as whole words' : ''}: ${(p.all || []).map(quote).join(', ')}.`];
    case 'checksum':
      return [`Exactly the file with SHA-256 ${String(p.sha256).toLowerCase()}.`];
    case 'http-endpoint': {
      const body = (p.bodyIncludes || []).length ? `, and the page includes: ${p.bodyIncludes.map(quote).join(', ')}` : '';
      return [`${p.url ?? 'The delivered address'} answers with status ${p.expectStatus ?? 200}${body}. The judge checks this once, when it rules.`];
    }
    case 'json': {
      const s = p.shape;
      if (s?.type === 'array' && s.items?.type === 'object') {
        const out = [`A JSON list of ${howMany(s.minItems, s.maxItems, 'entries')}.`, `Each entry has: ${fieldWords(s.items)}.`];
        if (s.uniqueBy) out.push(s.uniqueBy.key === 'domain' ? `No two entries share the domain of ${quote(s.uniqueBy.field)}.` : `No two entries share the same ${quote(s.uniqueBy.field)}.`);
        if (s.items.additionalProperties === false) out.push('Entries have no fields other than these.');
        return out;
      }
      if (s?.type === 'object') {
        const out = [`A JSON object with: ${fieldWords(s)}.`];
        if (s.additionalProperties === false) out.push('It has no fields other than these.');
        return out;
      }
      return [s ? `JSON matching the shape ${JSON.stringify(s)}.` : 'Valid JSON.'];
    }
    default:
      return [`A ${c.kind} check.`];
  }
}

/** One check in plain words (a row of the dry-run table). */
export const describeCheck = (check) => checkWords(check).join(' ');

/** What a checklist checks, in plain sentences, ending with the pass mark. */
export function describe(criteria) {
  const lines = (criteria.checks || []).flatMap(checkWords);
  const t = criteria.passThreshold ?? 100;
  lines.push(t === 100 ? 'Every check must pass.' : t === 0 ? 'Passes at any score (pass mark 0).' : `Passes at a score of ${t} or more out of 100.`);
  return lines;
}

/**
 * What the judge would answer for this delivery, computed here with the verifier's checkers. A live web check is
 * a probe only the judge makes when it rules, so it is shown as not run and the result is not final.
 */
export async function dryRun(criteria, bytes) {
  const r = await runChecks(criteria, bytes);
  const results = r.results.map((x) => ({ kind: x.kind, pass: x.pass === true && !x.unsupported, notRun: x.unsupported === true, detail: x.detail, weight: x.weight }));
  return { results, score: r.score, pass: r.pass, threshold: r.threshold, final: r.unsupported.length === 0 };
}
