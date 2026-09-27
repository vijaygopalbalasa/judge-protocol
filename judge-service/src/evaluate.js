// Dry-run evaluation: run the deterministic checks on a deliverable exactly as
// the judge would, and return the score, decision and the evidenceHash the
// judge would sign. It NEVER signs or settles anything (this module does not
// import the signer), so it is safe to expose publicly.
//
// Hosted (allowLiveProbes: false): an http-endpoint check is not run, because a
// live network probe from a public endpoint is an abuse vector; its result is
// reported as not run and the overall score is null. Local runs may allow it.
import { keccak256 } from "viem";
import { criteriaHash } from "./criteria.js";
import { evidenceHashOf } from "./evidence.js";
import { runCheck, validateCriteria, InvalidCriteriaError } from "./checkers/index.js";

export const MAX_DELIVERABLE_BYTES = 256 * 1024;
const LIVE = new Set(["http-endpoint"]);
const jsonable = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export async function dryRunEvaluate(input = {}, { allowLiveProbes = false } = {}) {
  const { criteria, deliverable, deliverableBase64, jobId } = input || {};
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    return { status: 400, body: { error: "provide `criteria` as a JSON object" } };
  }
  const hasText = deliverable !== undefined, hasB64 = deliverableBase64 !== undefined;
  if (hasText === hasB64) {
    return { status: 400, body: { error: "provide exactly one of `deliverable` (utf-8 text) or `deliverableBase64`" } };
  }
  if (jobId !== undefined && !/^[0-9]{1,30}$/.test(String(jobId))) {
    return { status: 400, body: { error: "`jobId` must be a positive integer (used only for the evidenceHash)" } };
  }
  const content = hasB64 ? Buffer.from(String(deliverableBase64), "base64") : Buffer.from(String(deliverable), "utf8");
  if (content.length > MAX_DELIVERABLE_BYTES) {
    return { status: 413, body: { error: `deliverable exceeds ${MAX_DELIVERABLE_BYTES} bytes` } };
  }
  const v = validateCriteria(criteria);
  if (!v.valid) return { status: 422, body: { valid: false, reason: v.reason } };

  const results = [];
  const notRun = [];
  let wSum = 0, wPass = 0;
  for (const check of criteria.checks) {
    const w = check.weight ?? 1;
    if (!allowLiveProbes && LIVE.has(check.kind)) {
      notRun.push(check.kind);
      results.push({ kind: check.kind, weight: w, pass: null, detail: "live network probe: not run in the dry run" });
      continue;
    }
    let r;
    try { r = await runCheck(check, { content, source: "inline" }); } catch (e) {
      if (e instanceof InvalidCriteriaError) return { status: 422, body: { valid: false, reason: e.message } };
      throw e;
    }
    results.push(r);
    wSum += w; if (r.pass) wPass += w;
  }
  const cHash = criteriaHash(criteria);
  const commitment = keccak256(content);
  const threshold = criteria.passThreshold ?? 100;
  if (notRun.length) {
    return { status: 200, body: jsonable({ dryRun: true, valid: true, criteriaHash: cHash, deliverable: commitment,
      results, notRun: [...new Set(notRun)], score: null, pass: null, threshold, evidenceHash: null }) };
  }
  const score = Math.round((wPass / wSum) * 100);
  const pass = score >= threshold;
  const evidenceHash = evidenceHashOf({ jobId: String(jobId ?? "0"), criteriaHash: cHash, deliverable: commitment,
    criteria, results, score, threshold, pass });
  return { status: 200, body: jsonable({ dryRun: true, valid: true, criteriaHash: cHash, deliverable: commitment,
    results, score, pass, threshold, evidenceHash }) };
}
