// The ERC-8404 profile (rvr/profiles/judge-protocol-rvr-v0) says its SPEC
// describes what the live judge does. This checks that claim: the judge's own
// code and the profile's independent Python adapter must derive the same
// rulings, keccak for keccak, on the profile's vectors and on generated cases
// aimed at the places two languages disagree: UTF-16 lengths, whitespace sets,
// Unicode word boundaries, typeof, key order and rounding.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const { extractCriteria, criteriaHash } = await import("../src/criteria.js");
const { runAllChecks, validateCriteria } = await import("../src/checkers/index.js");
const { evidenceHashOf } = await import("../src/evidence.js");

const PROFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "rvr", "profiles", "judge-protocol-rvr-v0");
const noPython = spawnSync("python3", ["--version"]).status !== 0 && "python3 not available";
const describe = (criteria) => `Cross-check job.\n\`\`\`judge-criteria\n${JSON.stringify(criteria)}\n\`\`\``;

/** What the live judge signs for this description and deliverable, or why it would not rule. */
async function judge(description, content, jobId) {
  const criteria = extractCriteria(description);
  if (!criteria || !validateCriteria(criteria).valid) return { refused: true };
  if (criteria.checks.some((c) => c.kind === "http-endpoint")) return { outOfScope: true };
  const { results, score, pass, threshold } = await runAllChecks(criteria, { content });
  const cHash = criteriaHash(criteria);
  return { criteriaHash: cHash, checks: results.map((r) => ({ kind: r.kind, pass: !!r.pass })), score, threshold, pass,
    evidenceHash: evidenceHashOf({ jobId, criteriaHash: cHash, deliverable: keccak256(content), criteria, results, score, threshold, pass }) };
}

function adapter(requests) {
  const out = spawnSync("python3", [path.join(PROFILE, "adapter.py"), "--evaluate"], {
    input: JSON.stringify(requests), encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
}

async function compare(cases) {
  const requests = cases.map(({ description, content, jobId }) => ({ description, jobId, commitment: keccak256(content),
    deliverableBase64: Buffer.from(content).toString("base64") }));
  const python = adapter(requests);
  let compared = 0;
  for (const [i, c] of cases.entries()) {
    const js = await judge(c.description, c.content, c.jobId);
    const py = python[i];
    const label = `${c.label}: ${c.description.slice(0, 160)} | ${JSON.stringify(Buffer.from(c.content).toString("utf8").slice(0, 80))}`;
    if (js.refused) { assert.match(py.gate ?? "", /criteria_(invalid|missing)/, label); continue; }
    if (js.outOfScope) { assert.equal(py.gate, "rvr.judge-protocol.v0.gate.criteria_out_of_scope", label); continue; }
    assert.deepEqual(py, js, label);
    compared++;
  }
  return compared;
}

test("the judge and the profile's Python adapter derive the same ruling for every vector", { skip: noPython }, async () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(PROFILE, "vectors.json"), "utf8"));
  const cases = vectors.semanticCases.map((v) => ({ label: v.id, jobId: "900001", description: describe(v.criteria), content: Buffer.from(v.deliverable, "utf8") }));
  for (const job of ["186779", "186780"]) {
    const snap = JSON.parse(fs.readFileSync(path.join(PROFILE, "upstream", `job-${job}.snapshot.json`), "utf8"));
    cases.push({ label: `job ${job}`, jobId: job, description: snap.job.description, content: fs.readFileSync(path.join(PROFILE, "upstream", `job-${job}.deliverable.bin`)) });
    const js = await judge(snap.job.description, fs.readFileSync(path.join(PROFILE, "upstream", `job-${job}.deliverable.bin`)), job);
    assert.equal(js.evidenceHash, snap.verdict.evidenceHash, `the live judge's code reproduces job ${job}'s on-chain evidenceHash`);
  }
  assert.equal(await compare(cases), cases.length);
});

test("and on 300 generated cases aimed at the places JavaScript and Python differ", { skip: noPython }, async () => {
  let seed = 8404;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const PIECES = ["word", "USDC", "USDCx", "_USDC", "USDC_", "café", "é", "ß", "Ⅻ", "²", "٣", "😀", "2026",
    " ", "  ", "\t", "\n", " ", " ", "　", "﻿", " ", "\u001c", "\u0085", "᠎", ",", ".", "-", "a", "Z"];
  const TERMS = ["USDC", "café", "Ⅻ", "²", "e", "😀", "a b", "2026", "_", "word"];
  const text = () => Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => pick(PIECES)).join("");
  const jsonDeliverable = () => {
    const values = ['"s"', "1", "1.5", "-0", "true", "null", "[1]", "{}", '"12"'];
    const keys = ["a", "b", "n", "10", "9"];
    return `{${Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => `"${pick(keys)}":${pick(values)}`).join(",")}}`;
  };
  const check = (kind) => {
    const weight = rnd() < 0.5 ? {} : { weight: 1 + Math.floor(rnd() * 9) };
    if (kind === "length") return { kind, params: { ...(rnd() < 0.5 ? { unit: "chars" } : {}), min: Math.floor(rnd() * 4), max: 2 + Math.floor(rnd() * 14) }, ...weight };
    if (kind === "contains") return { kind, params: { all: [pick(TERMS)], ...(rnd() < 0.6 ? { wholeWords: true } : {}) }, ...weight };
    if (kind === "schema") return { kind, params: { required: [pick(["a", "n", "10"])], types: { [pick(["a", "b", "n", "9"])]: pick(["string", "number", "boolean", "object"]) } }, ...weight };
    return { kind, params: { sha256: "a".repeat(64) }, ...weight };
  };
  const cases = [];
  for (let i = 0; i < 300; i++) {
    const schemaCase = rnd() < 0.3;
    const kinds = schemaCase ? ["schema", pick(["length", "contains"])] : Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(["length", "contains", "length", "checksum"]));
    const criteria = { version: 1, ...(rnd() < 0.7 ? { passThreshold: pick([0, 1, 33, 50, 67, 99, 100]) } : {}), checks: kinds.map(check) };
    cases.push({ label: `generated ${i}`, jobId: String(700000 + i), description: describe(criteria), content: Buffer.from(schemaCase ? jsonDeliverable() : text(), "utf8") });
  }
  const compared = await compare(cases);
  assert.ok(compared > 250, `compared ${compared} rulings`);
});

test("criteria the judge refuses or the profile excludes are never ruled on by either", { skip: noPython }, async () => {
  const content = Buffer.from("some deliverable text");
  const cases = [
    { label: "unknown field", description: describe({ version: 1, checks: [{ kind: "length", param: { min: 1 } }] }) },
    { label: "zero weight", description: describe({ version: 1, checks: [{ kind: "length", params: { min: 1 }, weight: 0 }] }) },
    { label: "no block", description: "No criteria here." },
    { label: "probe", description: describe({ version: 1, checks: [{ kind: "http-endpoint", params: { url: "https://example.com" } }] }) },
  ].map((c) => ({ ...c, jobId: "900002", content }));
  assert.equal(await compare(cases), 0);
});
