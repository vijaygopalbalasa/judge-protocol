// The integration kit other teams copy or install. Every helper must agree with
// the judge's own code (criteria validation, hashing, deliverable decoding), and
// nothing may reach the chain when the input is wrong.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { encodeEventTopics, encodeAbiParameters, keccak256, toHex } from "viem";

const kit = await import("../judge-kit.js");
const svcCheckers = await import("../../judge-service/src/checkers/index.js");
const svcCriteria = await import("../../judge-service/src/criteria.js");
const svcEngine = await import("../../judge-service/src/engine.js");
const svcEvidence = await import("../../judge-service/src/evidence.js");
const svcConfig = (await import("../../judge-service/src/config.js")).config;

const CRITERIA = { version: 1, passThreshold: 100, checks: [
  { kind: "length", params: { min: 10, max: 5000 } },
  { kind: "contains", params: { all: ["ERC-8183", "USDC"] }, weight: 2 },
] };
const TEXT = "This analysis covers ERC-8183 escrow mechanics and USDC settlement on Arc testnet in detail.";
const PROVIDER = "0x5e14c9E5278ee370D764d03d314e92B3d9fFC04F";

/* ------------------------------- parity ------------------------------------ */

test("addresses and endpoints match the judge service and the verifier (one source of truth)", () => {
  assert.equal(kit.ARC_TESTNET.acp, svcConfig.acpAddress);
  assert.equal(kit.ARC_TESTNET.judge, svcConfig.judgeAddress);
  assert.equal(kit.ARC_TESTNET.chainId, svcConfig.chain.id);
  const web = fs.readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  assert.ok(web.includes(kit.ARC_TESTNET.acp) && web.includes(kit.ARC_TESTNET.judge));
  assert.equal(kit.ARC_TESTNET.api, "https://judge-protocol-api.vercel.app");
});

test("criteria validation agrees with the judge on valid and invalid criteria", () => {
  const cases = [CRITERIA, null, {}, { checks: [] }, { checks: "x" }, { checks: [null] }, { checks: [{ kind: "code-test" }] },
    { checks: [{ kind: "length", weight: 0 }] }, { checks: [{ kind: "length", weight: -1 }] }, { checks: [{ kind: "length", weight: "2" }] },
    { passThreshold: 101, checks: [{ kind: "length" }] }, { passThreshold: -1, checks: [{ kind: "length" }] },
    { passThreshold: 99.5, checks: [{ kind: "length" }] }, { passThreshold: 0, checks: [{ kind: "contains", params: { all: [] } }] }];
  for (const c of cases) assert.equal(kit.validateCriteria(c).valid, svcCheckers.validateCriteria(c).valid, JSON.stringify(c));
});

test("criteriaHash matches the judge, independent of key order", () => {
  const reordered = { checks: CRITERIA.checks.map((c) => Object.fromEntries(Object.entries(c).reverse())), passThreshold: 100, version: 1 };
  for (const c of [CRITERIA, reordered]) assert.equal(kit.criteriaHash(c), svcCriteria.criteriaHash(c));
  assert.equal(kit.criteriaHash(CRITERIA), kit.criteriaHash(reordered));
});

test("criteriaBlock round-trips through the judge's own parser", () => {
  const desc = kit.criteriaBlock(CRITERIA, { title: "Write an ERC-8183 explainer." });
  assert.deepEqual(svcCriteria.extractCriteria(desc), CRITERIA);
  assert.match(desc, /^Write an ERC-8183 explainer\./);
});

test("criteriaBlock refuses criteria the judge would never score (false positives stop here)", () => {
  for (const bad of [{ checks: [] }, { checks: [{ kind: "vibes" }] }, { passThreshold: 101, checks: [{ kind: "length" }] }]) {
    assert.throws(() => kit.criteriaBlock(bad), /invalid criteria/);
  }
});

/* ---------------------------- deliverables --------------------------------- */

