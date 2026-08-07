// Acceptance-criteria handling.
//
// A job's description carries (or references) a structured acceptance block.
// v1 convention: the description embeds a fenced JSON block:
//
//   ```judge-criteria
//   { "version":1, "jobType":"api", "passThreshold":100,
//     "checks":[ {"kind":"schema","params":{...},"weight":1}, ... ] }
//   ```
//
// We parse it, and compute criteriaHash = keccak256 of the canonical JSON.
// That hash is committed on-chain and binds the verdict to exact criteria.

import { keccak256, toHex } from "viem";

export function extractCriteria(description) {
  if (!description) return null;
  const m = description.match(/```judge-criteria\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const criteria = JSON.parse(m[1]);
    return criteria;
  } catch {
    return null;
  }
}

export function canonicalize(criteria) {
  // Stable stringify (sorted keys) so the hash is deterministic.
  return JSON.stringify(sortKeys(criteria));
}

function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") {
    return Object.keys(x).sort().reduce((acc, k) => {
      acc[k] = sortKeys(x[k]);
      return acc;
    }, {});
  }
  return x;
}

export function criteriaHash(criteria) {
  return keccak256(toHex(canonicalize(criteria)));
}
