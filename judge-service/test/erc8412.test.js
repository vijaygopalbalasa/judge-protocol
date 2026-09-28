// ERC-8412 (Preregistered Acceptance Criteria) profile for Judge Protocol.
//
// Two things are pinned here. First, interoperability with the ERC's own
// reference implementation: our canonical JSON reproduces its digest for every
// document in its 23 packages, our independent checker reports exactly the
// violations each package expects, and the packages we emit pass the reference
// verifier itself. Second, the profile: a Judge verdict becomes criteria,
// evidence and attestation documents whose decision rule gives the judge's
// answer for EVERY combination of check outcomes, so no verdict the judge signs
// can be refuted, and a tampered package is.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const E = await import("../src/erc8412.js");
const { scoreOf } = await import("../src/checkers/index.js");
const { criteriaHash } = await import("../src/criteria.js");

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "erc8412");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));
const packages = fs.readdirSync(path.join(FX, "offchain")).filter((f) => f.endsWith(".json")).sort()
  .map((f) => { const c = load(`offchain/${f}`); return Array.isArray(c) ? c[0] : c; });
const clone = (o) => JSON.parse(JSON.stringify(o));
const rules = (r) => [...new Set(r.violations.map((v) => v.rule))].sort();

/* ------------------------- the reference vectors -------------------------- */

test("our canonical JSON reproduces the reference digest of every document in the ERC's 23 packages", () => {
  const ref = load("reference-digests.json");
  assert.equal(packages.length, 23);
  for (const p of packages) {
    for (const k of ["criteria", "bundle", "attestation"]) assert.equal(E.docDigest(p[k]), ref[p.name][k], `${p.name}.${k}`);
  }
});

test("JCS: keys sorted by UTF-16 code units, no whitespace, integers only", () => {
  assert.equal(E.jcs({ b: 1, a: [true, null, "x\u0001"], "é": "ü", "\u{1F600}": 3, "€": 2 }),
    '{"a":[true,null,"x\\u0001"],"b":1,"é":"ü","€":2,"\u{1F600}":3}');
  for (const bad of [1.5, NaN, Infinity, { w: 0.25 }, [undefined]]) assert.throws(() => E.jcs(bad), /integer|not allowed/, String(bad));
});

test("packed encodings: two bits per obligation, most significant first, zero padded", () => {
  assert.equal(E.pack([1, 3, 0]), "0x70");
  assert.equal(E.pack([1, 2, 0]), "0x60");
  assert.equal(E.pack([1, 1, 1, 1, 1]), "0x5540");
  assert.equal(E.pack([]), "0x");
  assert.deepEqual(E.unpack("0x60", 3), [1, 2, 0]);
  for (const p of packages.filter((x) => !x.expect.violations.includes("O5"))) {
    assert.equal(E.flagsOf(p.criteria.obligations), p.chain.obligationFlags.toLowerCase(), p.name);
  }
});

test("preregistrationId follows the reference formula case", () => {
  const [idCase] = load("onchain-ID.json");
  const meta = load("onchain-meta.json");
  const { args, expect } = idCase.steps[0];
  assert.equal(E.preregistrationIdOf({ chainId: meta.chainId, registry: meta.registry, author: meta.actors.author,
    criteriaDigest: args.criteriaDigest, taskRef: args.taskRef }), expect.preregistrationId);
});

test("an independent checker reports exactly the violations every reference package expects", async () => {
  for (const p of packages) {
    const r = await E.checkPackage(p);
    assert.deepEqual(rules(r), p.expect.violations, `${p.name}: ${JSON.stringify(r.violations)}`);
    assert.equal(r.valid, p.expect.valid, p.name);
  }
  const custom = await E.checkPackage(packages.find((p) => p.name === "valid-custom-rule"));
  assert.match(custom.unchecked.join(" "), /O4/, "someone else's custom rule is unchecked, never passed");
});

/* ------------------------------ the profile ------------------------------- */

