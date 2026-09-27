// Plain-English acceptance text to checkable criteria. The drafter must turn
// every sentence into a check or refuse the milestone; it never guesses, and
// it never produces criteria the judge would refuse.
import test from "node:test";
import assert from "node:assert/strict";
import { draftCriteria, parseTerms } from "../src/drafter.js";
import { validateCriteria } from "../../kit/judge-kit.js";

const complete = (text) => {
  const d = draftCriteria(text);
  assert.equal(d.complete, true, `${text} -> uncovered: ${JSON.stringify(d.uncovered)} ${d.reason || ""}`);
  assert.equal(validateCriteria(d.criteria).valid, true, "a complete draft is always valid criteria");
  return d.criteria;
};
const refused = (text, why) => {
  const d = draftCriteria(text);
  assert.equal(d.complete, false, `${text} must be refused`);
  assert.equal(d.criteria, null, "no criteria when refused: nothing half-drafted reaches the chain");
  if (why) assert.match(`${d.reason} ${JSON.stringify(d.uncovered)}`, why);
  return d;
};

test("word bounds and required terms", () => {
  const c = complete("Between 30 and 120 words. Must mention ERC-8183, USDC and Arc.");
  assert.deepEqual(c.checks, [
    { kind: "length", params: { min: 30, max: 120 } },
    { kind: "contains", params: { all: ["ERC-8183", "USDC", "Arc"], wholeWords: true } },
  ]);
});

test("every way of saying a length bound", () => {
  const len = (t) => complete(t).checks.find((x) => x.kind === "length").params;
  assert.deepEqual(len("At least 50 words."), { min: 50 });
  assert.deepEqual(len("No more than 200 words."), { max: 200 });
  assert.deepEqual(len("Under 200 words."), { max: 199 });
  assert.deepEqual(len("Fewer than 10 words."), { max: 9 });
  assert.deepEqual(len("More than 5 words."), { min: 6 });
  assert.deepEqual(len("30-120 words."), { min: 30, max: 120 });
  assert.deepEqual(len("Exactly 3 words."), { min: 3, max: 3 });
  assert.deepEqual(len("At most 280 characters."), { max: 280, unit: "chars" });
  assert.deepEqual(len("The summary must be at least 40 words long."), { min: 40 });
  assert.deepEqual(len("At least 20 words. At most 90 words."), { min: 20, max: 90 }, "bounds on one unit merge");
});

test("words and characters become separate checks", () => {
  const c = complete("At least 20 words. At most 900 characters.");
  assert.deepEqual(c.checks, [
    { kind: "length", params: { min: 20 } },
    { kind: "length", params: { max: 900, unit: "chars" } },
  ]);
});

test("quoted multi-word terms are kept exactly; mention sentences merge", () => {
  const c = complete('Must mention "Circle Gateway" and x402. Should include the term "escrow".');
  assert.deepEqual(c.checks, [{ kind: "contains", params: { all: ["Circle Gateway", "x402", "escrow"], wholeWords: true } }]);
});

test("JSON with fields and types", () => {
  const c = complete("Valid JSON with fields invoiceId, total and currency. total must be a number. currency must be a string.");
  assert.deepEqual(c.checks, [{ kind: "schema", params: { required: ["invoiceId", "total", "currency"], types: { total: "number", currency: "string" } } }]);
});

test("a field that must have a type must also be present (an empty object is not a pass)", () => {
  const c = complete("Valid JSON. total must be a number.");
  assert.deepEqual(c.checks, [{ kind: "schema", params: { required: ["total"], types: { total: "number" } } }]);
});

test("a file checksum and a live endpoint", () => {
  const hex = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  assert.deepEqual(complete(`The SHA-256 is ${hex}.`).checks, [{ kind: "checksum", params: { sha256: hex } }]);
  assert.deepEqual(complete('https://status.example.com/health must return 200 and contain "ok".').checks,
    [{ kind: "http-endpoint", params: { url: "https://status.example.com/health", expectStatus: 200, bodyIncludes: ["ok"] } }]);
});

test("refuses what a deterministic judge cannot check, and says which sentence", () => {
  const d = refused("Between 30 and 120 words. Make it look great.", /look great/);
  assert.deepEqual(d.uncovered, ["Make it look great"]);
  refused("Write something inspiring.");
  refused("");
});

test("refuses ambiguity instead of guessing", () => {
  refused("Must mention the escrow standard and USDC.", /escrow standard/); // unquoted multi-word term
  refused("Must mention USDC or EURC.", /or EURC/);                         // any-of is not all-of
  refused("Between 200 and 100 words.", /conflict|min/);                   // impossible bounds
  refused("At least 90 words. At most 20 words.", /conflict|min/);
  refused("amount must be a number. amount must be a string.", /conflict/); // two types for one field
  refused(`The SHA-256 is ${"a".repeat(64)}. The SHA-256 is ${"b".repeat(64)}.`, /conflict/);
});

test("term parsing", () => {
  assert.deepEqual(parseTerms("A, B and C"), ["A", "B", "C"]);
  assert.deepEqual(parseTerms('"two words", C'), ["two words", "C"]);
  assert.deepEqual(parseTerms("A & B"), ["A", "B"]);
  assert.equal(parseTerms("the thing"), null);
  assert.equal(parseTerms("A or B"), null);
  assert.equal(parseTerms(""), null);
});

test("required terms are whole words: \"Arc\" is not satisfied by \"Architecture\"", async () => {
  const { runAllChecks } = await import("../../judge-service/src/checkers/index.js");
  const c = complete("Must mention Arc and USDC.");
  const r = await runAllChecks(c, { content: Buffer.from("A software Architecture that pays in USDC."), source: "t" });
  assert.equal(r.pass, false);
});
