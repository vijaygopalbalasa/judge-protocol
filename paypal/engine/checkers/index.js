// Deterministic checkers. Each checker is a pure function:
//   (checkSpec, resolvedDeliverable) -> { pass, detail }
// Determinism rule: same inputs ALWAYS produce the same verdict. No LLM in the
// decision path. An LLM may later summarize `detail` for humans, never decide.

import crypto from "node:crypto";
import { safeFetch, FetchError } from "../safe-fetch.js";
import { WORD_RANGES } from "./word-characters.js";
import { shapeProblem, shapeViolations } from "./json-shape.js";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** checksum: deliverable bytes must equal a pinned sha256. */
function checkChecksum(spec, deliverable) {
  const actual = sha256(deliverable.content);
  const pass = actual.toLowerCase() === String(spec.sha256 || "").toLowerCase();
  return { pass, detail: `sha256 ${actual.slice(0, 16)}… ${pass ? "==" : "!="} expected ${String(spec.sha256).slice(0, 16)}…` };
}

/** schema: deliverable JSON must match required fields / types. */
function checkSchema(spec, deliverable) {
  let obj;
  try {
    obj = JSON.parse(deliverable.content.toString("utf8"));
  } catch {
    return { pass: false, detail: "deliverable is not valid JSON" };
  }
  // Valid JSON that is not an object (42, null, "text") cannot have fields: a
  // failed check, never a crash. A crash would leave the job unruled.
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return { pass: false, detail: "deliverable is not a JSON object" };
  // Own fields only: `constructor` or an array's `length` are not fields of the delivered object.
  const required = spec.required || [];
  const missing = required.filter((f) => !Object.hasOwn(obj, f));
  const typeErrors = [];
  for (const [field, type] of Object.entries(spec.types || {})) {
    if (Object.hasOwn(obj, field) && typeof obj[field] !== type) {
      typeErrors.push(`${field}: expected ${type}, got ${typeof obj[field]}`);
    }
  }
  const pass = missing.length === 0 && typeErrors.length === 0;
  return {
    pass,
    detail: pass
      ? `schema ok (${required.length} required fields present)`
      : `missing=[${missing.join(",")}] typeErrors=[${typeErrors.join(",")}]`,
  };
}

// Word characters: "_" plus the pinned Unicode 17.0.0 letters and digits, never the runtime's own
// \p{L}\p{N}, whose answer changes with the Node version (ERC-8404 profile SPEC section 10).
const WORD_START = [], WORD_END = [];
for (const range of WORD_RANGES) {
  const [first, last = first] = range.split("-");
  WORD_START.push(parseInt(first, 16));
  WORD_END.push(parseInt(last, 16));
}
function isWordCodePoint(cp) {
  if (cp === 0x5f) return true;
  let lo = 0, hi = WORD_START.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < WORD_START[mid]) hi = mid - 1;
    else if (cp > WORD_END[mid]) lo = mid + 1;
    else return true;
  }
  return false;
}
const isHigh = (u) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u) => u >= 0xdc00 && u <= 0xdfff;
/**
 * True if `term` occurs in `text` not touching a letter, digit or underscore on either side.
 * It scans by code point, as a /u regular expression would: a match never splits a surrogate
 * pair. A scan, not a regex per term, so thousands of terms cost no compile time.
 */
export function hasWholeWord(text, term) {
  for (let at = text.indexOf(term); at !== -1; at = at < text.length ? text.indexOf(term, at + 1) : -1) {
    const end = at + term.length;
    if (at > 0 && isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1))) continue;
    if (end > at && end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) continue;
    const unit = at > 0 ? text.charCodeAt(at - 1) : -1;
    const before = at > 1 && isLow(unit) && isHigh(text.charCodeAt(at - 2)) ? text.codePointAt(at - 2) : unit;
    const after = end < text.length ? text.codePointAt(end) : -1;
    if ((before === -1 || !isWordCodePoint(before)) && (after === -1 || !isWordCodePoint(after))) return true;
  }
  return false;
}

/** json: the deliverable is JSON of the shape the criteria pin (json-shape.js; docs/CRITERIA.md, "json"). */
function checkJson(spec, deliverable) {
  let value;
  try {
    value = JSON.parse(deliverable.content.toString("utf8"));
  } catch {
    return { pass: false, detail: "deliverable is not valid JSON" };
  }
  const { count, shown } = shapeViolations(value, spec.shape);
  return { pass: count === 0, detail: count === 0 ? "json ok" : `${count} problem${count === 1 ? "" : "s"}: ${shown.join("; ")}` };
}