const VERIFIER = "0x9F225e1f21ec382CaC048091B8fE1e0fd7311ad8";
const CTX = { chainId: 5042002, acp: "0x0747EEf0706327138c69792bF28Cd525089e4583", jobId: 186777n, verifier: VERIFIER, expiry: 1790003600 };
const REG = { registry: "0x8412000000000000000000000000000000008412", author: "0x96f2Cd020d378362228253F7fE82c35EfE73E149", registeredAt: 1790000000 };
const CRIT = { version: 1, passThreshold: 100, checks: [
  { kind: "length", params: { min: 10, max: 5000 } },
  { kind: "contains", params: { all: ["ERC-8183", "USDC"] }, weight: 1 },
  { kind: "http-endpoint", params: { url: "https://example.com/health" }, weight: 2 },
] };
const DELIVERABLE = { digest: "0x" + "ab".repeat(32), uri: "data:text/plain;base64,SGVsbG8=", submittedAt: 1790000100 };
const results = (passes) => passes.map((pass, i) => ({ kind: CRIT.checks[i].kind, weight: CRIT.checks[i].weight ?? 1, pass, detail: pass ? "ok" : "no" }));

function pkg(passes, over = {}) {
  const res = results(passes);
  const { pass } = scoreOf(res, CRIT.passThreshold);
  return E.packageFor({ criteria: CRIT, ...CTX, ...REG, deliverable: DELIVERABLE, results: res, pass,
    judgedAt: 1790000200, attestedAt: 1790000300, ...over });
}

test("a Judge job becomes a criteria document: one typed obligation per check, in order", () => {
  const c = E.criteriaDocument(CRIT, CTX);
  assert.equal(c.doc.version, "1");
  assert.equal(c.doc.decisionRule, "ALL_REQUIRED", "a threshold of 100 needs every check");
  assert.deepEqual(c.doc.obligations.map((o) => [o.index, o.type, o.required, o.waivable]),
    [[0, "DOCUMENT", true, false], [1, "DOCUMENT", true, false], [2, "AGENT_LOG", true, false]]);
  assert.equal(c.doc.obligations[0].constraints.mediaType, "application/octet-stream");
  assert.deepEqual(c.doc.obligations[0].constraints[`${E.NS}.check`], CRIT.checks[0], "the check exactly as the client wrote it");
  assert.equal(c.doc.obligations[2].constraints.agentBinding, VERIFIER, "a live probe is the judge's own record");
  assert.equal(c.doc.taskRef, E.taskRefOf(CTX));
  assert.equal(c.doc[`${E.NS}.criteriaHash`], criteriaHash(CRIT), "binds the hash the on-chain Judge verdict commits to");
  assert.equal(c.doc.verifier, VERIFIER);
  assert.equal(c.doc.expiry, CTX.expiry);
  assert.equal(c.doc.supersedes, null);
  assert.equal(c.doc.waiverAuthority, null, "nothing is waivable");
  assert.equal(c.doc.terminalOnExpiry, "REFUND_WITH_RECORD", "an ERC-8183 job the judge never rules is refunded at expiry");
  assert.equal(c.obligationFlags, "0x54");
  assert.equal(c.criteriaDigest, E.docDigest(c.doc));
});

test("the decision rule gives the judge's answer for every combination of outcomes (400 random criteria)", () => {
  let seed = 8412;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const seen = {};
  for (let t = 0; t < 400; t++) {
    const n = 1 + Math.floor(rnd() * 6);
    const weights = Array.from({ length: n }, () => (rnd() < 0.5 ? 1 : 1 + Math.floor(rnd() * 9)));
    const threshold = [0, 1, 25, 34, 50, 51, 66, 67, 75, 99, 100][Math.floor(rnd() * 11)];
    const criteria = { version: 1, passThreshold: threshold, checks: weights.map((weight) => ({ kind: "length", params: {}, weight })) };
    const { doc } = E.criteriaDocument(criteria, CTX);
    const kind = doc.decisionRule.startsWith("ALL_REQUIRED_AND") ? "atLeast" : doc.decisionRule === "ALL_REQUIRED" ? "all" : "weighted";
    seen[kind] = (seen[kind] ?? 0) + 1;
    for (let mask = 0; mask < 1 << n; mask++) {
      const passes = weights.map((_, i) => !!(mask & (1 << i)));
      const judge = scoreOf(passes.map((pass, i) => ({ pass, weight: weights[i] })), threshold).pass;
      const why = `weights ${weights} threshold ${threshold} rule ${doc.decisionRule} outcomes ${passes}`;
      assert.equal(E.applyRule(doc, passes.map((p) => (p ? "MET" : "UNMET"))), judge ? "Satisfied" : "NotSatisfied", why);
      if (judge) assert.ok(doc.obligations.every((o, i) => !o.required || passes[i]), `E4: ${why}`);
      else assert.ok(passes.some((p) => !p), `E11: ${why}`);
    }
  }
  for (const k of ["all", "atLeast", "weighted"]) assert.ok(seen[k] > 20, `exercised ${k}: ${JSON.stringify(seen)}`);
});

