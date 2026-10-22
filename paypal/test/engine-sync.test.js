// Judge Pay carries copies of Judge Protocol's checking engine and browser verifier (scripts/sync-engine.js). These
// tests fail when a copy drifts from its source, and hold the browser's recompute to the server's verdict.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_FILES } from "../scripts/sync-engine.js";
import { dryRunEvaluate } from "../engine/evaluate.js";
import { criteriaHash } from "../engine/criteria.js";
import * as browser from "../public/verify/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

test("every copied engine and verifier file is byte-identical to its source (run npm run sync-engine to refresh)", () => {
  assert.ok(ENGINE_FILES.length >= 16);
  for (const [from, to] of ENGINE_FILES) {
    assert.ok(readFileSync(join(repo, from)).equals(readFileSync(join(here, "..", to))), `${to} differs from ${from}`);
  }
});

const CASES = [
  { criteria: { version: 1, passThreshold: 100, checks: [{ kind: "contains", params: { all: ["refund", "receipt"] }, weight: 2 }, { kind: "length", params: { min: 3, max: 40 } }] },
    text: "Every refund comes with a receipt." },
  { criteria: { version: 1, passThreshold: 60, checks: [{ kind: "contains", params: { all: ["Résumé"], wholeWords: true } }, { kind: "length", params: { min: 1, max: 3, unit: "words" } }] },
    text: "Résumé reviewed carefully today, all good." },
  { criteria: { version: 1, checks: [{ kind: "json", params: { shape: { type: "object", required: ["name", "items"], properties: {
      name: { type: "string", minLength: 1 }, items: { type: "array", minItems: 1, items: { type: "object", required: ["sku"], properties: { sku: { type: "string" } } } } } } } }] },
    text: JSON.stringify({ name: "order", items: [{ sku: "A1", qty: 2 }] }) },
  { criteria: { version: 1, checks: [{ kind: "schema", params: { required: ["title", "price"], types: { price: "number" } } }] },
    text: JSON.stringify({ title: "mug", price: "12" }) },
];

test("the browser recompute gives the same score, decision and evidenceHash as the server for Judge Pay jobs", async () => {
  for (const [i, c] of CASES.entries()) {
    const jobId = String(1_792_000_000_000_000 + i);
    const res = await dryRunEvaluate({ criteria: c.criteria, deliverable: c.text, jobId });
    assert.equal(res.status, 200, `case ${i} must be valid criteria: ${JSON.stringify(res.body)}`);
    const server = res.body;
    const bytes = new TextEncoder().encode(c.text);
    const r = await browser.runChecks(c.criteria, bytes);
    assert.equal(r.score, server.score, `case ${i} score`);
    assert.equal(r.pass, server.pass, `case ${i} pass`);
    assert.equal(browser.criteriaHash(c.criteria), server.criteriaHash, `case ${i} criteriaHash`);
    assert.equal(browser.criteriaHash(c.criteria), criteriaHash(c.criteria));
    const deliverable = browser.keccakBytes(bytes);
    assert.equal(deliverable, server.deliverable, `case ${i} deliverable hash`);
    const evidenceHash = browser.evidenceHashOf({ jobId, criteriaHash: server.criteriaHash, deliverable, criteria: c.criteria,
      results: r.results, score: r.score, threshold: r.threshold, pass: r.pass });
    assert.equal(evidenceHash, server.evidenceHash, `case ${i} evidenceHash`);
  }
});