/** Required terms, literal and case-sensitive; with wholeWords, each must stand on its own. */
function checkContains(spec, deliverable) {
  const text = deliverable.content.toString("utf8");
  const terms = spec.all || [];
  const found = spec.wholeWords === true ? (t) => hasWholeWord(text, t) : (t) => text.includes(t);
  const missing = terms.filter((t) => !found(t));
  const pass = missing.length === 0;
  return { pass, detail: pass ? `all ${terms.length} terms present${spec.wholeWords === true ? " as whole words" : ""}` : `missing terms: ${missing.join(", ")}` };
}

/** length bounds on a text deliverable (words or chars). */
function checkLength(spec, deliverable) {
  const text = deliverable.content.toString("utf8");
  const n = spec.unit === "chars" ? text.length : text.trim().split(/\s+/).filter(Boolean).length;
  const min = spec.min ?? 0, max = spec.max ?? Infinity;
  const pass = n >= min && n <= max;
  return { pass, detail: `${spec.unit === "chars" ? "chars" : "words"}=${n} (need ${min}–${max === Infinity ? "∞" : max})` };
}

/** http-endpoint: the deliverable references a URL that must respond per spec.
 *  Deterministic w.r.t. a recorded response (we fetch once, record status+body
 *  hash into evidence so the verdict is reproducible/auditable). */
async function checkHttpEndpoint(spec, deliverable) {
  const url = spec.url || deliverable.url;
  if (!url) return { pass: false, detail: "no url provided" };
  try {
    // safeFetch enforces the SSRF denylist, a timeout, and a size cap.
    const { content, status } = await safeFetch(url, { timeoutMs: spec.timeoutMs || 5000 });
    const body = content.toString("utf8");
    const bodyHash = sha256(content);
    const expectStatus = spec.expectStatus ?? 200;
    let pass = status === expectStatus;
    let detail = `status=${status} (expect ${expectStatus})`;
    if (pass && spec.bodyIncludes) {
      const ok = spec.bodyIncludes.every((s) => body.includes(s));
      pass = ok;
      detail += ok ? " body ok" : " body missing required content";
    }
    // bodySha is a live-probe artifact: recorded for humans in `detail`, but it
    // is NOT part of the recomputable evidence core (see evidence.js).
    detail += ` bodySha=${bodyHash.slice(0, 16)}…`;
    return { pass, detail };
  } catch (e) {
    return { pass: false, detail: `fetch failed: ${probeFailure(e)}` };
  }
}

/** A probe failure in words that name its kind and nothing else: no address
 *  and no resolved IP, so the evidence never maps the judge's network. */
function probeFailure(e) {
  const code = e instanceof FetchError ? e.code : null;
  if (code === "INVALID_URL") return "invalid URL";
  if (code === "BLOCKED_SCHEME") return "only http and https are probed";
  if (code === "CREDENTIALS") return "URLs with credentials are not probed";
  if (code === "BLOCKED_ADDRESS") return "not a public internet address";
  if (code === "TOO_LARGE") return "the response is over the size limit";
  if (e?.name === "AbortError") return "timed out";
  if (e?.cause?.message === "unexpected redirect") return "redirects are not followed";
  if (e?.cause?.message === "bad port") return "a port that is not probed";
  return "the host could not be reached"; // DNS failures and names resolving to private addresses alike
}

const CHECKERS = {
  checksum: checkChecksum,
  schema: checkSchema,
  contains: checkContains,
  length: checkLength,
  "http-endpoint": checkHttpEndpoint,
  json: checkJson,
};

export const KNOWN_KINDS = Object.keys(CHECKERS);

// Bounds that keep every ruling small, fast and within one function run.
export const LIMITS = { checks: 64, probes: 4, depth: 12, terms: 256, termChars: 1024, urlChars: 2048, probeTimeoutMs: 10_000, weight: 1000 };
const TYPE_NAMES = ["string", "number", "boolean", "object"];
const has = (v) => v !== undefined && v !== null; // null params are treated as absent
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStringList = (v) => Array.isArray(v) && v.length <= LIMITS.terms
  && v.every((s) => typeof s === "string" && s.length <= LIMITS.termChars);
const isNumberIn = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** True if any object or array nests deeper than `limit` (the root is level 1). No recursion, so no input can overflow the stack. */
export function nestsDeeperThan(value, limit) {
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (d > limit) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return false;
}