async function throughTheJudge(d, jobId = 1n) {
  // Build the provider's submit() tx exactly as the chain would carry it, then
  // decode it with the judge's own engine and evidence code.
  const { encodeFunctionData } = await import("viem");
  const input = encodeFunctionData({ abi: kit.ACP_ABI, functionName: "submit", args: [jobId, d.deliverableHash, d.optParams] });
  const publicClient = { getTransaction: async () => ({ input }) };
  const src = await svcEngine.resolveDeliverableSource(publicClient, "0x" + "ab".repeat(32), "no uri in description");
  const resolved = await svcEvidence.resolveDeliverable(src.uri);
  return { src, content: resolved.content };
}

test("a text deliverable decodes byte for byte through the judge, and its hash is the commitment", async () => {
  const d = kit.deliverable(TEXT);
  const { src, content } = await throughTheJudge(d);
  assert.equal(src.authoredBy, "provider");
  assert.equal(content.toString("utf8"), TEXT);
  assert.equal(keccak256(content), d.deliverableHash);
});

test("binary and unicode deliverables survive exactly", async () => {
  for (const c of [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]), "naïve café ☕ 60 words\r\nline two"]) {
    const d = kit.deliverable(c);
    const { content } = await throughTheJudge(d);
    const want = typeof c === "string" ? Buffer.from(c, "utf8") : Buffer.from(c);
    assert.equal(content.toString("hex"), want.toString("hex"));
    assert.equal(d.deliverableHash, keccak256(want));
  }
});

test("oversized or empty deliverables are refused before any transaction", () => {
  assert.throws(() => kit.deliverable(""), /empty/);
  assert.throws(() => kit.deliverable("x".repeat(kit.MAX_INLINE_BYTES + 1)), /too large/);
});

/* ------------------------- on-chain helpers (mocked) ------------------------ */

function mockWallet({ jobId = 777n } = {}) {
  const sent = [];
  const walletClient = { account: { address: "0xA3f1b2503838fc061af842eD2C719559E12ad973" },
    writeContract: async (req) => { sent.push(req); return keccak256(toHex(`tx-${sent.length}`)); } };
  const topics = encodeEventTopics({ abi: kit.ACP_ABI, eventName: "JobCreated", args: { jobId, client: walletClient.account.address, provider: PROVIDER } });
  const data = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [kit.ARC_TESTNET.judge, 9999999999n, "0x0000000000000000000000000000000000000000"]);
  const publicClient = { waitForTransactionReceipt: async () => ({ status: "success", logs: [{ address: kit.ARC_TESTNET.acp, topics, data }] }) };
  return { walletClient, publicClient, sent };
}

test("createJudgedJob names the judge as evaluator, commits the criteria, and returns the job id", async () => {
  const m = mockWallet();
  const r = await kit.createJudgedJob({ ...m, provider: PROVIDER, criteria: CRITERIA, title: "Explainer" });
  assert.equal(r.jobId, 777n);
  const [call] = m.sent;
  assert.equal(call.functionName, "createJob");
  assert.equal(call.address, kit.ARC_TESTNET.acp);
  const [prov, evaluator, expiredAt, description, hook] = call.args;
  assert.equal(prov, PROVIDER);
  assert.equal(evaluator, kit.ARC_TESTNET.judge);
  assert.ok(expiredAt > BigInt(Math.floor(Date.now() / 1000)) + 60n);
  assert.deepEqual(svcCriteria.extractCriteria(description), CRITERIA);
  assert.equal(hook, "0x0000000000000000000000000000000000000000");
});

test("createJudgedJob refuses bad input before sending anything", async () => {
  for (const bad of [
    { provider: PROVIDER, criteria: { checks: [] } },
    { provider: "0x0000000000000000000000000000000000000000", criteria: CRITERIA },
    { provider: "not-an-address", criteria: CRITERIA },
    { provider: PROVIDER, criteria: CRITERIA, expiresInSeconds: 30 },
  ]) {
    const m = mockWallet();
    await assert.rejects(() => kit.createJudgedJob({ ...m, ...bad }));
    assert.equal(m.sent.length, 0, JSON.stringify(bad));
  }
});

