// The integration docs and the agent skill must describe the code as it is:
// every check kind and parameter, every API result, the real addresses, and
// only criteria examples the judge would actually accept.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const kit = await import("../judge-kit.js");
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const CRITERIA_MD = read("docs/CRITERIA.md");
const INTEGRATION_MD = read("docs/INTEGRATION.md");
const SKILL_MD = read("skills/judge-protocol/SKILL.md");

const PARAMS = {
  length: ["min", "max", "unit"],
  contains: ["all"],
  schema: ["required", "types"],
  checksum: ["sha256"],
  "http-endpoint": ["url", "expectStatus", "bodyIncludes", "timeoutMs"],
};

test("CRITERIA.md documents every check kind and every parameter the judge reads", () => {
  assert.deepEqual(Object.keys(PARAMS).sort(), [...kit.KNOWN_KINDS].sort(), "update PARAMS when a kind is added");
  for (const [kind, params] of Object.entries(PARAMS)) {
    assert.match(CRITERIA_MD, new RegExp("`" + kind + "`"), `kind ${kind}`);
    for (const p of params) assert.match(CRITERIA_MD, new RegExp("`" + p + "`"), `${kind}.${p}`);
  }
  for (const term of ["passThreshold", "weight", "criteriaHash", "keccak256"]) assert.match(CRITERIA_MD, new RegExp(term));
});

function jsonBlocksWithChecks(md) {
  return [...md.matchAll(/```(?:json|judge-criteria)\n([\s\S]*?)```/g)]
    .map((m) => m[1]).filter((b) => b.includes('"checks"')).map((b) => JSON.parse(b));
}

test("every criteria example in the docs is one the judge would accept", () => {
  const examples = [...jsonBlocksWithChecks(CRITERIA_MD), ...jsonBlocksWithChecks(INTEGRATION_MD), ...jsonBlocksWithChecks(SKILL_MD)];
  assert.ok(examples.length >= 4, `expected several examples, found ${examples.length}`);
  for (const c of examples) assert.equal(kit.validateCriteria(c).valid, true, JSON.stringify(c));
});

test("INTEGRATION.md uses the real addresses and documents every endpoint", () => {
  for (const v of [kit.ARC_TESTNET.acp, kit.ARC_TESTNET.judge, kit.ARC_TESTNET.api, kit.ARC_TESTNET.verifier]) assert.ok(INTEGRATION_MD.includes(v), v);
  for (const e of ["POST /api/judge", "GET /api/judge?jobId=", "POST /api/evaluate", "GET /api/health", "submitTx"]) assert.ok(INTEGRATION_MD.includes(e), e);
});

test("INTEGRATION.md explains every result the hosted judge can return", () => {
  const src = read("judge-service/src/judge-now.js");
  const results = new Set([...src.matchAll(/result: "([a-z-]+)"/g)].map((m) => m[1]));
  // outcomes surfaced from the engine via the generic branch
  for (const r of ["judged", "already-judged", "not-ours", "not-submitted", "abstained", "retry-later", "submission-not-found", "skipped", "pending", "expired"]) results.add(r);
  for (const r of results) assert.ok(INTEGRATION_MD.includes("`" + r + "`"), `result ${r} is not documented`);
});

test("the agent skill is well-formed and points at the real kit and API", () => {
  const fm = SKILL_MD.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, "SKILL.md needs YAML frontmatter");
  assert.match(fm[1], /^name: judge-protocol$/m);
  const desc = (fm[1].match(/^description: (.+)$/m) || [])[1] || "";
  assert.ok(desc.length > 40 && desc.length <= 1024, "description length");
  for (const fn of ["createJudgedJob", "setBudget", "fundJob", "submitDeliverable", "requestRuling", "waitForRuling", "dryRun"]) {
    assert.ok(SKILL_MD.includes(fn), fn);
    assert.equal(typeof kit[fn], "function", `${fn} is not exported by the kit`);
  }
  for (const v of [kit.ARC_TESTNET.acp, kit.ARC_TESTNET.judge, kit.ARC_TESTNET.api]) assert.ok(SKILL_MD.includes(v), v);
  assert.match(SKILL_MD, /never (claim|say|report)[^.]*verified/i, "the skill must forbid claiming verification without the verifier");
});