test("standard rules wherever they are exact; the weighted rule only when nothing standard fits", () => {
  const doc = (weights, t) => E.criteriaDocument({ version: 1, passThreshold: t,
    checks: weights.map((weight) => ({ kind: "contains", params: { all: ["x"] }, weight })) }, CTX).doc;
  const docExample = doc([2, 1], 67); // CRITERIA.md: the light check may fail
  assert.equal(docExample.decisionRule, "ALL_REQUIRED");
  assert.deepEqual(docExample.obligations.map((o) => o.required), [true, false]);
  const half = doc([1, 1, 1, 1], 50);
  assert.equal(half.decisionRule, "ALL_REQUIRED_AND_AT_LEAST(2)");
  assert.deepEqual(half.obligations.map((o) => o.required), [false, false, false, false]);
  const weighted = doc([3, 2, 1], 50);
  assert.equal(weighted.decisionRule, E.WEIGHTED_RULE);
  assert.equal(weighted[`${E.NS}.passThreshold`], 50, "the rule's inputs are in the document");
});

test("criteria with a non-integer number are refused: ERC-8412 documents carry integers only", () => {
  const half = { version: 1, checks: [{ kind: "length", params: { min: 1 }, weight: 0.5 }] };
  assert.throws(() => E.criteriaDocument(half, CTX), (e) => e instanceof E.ProfileError && /integer/.test(e.message));
  const invalid = { version: 1, checks: [] };
  assert.throws(() => E.criteriaDocument(invalid, CTX), (e) => e instanceof E.ProfileError && /invalid criteria/.test(e.message));
});

test("a passing and a failing verdict each become a package that is valid on every rule", async () => {
  for (const [passes, verdict, outcomes] of [[[true, true, true], "Satisfied", "0x54"], [[true, false, true], "NotSatisfied", "0x44"]]) {
    const p = pkg(passes);
    assert.equal(p.attestation.verdict, verdict);
    assert.equal(p.attestation.obligationOutcomes, outcomes);
    assert.deepEqual(p.attestation.undecided, []);
    assert.deepEqual(p.attestation.waivers, []);
    assert.equal(p.chain.attestation.verdict, verdict);
    assert.equal(p.chain.preregistrationId, E.preregistrationIdOf({ chainId: CTX.chainId, ...REG, criteriaDigest: p.chain.criteriaDigest, taskRef: p.chain.taskRef }));
    assert.ok(p.bundle.items.every((it) => it.preregistrationId === p.chain.preregistrationId && it.captureMetadata.timestamp >= REG.registeredAt));
    assert.equal(p.bundle.items[0].digest, DELIVERABLE.digest, "the evidence is the provider's committed deliverable");
    const r = await E.checkPackage(p);
    assert.deepEqual(r.violations, [], JSON.stringify(r.violations));
    assert.deepEqual(r.unchecked, []);
  }
});

test("a verdict that contradicts its own documents is refused, never attested", () => {
  const res = results([true, false, true]);
  assert.throws(() => E.packageFor({ criteria: CRIT, ...CTX, ...REG, deliverable: DELIVERABLE, results: res, pass: true,
    judgedAt: 1790000200, attestedAt: 1790000300 }), (e) => e instanceof E.ProfileError && /contradicts/.test(e.message));
});