test("setBudget, fundJob and submitDeliverable send exactly the calls the ACP expects", async () => {
  const m = mockWallet();
  await kit.setBudget({ ...m, jobId: 5n, amount: 1_000_000n });
  await kit.fundJob({ ...m, jobId: 5n, amount: 1_000_000n });
  const s = await kit.submitDeliverable({ ...m, jobId: 5n, content: TEXT });
  assert.deepEqual(m.sent.map((c) => c.functionName), ["setBudget", "approve", "fund", "submit"]);
  assert.equal(m.sent[1].address, kit.ARC_TESTNET.usdc);
  assert.deepEqual(m.sent[1].args, [kit.ARC_TESTNET.acp, 1_000_000n]);
  assert.equal(m.sent[3].args[1], kit.deliverable(TEXT).deliverableHash);
  assert.match(s.txHash, /^0x[0-9a-f]{64}$/);
  await assert.rejects(() => kit.fundJob({ ...m, jobId: 5n, amount: 0n }), /amount/);
});

/* ------------------------------ API helpers -------------------------------- */

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test("requestRuling returns a ruling, retries a retry-later, and surfaces an abstention as an error", async () => {
  let n = 0;
  const flaky = async () => (++n === 1 ? reply(503, { result: "retry-later", reason: "host down" }) : reply(200, { result: "judged", pass: true, score: 100 }));
  const r = await kit.requestRuling({ jobId: 9n, submitTx: "0x" + "12".repeat(32), fetchImpl: flaky, retryDelayMs: 1 });
  assert.equal(r.result, "judged");
  assert.equal(n, 2);
  await assert.rejects(() => kit.requestRuling({ jobId: 9n, fetchImpl: async () => reply(422, { result: "abstained", reason: "invalid criteria: x" }) }), /abstained: invalid criteria/);
  await assert.rejects(() => kit.requestRuling({ jobId: "abc", fetchImpl: flaky }), /jobId/);
});

test("waitForRuling returns the verdict when judged, and fails on terminal states or timeout", async () => {
  let n = 0;
  const later = async () => (++n < 3 ? reply(200, { result: "pending" }) : reply(200, { result: "judged", verdict: { pass: false, score: 0 } }));
  const v = await kit.waitForRuling({ jobId: 9n, fetchImpl: later, intervalMs: 1 });
  assert.equal(v.verdict.pass, false);
  await assert.rejects(() => kit.waitForRuling({ jobId: 9n, fetchImpl: async () => reply(200, { result: "expired" }), intervalMs: 1 }), /expired/);
  await assert.rejects(() => kit.waitForRuling({ jobId: 9n, fetchImpl: async () => reply(200, { result: "pending" }), intervalMs: 1, timeoutMs: 20 }), /timed out/);
});

test("dryRun posts criteria and content to the evaluate endpoint", async () => {
  let seen;
  const r = await kit.dryRun({ criteria: CRITERIA, content: TEXT, fetchImpl: async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return reply(200, { pass: true }); } });
  assert.equal(r.pass, true);
  assert.equal(seen.url, "https://judge-protocol-api.vercel.app/api/evaluate");
  assert.deepEqual(seen.body.criteria, CRITERIA);
  assert.equal(Buffer.from(seen.body.deliverableBase64, "base64").toString(), TEXT);
});

test("the runnable example only uses functions the kit exports", () => {
  const src = fs.readFileSync(new URL("../example.js", import.meta.url), "utf8");
  const used = [...src.matchAll(/(?<![\w-])kit\.([a-zA-Z_]+)/g)].map((m) => m[1]);
  assert.ok(used.length >= 5, "the example should exercise the kit");
  for (const u of used) assert.ok(u in kit, `example uses kit.${u}, which the kit does not export`);
});