/** What is wrong with one check's params, or null. Wrong types either crashed a checker or silently steered escrow. */
const CHECK_FIELDS = ["kind", "params", "weight"];
const PARAM_NAMES = { length: ["min", "max", "unit"], contains: ["all", "wholeWords"], schema: ["required", "types"],
  checksum: ["sha256"], "http-endpoint": ["url", "expectStatus", "bodyIncludes", "timeoutMs"], json: ["shape"] };
function paramsProblem(kind, p) {
  for (const k of Object.keys(p)) {
    if (!(PARAM_NAMES[kind] || []).includes(k)) return `unknown param "${k}" (known: ${(PARAM_NAMES[kind] || []).join(", ")})`;
  }
  switch (kind) {
    case "length":
      for (const k of ["min", "max"]) if (has(p[k]) && !isNumberIn(p[k], 0, Infinity)) return `${k} must be a number >= 0`;
      if (has(p.min) && has(p.max) && p.min > p.max) return "min must not be above max";
      if (has(p.unit) && p.unit !== "chars" && p.unit !== "words") return 'unit must be "chars" or "words"';
      return null;
    case "contains":
      if (has(p.all) && !isStringList(p.all)) return `all must be a list of at most ${LIMITS.terms} strings of at most ${LIMITS.termChars} characters`;
      if (has(p.wholeWords) && typeof p.wholeWords !== "boolean") return "wholeWords must be true or false";
      return null;
    case "schema":
      if (has(p.required) && !isStringList(p.required)) return `required must be a list of at most ${LIMITS.terms} field names of at most ${LIMITS.termChars} characters`;
      if (has(p.types)) {
        if (!isPlainObject(p.types)) return "types must be an object of field: type";
        const entries = Object.entries(p.types);
        if (entries.length > LIMITS.terms) return `types may name at most ${LIMITS.terms} fields`;
        for (const [field, type] of entries) if (!TYPE_NAMES.includes(type)) return `types.${field} must be one of ${TYPE_NAMES.join(", ")}`;
      }
      return null;
    case "checksum":
      if (typeof p.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(p.sha256)) return "sha256 must be 64 hex characters (no 0x)";
      return null;
    case "http-endpoint":
      if (has(p.url) && (typeof p.url !== "string" || p.url.length > LIMITS.urlChars)) return `url must be a string of at most ${LIMITS.urlChars} characters`;
      if (has(p.expectStatus) && !(Number.isInteger(p.expectStatus) && p.expectStatus >= 100 && p.expectStatus <= 599)) return "expectStatus must be an integer from 100 to 599";
      if (has(p.bodyIncludes) && !isStringList(p.bodyIncludes)) return `bodyIncludes must be a list of at most ${LIMITS.terms} strings of at most ${LIMITS.termChars} characters`;
      if (has(p.timeoutMs) && !isNumberIn(p.timeoutMs, 1, LIMITS.probeTimeoutMs)) return `timeoutMs must be a number from 1 to ${LIMITS.probeTimeoutMs}`;
      return null;
    case "json":
      return has(p.shape) ? shapeProblem(p.shape) : null;
    default:
      return null;
  }
}

/**
 * Validate an acceptance-criteria block BEFORE running any check. This is the
 * safety gate: malformed criteria must never be scored, because scoring them
 * silently steers escrow. Returns { valid, reason }. Confirmed failure modes
 * this closes (each reproduced against the pre-gate code):
 *   - checks:[] + passThreshold:0        → score 0, pass TRUE, full escrow released
 *   - passThreshold:101                  → good work scores 100 but pass FALSE → refund
 *   - unknown kind (incl. code-test)     → auto-fail → refund for anyone following docs
 *   - weight <= 0 (e.g. -9)              → score can exceed 100 / go negative →
 *                                          uint8 EIP-712 encode throws → job dropped,
 *                                          escrow stranded to expiry (client-triggerable DoS)
 */
/** True when any object inside the value has its own member named __proto__. */
function hasProtoMember(value) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "__proto__")) return true;
    for (const k of Object.keys(v)) stack.push(v[k]);
  }
  return false;
}