test("tampering with a published package is caught, on the rule that names it", async () => {
  const rehash = (p) => {
    p.attestation.bundleDigest = p.chain.attestation.bundleDigest = E.docDigest(p.bundle);
    p.chain.attestation.attestationDigest = E.docDigest(p.attestation);
    return p;
  };
  const cases = [];
  { const p = clone(pkg([true, false, true])); // claim a pass over a failed check
    p.attestation.verdict = p.chain.attestation.verdict = "Satisfied"; rehash(p); cases.push(["O4", p]); }
  { const p = clone(pkg([true, true, true])); // evidence older than the criteria
    p.bundle.items[0].captureMetadata.timestamp = REG.registeredAt - 1; rehash(p); cases.push(["O1", p]); }
  { const p = clone(pkg([true, true, true])); // a MET obligation with no evidence
    p.bundle.items = p.bundle.items.filter((it) => it.obligationIndex !== 1); rehash(p); cases.push(["O2", p]); }
  { const p = clone(pkg([true, true, true])); // criteria edited after registration
    p.criteria.obligations[1].constraints[`${E.NS}.check`].params.all = ["ERC-8183"]; cases.push(["O5", p]); }
  for (const [rule, p] of cases) assert.ok(rules(await E.checkPackage(p)).includes(rule), `${rule} expected`);
});

test("the ERC's own reference verifier accepts the packages we emit", { skip: spawnSync("python3", ["--version"]).status !== 0 && "python3 not available" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erc8412-"));
  const weighted = { version: 1, passThreshold: 50, checks: [3, 2, 1].map((weight) => ({ kind: "contains", params: { all: ["x"] }, weight })) };
  const wres = [true, false, false].map((pass, i) => ({ kind: "contains", weight: weighted.checks[i].weight, pass, detail: "" }));
  const all = [pkg([true, true, true]), pkg([true, false, true]),
    E.packageFor({ criteria: weighted, ...CTX, ...REG, deliverable: DELIVERABLE, results: wres, pass: scoreOf(wres, 50).pass, judgedAt: 1790000200, attestedAt: 1790000300 })];
  for (const [i, p] of all.entries()) {
    const f = path.join(dir, `p${i}.json`);
    fs.writeFileSync(f, JSON.stringify({ name: `judge-${i}`, ...p }));
    const out = spawnSync("python3", [path.join(FX, "reference", "verifier", "verify.py"), f], { encoding: "utf8" });
    const r = JSON.parse(out.stdout);
    assert.equal(r.valid, true, `package ${i}: ${out.stdout}${out.stderr}`);
  }
});

test("the live Arc testnet packages verify against the chain state they recorded", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "erc8412");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.length >= 2, "a passing and a failing ruling");
  const python = spawnSync("python3", ["--version"]).status === 0;
  const verdicts = new Set();
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const r = await E.checkPackage(p);
    assert.deepEqual([r.violations, r.unchecked], [[], []], f);
    assert.equal(p.chain.chainId, 5042002);
    assert.equal(p.criteria[`${E.NS}.criteriaHash`], criteriaHash({ version: 1, jobType: "doc", passThreshold: 100,
      checks: p.criteria.obligations.map((o) => o.constraints[`${E.NS}.check`]) }), `${f}: the Judge criteria behind the document`);
    verdicts.add(p.chain.attestation.verdict);
    if (python) {
      const out = spawnSync("python3", [path.join(FX, "reference", "verifier", "verify.py"), path.join(dir, f)], { encoding: "utf8" });
      assert.equal(JSON.parse(out.stdout).valid, true, `${f}: ${out.stdout}${out.stderr}`);
    }
  }
  assert.deepEqual([...verdicts].sort(), ["NotSatisfied", "Satisfied"]);
});

test("the __proto__ vector added in review (valid-proto-member) is valid for our port, and bites an assignment copy", async () => {
  // Proposed for the ERC's vectors in richard7463/ERCs#1 (commit 02aaae3) after we reported the
  // hazard: criteria carrying an ordinary member named __proto__, which JCS hashes like any key.
  const raw = load("proposed/valid-proto-member.json");
  const p = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(Object.hasOwn(p.criteria, "__proto__"), "JSON.parse keeps the member");
  const r = await E.checkPackage(p);
  assert.deepEqual({ valid: r.valid, violations: r.violations, unchecked: r.unchecked }, { valid: true, violations: [], unchecked: [] });
  assert.equal(E.docDigest(p.criteria), p.chain.criteriaDigest.toLowerCase());
  assert.notEqual(E.docDigest(Object.assign({}, p.criteria)), p.chain.criteriaDigest.toLowerCase(), "an assignment copy drops it");
});
