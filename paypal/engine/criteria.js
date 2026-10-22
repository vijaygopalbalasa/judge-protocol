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

/**
 * The text of the first judge-criteria block: exactly what /```judge-criteria\s*([\s\S]*?)```/ captures,
 * found in linear time. That expression backtracks quadratically on an opening fence with no closing one,
 * and a job description on chain is as long as its author likes. The first marker decides the answer: any
 * later marker starts with a fence that would already close the first block. Copies in kit/judge-kit.js and
 * web/app.js; test/criteria-block.test.js holds all three to the expression over a fixed corpus.
 */
export function criteriaBlockText(description) {
  const open = description.indexOf("```judge-criteria");
  if (open === -1) return null;
  let start = open + "```judge-criteria".length;
  while (start < description.length && /\s/.test(description[start])) start++;
  const close = description.indexOf("```", start);
  return close === -1 ? null : description.slice(start, close);
}

export function extractCriteria(description) {
  if (!description) return null;
  const text = criteriaBlockText(String(description));
  if (text === null) return null;
  try {
    const criteria = JSON.parse(text);
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
    // A null-prototype accumulator: on a plain {} the key "__proto__" would hit the
    // prototype setter and vanish from the hash instead of being hashed as a member.
    return Object.keys(x).sort().reduce((acc, k) => {
      acc[k] = sortKeys(x[k]);
      return acc;
    }, Object.create(null));
  }
  return x;
}

export function criteriaHash(criteria) {
  return keccak256(toHex(canonicalize(criteria)));
}
