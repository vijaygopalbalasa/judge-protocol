// The checklist builder on the verifier site (web/builder.js) and this kit must write the same
// job description for the same criteria, byte for byte, so a checklist made in the browser and
// one made in code are the same checklist with the same criteria hash.
import test from "node:test";
import assert from "node:assert/strict";

const kit = await import("../judge-kit.js");
const builder = await import("../../web/builder.js");

const SAMPLES = [
  ["text", { minWords: 50, maxWords: 300, terms: ["USDC", "escrow"], wholeWords: true }],
  ["text", { minWords: 1, terms: ["use `judge`", "```", "a`b"] }],
  ["records", {
    count: { min: 10, max: 10 },
    uniqueBy: { field: "website", key: "domain" },
    fields: [
      { name: "name", type: "text" },
      { name: "website", type: "url" },
      { name: "network", type: "one-of", options: ["Arc", "Base"] },
      { name: "contact", type: "email-or-url" },
    ],
  }],
  ["record", { fields: [{ name: "price", type: "number" }, { name: "note", type: "text", required: false }], noExtraFields: true }],
  ["file", { sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }],
  ["endpoint", { url: "https://example.com/health", expectStatus: 200, bodyIncludes: ["ok"] }],
];

test("the builder's default title is the kit's", () => {
  const c = builder.buildCriteria(...SAMPLES[0]);
  assert.equal(builder.jobDescription("", c), kit.criteriaBlock(c));
});

test("the builder writes the kit's block byte for byte, and the kit accepts every template", () => {
  for (const [template, answers] of SAMPLES) {
    const c = builder.buildCriteria(template, answers);
    const title = `A ${template} job, judged by Judge Protocol.`;
    assert.equal(builder.jobDescription(title, c), kit.criteriaBlock(c, { title }), template);
    assert.deepEqual(kit.validateCriteria(c), { valid: true, reason: "ok" }, template);
    assert.equal(kit.criteriaHash(kit.extractCriteria(builder.jobDescription(title, c))), kit.criteriaHash(c), template);
  }
});
