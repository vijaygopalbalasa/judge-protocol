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
  contains: ["all", "wholeWords"],
  schema: ["required", "types"],
  checksum: ["sha256"],
  "http-endpoint": ["url", "expectStatus", "bodyIncludes", "timeoutMs"],
  json: ["shape"],
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
  for (const e of ["POST /api/judge", "GET /api/judge?jobId=", "POST /api/evaluate", "GET /api/health", "submitTx", "POST /api/x402/judge"]) assert.ok(INTEGRATION_MD.includes(e), e);
});

test("the paid path is documented with the terms the code actually charges", async () => {
  const x = await import("../../judge-service/src/x402.js");
  for (const v of [x.PRICE_LABEL, x.ARC_TESTNET_NETWORK, "Circle Gateway", "payment-signature", "PAYMENT-REQUIRED", "PAYMENT-RESPONSE"]) {
    assert.ok(INTEGRATION_MD.includes(v), `INTEGRATION.md must mention ${v}`);
  }
  assert.match(INTEGRATION_MD, /settles your payment\s+only when a verdict is ready/i, "the settle-before-sign rule must be stated");
  assert.match(INTEGRATION_MD, /before it signs anything/i);
  assert.match(INTEGRATION_MD, /not the amount your client signed/i, "clients must be told what proves a charge");
  assert.doesNotMatch(INTEGRATION_MD, /charged only when a verdict lands/i, "the old promise is gone");
  for (const f of ["README.md", "judge-service/public/index.html", "judge-service/api/x402/judge.js", "judge-service/src/x402.js", "skills/judge-protocol/SKILL.md"]) {
    assert.doesNotMatch(read(f), /charged only when a verdict lands|verdict lands on chain\)/i, `${f} still makes the old promise`);
  }
  assert.match(INTEGRATION_MD, /free[^.]*POST \/api\/judge/i, "the free path must stay documented");
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
  assert.match(SKILL_MD, /wholeWords/, "the skill must teach whole-word terms");
  assert.ok(SKILL_MD.includes("POST /api/x402/judge"), "the skill must mention the paid path");
  assert.match(SKILL_MD, /trust `charged`/i, "the skill must say what proves a charge");
});

test("CRITERIA.md states every bound the judge enforces, with the code's own numbers", async () => {
  const { LIMITS } = await import("../../judge-service/src/checkers/index.js");
  for (const phrase of [`at most ${LIMITS.checks} checks`, `at most ${LIMITS.probes} \`http-endpoint\` checks`,
    `deeper than ${LIMITS.depth} levels`, `up to ${LIMITS.terms}`, `${LIMITS.termChars} characters`, `${LIMITS.urlChars} characters`,
    `1 to ${LIMITS.probeTimeoutMs}`, "not a JSON object"]) {
    assert.ok(CRITERIA_MD.includes(phrase), `CRITERIA.md must say: ${phrase}`);
  }
});

test("the ERC-8004 registration (agent 870004's live profile) matches what the service offers", () => {
  const reg = JSON.parse(read("docs/agent-registration.json"));
  assert.equal(reg.x402Support, true, "paid rulings over x402 are live");
  const endpoints = reg.services.map((s) => s.endpoint);
  for (const u of [kit.ARC_TESTNET.api, kit.ARC_TESTNET.verifier, `${kit.ARC_TESTNET.api}/api/x402/judge`]) assert.ok(endpoints.includes(u), u);
  assert.match(reg.description, /testnet/i);
  assert.match(reg.description, /no uptime guarantee/i);
  assert.ok(!JSON.stringify(reg).includes("\u2014"), "no em dashes");
  assert.equal(reg.registrations[0].agentId, 870004);
});

test("CRITERIA.md states the newer refusals: weight cap, unknown params, arrays, long strings", async () => {
  const { LIMITS } = await import("../../judge-service/src/checkers/index.js");
  assert.ok(CRITERIA_MD.includes(`at most ${LIMITS.weight}`), "weight cap");
  assert.match(CRITERIA_MD, /unknown param/i, "unknown params are refused");
  assert.match(CRITERIA_MD, /JSON array[^.]*fails/i, "a JSON array fails schema");
  assert.ok(CRITERIA_MD.includes(`\`bodyIncludes\` | list of up to ${LIMITS.terms} strings, each up to ${LIMITS.termChars} characters`), "bodyIncludes strings are capped");
  assert.ok(CRITERIA_MD.includes(`\`required\` | list of up to ${LIMITS.terms} field names, each up to ${LIMITS.termChars} characters`), "field names are capped");
  assert.match(CRITERIA_MD, /\\u0060/, "hand-written blocks: how to write a backtick");
  assert.match(CRITERIA_MD, /unknown field on a check/i, "misspelled check fields are refused");
  assert.match(CRITERIA_MD, /misspelled `passThreshold` is not caught/, "and top-level typos are not: say so");
  assert.match(CRITERIA_MD, /member named `__proto__`/, "criteria with a __proto__ member are refused");
  assert.match(CRITERIA_MD, /Unicode 17\.0\.0/, "word characters are pinned to one Unicode version, whatever the runtime ships");
});

test("INTEGRATION.md states the fetch limits with the code's own numbers, and how to recover", async () => {
  const { MAX_BYTES, FETCH_TIMEOUT_MS } = await import("../../judge-service/src/safe-fetch.js");
  const { MAX_DELIVERABLE_BYTES } = await import("../../judge-service/src/evaluate.js");
  assert.ok(INTEGRATION_MD.includes(`at most ${MAX_BYTES / 1_000_000} MB`), "deliverable size cap");
  assert.ok(INTEGRATION_MD.includes(`within ${FETCH_TIMEOUT_MS / 1000} seconds`), "fetch timeout");
  assert.ok(INTEGRATION_MD.includes(`at most ${MAX_DELIVERABLE_BYTES / 1024} KB`), "dry-run size cap");
  assert.match(INTEGRATION_MD, /no redirects/);
  assert.match(INTEGRATION_MD, /ask again for free with `POST \/api\/judge`/, "a paid ruling whose transaction failed is finished on the free path");
  assert.doesNotMatch(INTEGRATION_MD, /sweep (will )?settles?/i, "the sweep only covers ~2 days: no blanket promise");
  assert.match(INTEGRATION_MD, /Request failed with status/, "what Circle's pay() throws before paying");
  assert.match(INTEGRATION_MD, /Payment failed: <error>/, "and after paying");
  assert.match(INTEGRATION_MD, /not published to npm/);
});

test("the API landing page lists every status GET /api/judge can return", () => {
  const src = read("judge-service/src/judge-now.js");
  const row = read("judge-service/public/index.html").split("\n").find((l) => l.includes("GET /api/judge?jobId=N"));
  assert.ok(row, "the landing page documents GET /api/judge");
  for (const r of ["pending", "judged", "not-submitted", "expired", "closed", "not-ours", "not-found"]) {
    assert.ok(src.includes(`"${r}"`), `${r} is a real status`);
    assert.ok(row.includes(r), `the landing page's GET row must list ${r}`);
  }
});
