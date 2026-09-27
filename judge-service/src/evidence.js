// Deliverable resolution + evidence store.
//
// The on-chain `deliverable` is a bytes32 commitment. The actual payload is
// resolved off-chain. v1 convention: the job description carries a
// `deliverableURI` (https:// or ipfs:// or data:) that the provider's bytes32
// commits to. We fetch it, record the raw bytes hash, and run checkers.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { keccak256, toHex } from "viem";
import { config } from "./config.js";
import { safeFetch, MAX_BYTES } from "./safe-fetch.js";
import { canonicalize } from "./criteria.js";

const sha256hex = (buf) => "0x" + crypto.createHash("sha256").update(buf).digest("hex");

export function extractDeliverableURI(description) {
  if (!description) return null;
  const m = description.match(/deliverableURI:\s*(\S+)/);
  return m ? m[1] : null;
}

/** Resolve a deliverable into { content: Buffer, source, url? }. All network
 *  fetches go through safeFetch (SSRF denylist + timeout + size cap). */
export async function resolveDeliverable(uri) {
  if (!uri) throw new Error("no deliverable URI");
  if (uri.startsWith("data:")) {
    const base64 = uri.split(",")[1] || "";
    const content = Buffer.from(base64, "base64");
    if (content.length > MAX_BYTES) throw new Error(`data URI exceeds ${MAX_BYTES} bytes`);
    return { content, source: "data" };
  }
  if (uri.startsWith("ipfs://")) {
    const gw = process.env.IPFS_GATEWAY || "https://ipfs.io/ipfs/";
    const url = gw + uri.replace("ipfs://", "");
    const { content, status } = await safeFetch(url);
    if (status < 200 || status >= 300) throw new Error(`ipfs fetch ${status}`);
    return { content, source: "ipfs", url };
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const { content, status } = await safeFetch(uri);
    if (status < 200 || status >= 300) throw new Error(`http fetch ${status}`);
    return { content, source: "http", url: uri };
  }
  throw new Error(`unsupported deliverable URI scheme: ${uri}`);
}

/**
 * The recomputable core of a verdict: exactly the fields a third party can
 * re-derive from (criteria + deliverable bytes) alone. Wall-clock timestamps
 * and non-reproducible probe outputs (http status, bodySha) are DELIBERATELY
 * excluded so `evidenceHash` is a pure function of the inputs; that is what
 * makes a verdict independently verifiable. Serialized via canonicalize
 * (sorted keys, no whitespace) so the bytes are stable across machines.
 */
export function evidenceCore(verdictObj) {
  return {
    jobId: String(verdictObj.jobId),
    criteriaHash: verdictObj.criteriaHash,
    deliverable: verdictObj.deliverable,
    criteria: verdictObj.criteria,
    // Only the reproducible fields of each check result: kind, params, pass.
    checks: (verdictObj.results || []).map((r) => ({
      kind: r.kind,
      pass: !!r.pass,
      weight: r.weight ?? 1,
    })),
    score: verdictObj.score,
    threshold: verdictObj.threshold,
    pass: !!verdictObj.pass,
  };
}

/** keccak256 of the canonical core: the value signed and posted on-chain. */
export function evidenceHashOf(verdictObj) {
  return keccak256(toHex(canonicalize(evidenceCore(verdictObj))));
}

/**
 * Persist the full structured verdict as evidence (human-readable, with
 * timestamps/detail for audit) AND return evidenceHash computed over the
 * canonical CORE only. The file is written to `job-<id>-<evidenceHash8>.json`
 * so re-running a job can never destroy the artifact that verifies an earlier
 * on-chain hash.
 */
export function storeEvidence(verdictObj) {
  fs.mkdirSync(config.evidenceDir, { recursive: true });
  const evidenceHash = evidenceHashOf(verdictObj);
  const record = { ...verdictObj, evidenceHash, evidenceCore: evidenceCore(verdictObj) };
  const json = JSON.stringify(record, null, 2);
  const file = path.join(config.evidenceDir, `job-${verdictObj.jobId}-${evidenceHash.slice(2, 10)}.json`);
  fs.writeFileSync(file, json);
  return { file, evidenceHash, json };
}

export function keccakOfString(s) {
  // keccak256 of the UTF-8 bytes, matches on-chain `reason`/evidenceHash.
  return keccak256(toHex(s));
}

export { sha256hex };
