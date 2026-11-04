import test from "node:test";
import assert from "node:assert/strict";
import { describeCheck, describeEvent, describeResult } from "../public/plain.js";

const RECON = { kind: "json", weight: 3, params: { shape: {
  type: "object", additionalProperties: false,
  required: ["report", "currency", "total_refunds", "receipt_ids", "summary"],
  properties: {
    report: { type: "string", enum: ["refund_reconciliation"] },
    currency: { type: "string", enum: ["USD"] },
    total_refunds: { type: "number", enum: [25] },
    receipt_ids: { type: "array", minItems: 3, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["RCPT-1042", "RCPT-1048", "RCPT-1051"] } },
    summary: { type: "string", minLength: 20, maxLength: 240 },
  } } } };

test("a JSON shape reads as plain rules a buyer can check by eye", () => {
  const d = describeCheck(RECON);
  assert.equal(d.title, "The answer is a JSON object");
  assert.deepEqual(d.lines, [
    "It has exactly these fields: report, currency, total_refunds, receipt_ids, summary",
    "report is exactly \"refund_reconciliation\"",
    "currency is exactly \"USD\"",
    "total_refunds is exactly 25",
    "receipt_ids is a list of exactly 3 different items, each one of RCPT-1042, RCPT-1048, RCPT-1051",
    "summary is text of 20 to 240 characters",
  ]);
});

test("simple checks read as one sentence", () => {
  assert.equal(describeCheck({ kind: "contains", params: { all: ["a", "b", "c"] } }).title, "Mentions a, b and c");
  assert.equal(describeCheck({ kind: "contains", params: { all: ["refund"], wholeWords: true } }).title, "Mentions refund (as whole words)");
  assert.equal(describeCheck({ kind: "length", params: { min: 100, max: 1000, unit: "chars" } }).title, "Between 100 and 1,000 characters long");
  assert.equal(describeCheck({ kind: "length", params: { min: 50, unit: "words" } }).title, "At least 50 words long");
  assert.equal(describeCheck({ kind: "length", params: { max: 80 } }).title, "At most 80 words long");
  assert.match(describeCheck({ kind: "checksum", params: { sha256: "ab".repeat(32) } }).title, /^The file is exactly the agreed one \(SHA-256 abababab/);
  assert.equal(describeCheck({ kind: "schema", params: { required: ["name", "price"] } }).title, "JSON with the fields name, price");
  assert.equal(describeCheck({ kind: "mystery", params: {} }).title, "mystery check");
});

test("results and events read as sentences, with the raw detail kept", () => {
  assert.deepEqual(describeResult({ kind: "length", pass: true, detail: "chars=229 (need 100–1000)" }), { pass: true, text: "Length: chars=229 (need 100–1000)" });
  assert.equal(describeEvent({ type: "posted", detail: "checks pinned: 0xabc" }), "Job created; checks pinned (0xabc)");
  assert.equal(describeEvent({ type: "funded", detail: "4EY876062S256002U" }), "PayPal hold authorized (4EY876062S256002U)");
  assert.equal(describeEvent({ type: "something-new" }), "something-new");
});
