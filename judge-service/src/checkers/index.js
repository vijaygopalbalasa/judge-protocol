// Deterministic checkers. Each checker is a pure function:
//   (checkSpec, resolvedDeliverable) -> { pass, detail }
// Determinism rule: same inputs ALWAYS produce the same verdict. No LLM in the
// decision path. An LLM may later summarize `detail` for humans, never decide.

import crypto from "node:crypto";
import { safeFetch } from "../safe-fetch.js";

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
  const required = spec.required || [];
  const missing = required.filter((f) => !(f in obj));
  const typeErrors = [];
  for (const [field, type] of Object.entries(spec.types || {})) {
    if (field in obj && typeof obj[field] !== type) {
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

/** regex / keyword presence against a text deliverable. */
function checkContains(spec, deliverable) {
  const text = deliverable.content.toString("utf8");
  const terms = spec.all || [];
  const missing = terms.filter((t) => !text.includes(t));
  const pass = missing.length === 0;
  return { pass, detail: pass ? `all ${terms.length} terms present` : `missing terms: ${missing.join(", ")}` };
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
    return { pass: false, detail: `fetch failed: ${e.message}` };
  }
}

const CHECKERS = {
  checksum: checkChecksum,
  schema: checkSchema,
  contains: checkContains,
  length: checkLength,
  "http-endpoint": checkHttpEndpoint,
};

export const KNOWN_KINDS = Object.keys(CHECKERS);

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
export function validateCriteria(criteria) {
  if (!criteria || typeof criteria !== "object")
    return { valid: false, reason: "criteria is not an object" };
  if (!Array.isArray(criteria.checks) || criteria.checks.length === 0)
    return { valid: false, reason: "criteria.checks must be a non-empty array" };

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
    if (!KNOWN_KINDS.includes(c.kind))
      return { valid: false, reason: `checks[${i}] unknown kind "${c.kind}" (known: ${KNOWN_KINDS.join(", ")})` };
    if (c.weight !== undefined) {
      if (typeof c.weight !== "number" || !Number.isFinite(c.weight) || c.weight <= 0)
        return { valid: false, reason: `checks[${i}] weight must be a finite number > 0, got ${c.weight}` };
    }
  }
  return { valid: true, reason: "ok" };
}

export async function runCheck(check, deliverable) {
  const fn = CHECKERS[check.kind];
  if (!fn) return { pass: false, detail: `unknown checker kind: ${check.kind}`, kind: check.kind };
  const r = await fn(check.params || {}, deliverable);
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

export async function runAllChecks(criteria, deliverable) {
  const v = validateCriteria(criteria);
  if (!v.valid) throw new InvalidCriteriaError(v.reason);

  const results = [];
  let weightSum = 0, weightedPass = 0;
  for (const check of criteria.checks) {
    const r = await runCheck(check, deliverable);
    results.push(r);
    const w = r.weight ?? 1;
    weightSum += w;
    if (r.pass) weightedPass += w;
  }
  const score = Math.round((weightedPass / weightSum) * 100);
  const threshold = criteria.passThreshold ?? 100; // default: ALL must pass
  const pass = score >= threshold;
  return { results, score, pass, threshold };
}