export function validateCriteria(criteria) {
  if (!criteria || typeof criteria !== "object")
    return { valid: false, reason: "criteria is not an object" };
  if (nestsDeeperThan(criteria, LIMITS.depth))
    return { valid: false, reason: `criteria nest deeper than ${LIMITS.depth} levels` };
  if (hasProtoMember(criteria))
    return { valid: false, reason: "criteria must not contain a member named __proto__" };
  if (!Array.isArray(criteria.checks) || criteria.checks.length === 0)
    return { valid: false, reason: "criteria.checks must be a non-empty array" };
  if (criteria.checks.length > LIMITS.checks)
    return { valid: false, reason: `at most ${LIMITS.checks} checks` };

  // passThreshold may be omitted (defaults to 100 = "all checks must pass", the
  // most conservative bar). If present it must be an integer in [0,100].
  if (criteria.passThreshold !== undefined) {
    const t = criteria.passThreshold;
    if (!Number.isInteger(t) || t < 0 || t > 100)
      return { valid: false, reason: `passThreshold must be an integer in [0,100], got ${t}` };
  }

  for (let i = 0; i < criteria.checks.length; i++) {
    const c = criteria.checks[i];
    if (!c || typeof c !== "object")
      return { valid: false, reason: `checks[${i}] is not an object` };
    // A misspelled field (say `param`) would otherwise drop the check's params
    // silently, and a check without them passes almost anything.
    const extra = Object.keys(c).find((k) => !CHECK_FIELDS.includes(k));
    if (extra !== undefined)
      return { valid: false, reason: `checks[${i}] unknown field "${extra}" (a check has only kind, params and weight)` };
    if (!KNOWN_KINDS.includes(c.kind))
      return { valid: false, reason: `checks[${i}] unknown kind "${c.kind}" (known: ${KNOWN_KINDS.join(", ")})` };
    if (c.weight !== undefined) {
      if (typeof c.weight !== "number" || !Number.isFinite(c.weight) || c.weight <= 0 || c.weight > LIMITS.weight)
        return { valid: false, reason: `checks[${i}] weight must be a finite number > 0 and at most ${LIMITS.weight}, got ${c.weight}` };
    }
    if (has(c.params) && !isPlainObject(c.params))
      return { valid: false, reason: `checks[${i}].params must be an object` };
    const problem = paramsProblem(c.kind, c.params ?? {});
    if (problem) return { valid: false, reason: `checks[${i}] (${c.kind}): ${problem}` };
  }
  if (criteria.checks.filter((c) => c.kind === "http-endpoint").length > LIMITS.probes)
    return { valid: false, reason: `at most ${LIMITS.probes} http-endpoint checks` };
  return { valid: true, reason: "ok" };
}

export async function runCheck(check, deliverable) {
  const fn = CHECKERS[check.kind];
  if (!fn) return { pass: false, detail: `unknown checker kind: ${check.kind}`, kind: check.kind };
  let r;
  try { r = await fn(check.params || {}, deliverable); } catch (e) {
    // Validation should make this unreachable; if a checker still throws, abstain rather than score.
    throw new InvalidCriteriaError(`${check.kind} check could not run: ${e.message}`);
  }
  return { ...r, kind: check.kind, weight: check.weight ?? 1 };
}

/**
 * Run all checks, compute weighted score 0-100, and a pass decision.
 * Throws InvalidCriteriaError if the criteria are malformed; callers MUST
 * treat that as "abstain / do not sign a verdict", never as a scored failure.
 * With validation enforced, all weights are > 0, so score ∈ [0,100] and always
 * encodes as uint8.
 */
export class InvalidCriteriaError extends Error {}

/**
 * The weighted score 0-100 and the decision (score >= threshold). A score of
 * 100 means every check passed: a failing check whose weight rounds away
 * scores 99, never 100, so a threshold of 100 always means every check must
 * pass. Mirrored in web/app.js; the two must agree.
 */
export function scoreOf(results, threshold) {
  let weightSum = 0, weightedPass = 0;
  for (const r of results) {
    const w = r.weight ?? 1;
    weightSum += w;
    if (r.pass) weightedPass += w;
  }
  const rounded = weightSum === 0 ? 0 : Math.round((weightedPass / weightSum) * 100);
  const score = results.every((r) => r.pass) ? rounded : Math.min(rounded, 99);
  return { score, pass: score >= threshold };
}

export async function runAllChecks(criteria, deliverable) {
  const v = validateCriteria(criteria);
  if (!v.valid) throw new InvalidCriteriaError(v.reason);

  const results = [];
  for (const check of criteria.checks) results.push(await runCheck(check, deliverable));
  const threshold = criteria.passThreshold ?? 100; // default: ALL must pass
  const { score, pass } = scoreOf(results, threshold);
  return { results, score, pass, threshold };
}
