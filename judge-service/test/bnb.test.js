// The BNB adapter: rulings for jobs on bnbagent-sdk's kernel that settle through JudgeRouter and
// JudgeDeterministicPolicy. The manifest hash is held to Python's json.dumps(sort_keys, compact, ensure_ascii) by a
// vector computed with Python; the signed evidence is held to the Solidity policy by the vector in
// contracts/test/JudgeDeterministicPolicy.t.sol (test_aVerdictSignedByTheServiceIsAccepted).
import test from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, parseAbi, recoverTypedDataAddress, stringToHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson, manifestHash, manifestCore, criteriaFromBnbDescription, deliverableUrlFromOptParams, ruleOnBnbJob,
  signBnbEvidence, policyDomain, readBnbJob, runCli } from "../src/bnb.js";
import { VERDICT_TYPES } from "../src/signer.js";

const ROUTER = "0x522B3294E6d06aA25Ad0f1B8891242E335D3B459";
const POLICY = "0x535B3D7A252fa034Ed71F0C53ec0C6F784cB64E1";
const KERNEL = "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de";
const TRICKY = { version: 1, job_id: 42, chain_id: 97, contracts: { commerce: KERNEL, router: ROUTER, policy: POLICY },
  response: { content: "Résumé ✓ deterministic 日本 🚀 \u007f tab\tend", content_type: "text/plain" },
  metadata: { b: [1, 2, { z: null, a: true }], a: "x" } };

test("canonical JSON and the manifest hash match Python's json.dumps(sort_keys=True, separators, ensure_ascii)", () => {
  // Computed with Python 3: json.dumps(m, sort_keys=True, separators=(",", ":")) then keccak256 of its bytes.
  assert.equal(canonicalJson(TRICKY),
    '{"chain_id":97,"contracts":{"commerce":"0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de","policy":"0x535B3D7A252fa034Ed71F0C53ec0C6F784cB64E1","router":"0x522B3294E6d06aA25Ad0f1B8891242E335D3B459"},"job_id":42,"metadata":{"a":"x","b":[1,2,{"a":true,"z":null}]},"response":{"content":"R\\u00e9sum\\u00e9 \\u2713 deterministic \\u65e5\\u672c \\ud83d\\ude80 \\u007f tab\\tend","content_type":"text/plain"},"version":1}');
  assert.equal(manifestHash(TRICKY), "0x23fee40fb28c264b6e673cf470b16e4b1fdd693bcc87bb837c30f96228a087d1");
  assert.throws(() => canonicalJson({ x: Infinity }), /non-finite/);
});

test("the manifest hash covers exactly the SDK's fields: extra wire keys are ignored, a missing metadata is {}", () => {
  const withExtra = { ...TRICKY, served_by: "some gateway" };
  assert.equal(manifestHash(withExtra), manifestHash(TRICKY));
  const { metadata, ...noMeta } = TRICKY;
  assert.equal(manifestHash(noMeta), manifestHash({ ...TRICKY, metadata: {} }));
  const noType = { ...TRICKY, response: { content: TRICKY.response.content } };
  assert.notEqual(manifestHash(noType), manifestHash(TRICKY), "content_type is hashed only when present, as the SDK does");
  assert.throws(() => manifestCore({ ...TRICKY, version: 2 }), /unsupported manifest version/);
  assert.throws(() => manifestCore({ ...TRICKY, response: {} }), /response.content/);
});

const BLOCK = '```judge-criteria\n{"version":1,"passThreshold":100,"checks":[{"kind":"contains","params":{"all":["swap"]},"weight":1},{"kind":"length","params":{"min":3,"max":500},"weight":1}]}\n```';
const DESCRIPTION = JSON.stringify({ version: 1, negotiated_at: 1792000000, task: `Write a swap summary.\n${BLOCK}`,
  terms: { deliverables: "a summary", quality_standards: "plain text" }, price: "5000000", currency: "0x00" });

test("criteria come from the one judge-criteria block in a JobDescription's task or terms, or in plain text", () => {
  assert.equal(criteriaFromBnbDescription(DESCRIPTION).criteria.checks.length, 2);
  const inTerms = JSON.stringify({ version: 1, task: "t", terms: { success_criteria: BLOCK } });
  assert.equal(criteriaFromBnbDescription(inTerms).criteria.passThreshold, 100);
  assert.equal(criteriaFromBnbDescription(`plain text job\n${BLOCK}`).criteria.version, 1);
  assert.match(criteriaFromBnbDescription(JSON.stringify({ version: 1, task: "no block", terms: {} })).error, /no judge-criteria/);
  const two = JSON.stringify({ version: 1, task: BLOCK, terms: { success_criteria: BLOCK } });
  assert.match(criteriaFromBnbDescription(two).error, /more than one/);
  assert.match(criteriaFromBnbDescription("```judge-criteria\n{\"version\":1"). error, /not closed/);
});

test("the deliverable URL is read only from the SDK's {deliverable_url} optParams, and only https", () => {
  assert.equal(deliverableUrlFromOptParams(stringToHex('{"deliverable_url":"https://p.example/m.json"}')), "https://p.example/m.json");
  assert.equal(deliverableUrlFromOptParams(stringToHex('{"deliverable_url":"http://10.0.0.1/m.json"}')), null);
  assert.equal(deliverableUrlFromOptParams(stringToHex("not json")), null);
  assert.equal(deliverableUrlFromOptParams("0x"), null);
});

function manifestFor(jobId, content, chainId = 97) {
  return { version: 1, job_id: jobId, chain_id: chainId, contracts: { commerce: KERNEL, router: ROUTER, policy: POLICY },
    response: { content, content_type: "text/plain" }, metadata: {} };
}
function jobFor(jobId, m, over = {}) {
  return { id: BigInt(jobId), client: "0x" + "11".repeat(20), provider: "0x" + "22".repeat(20), evaluator: ROUTER, description: DESCRIPTION,
    budget: 5000000n, expiredAt: 1800000000n, status: 2, hook: ROUTER, submittedAt: 1792000100n, deliverable: manifestHash(m), ...over };
}
const bytesOf = (m) => new TextEncoder().encode(JSON.stringify(m));

test("a submitted job with a matching manifest is ruled on its content; the verdict binds the kernel's deliverable", async () => {
  const m = manifestFor(7, "the swap filled at the quoted price");
  const r = await ruleOnBnbJob({ chainId: 97, jobId: 7, job: jobFor(7, m), router: ROUTER, policy: POLICY, boundPolicy: POLICY,
    manifestBytes: bytesOf(m), timestamp: 1792000200 });
  assert.equal(r.status, "ruled", r.reason);
  assert.equal(r.verdict.deliverable, manifestHash(m), "what the policy compares with the kernel's record");
  assert.equal(r.verdict.score, 100);
  assert.equal(r.verdict.pass, true);
  assert.equal(r.verdict.jobId, 7n);
  assert.equal(r.verdict.timestamp, 1792000200n);
  assert.equal(r.ruling.contentKeccak, keccak256(toHex("the swap filled at the quoted price")));

  const fail = manifestFor(7, "no keyword here");
  const rf = await ruleOnBnbJob({ chainId: 97, jobId: 7, job: jobFor(7, fail), router: ROUTER, policy: POLICY, boundPolicy: POLICY, manifestBytes: bytesOf(fail) });
  assert.equal(rf.status, "ruled");
  assert.equal(rf.verdict.pass, false);
  assert.equal(rf.verdict.score, 50);
});

test("every broken link means no ruling, never a ruling on other content", async () => {
  const m = manifestFor(7, "the swap filled");
  const base = { chainId: 97, jobId: 7, job: jobFor(7, m), router: ROUTER, policy: POLICY, boundPolicy: POLICY, manifestBytes: bytesOf(m) };
  const cases = [
    [{ manifestBytes: bytesOf(manifestFor(7, "other content")) }, /does not hash/],
    [{ job: jobFor(7, m, { status: 1 }) }, /Funded, not Submitted/],
    [{ job: jobFor(7, m, { evaluator: POLICY }) }, /evaluator and hook/],
    [{ job: jobFor(7, m, { hook: POLICY }) }, /evaluator and hook/],
    [{ boundPolicy: "0x" + "00".repeat(20) }, /not bound this job/],
    [{ manifestBytes: undefined }, /manifest is missing/],
    [{ manifestBytes: new TextEncoder().encode("{not json") }, /not a valid bnbagent manifest/],
    [{ job: jobFor(8, m), jobId: 7 }, /no such job/],
    [{ jobId: "x" }, /positive integer/],
  ];
  for (const [over, re] of cases) {
    const r = await ruleOnBnbJob({ ...base, ...over });
    assert.equal(r.status, "abstained", Object.keys(over).join(","));
    assert.match(r.reason, re);
  }
  const otherJob = manifestFor(9, "the swap filled");
  const r = await ruleOnBnbJob({ ...base, job: jobFor(7, otherJob), manifestBytes: bytesOf(otherJob) });
  assert.match(r.reason, /another job or chain/, "a manifest for job 9 cannot settle job 7 even if the kernel holds its hash");
  const otherChain = manifestFor(7, "the swap filled", 56);
  const rc = await ruleOnBnbJob({ ...base, job: jobFor(7, otherChain), manifestBytes: bytesOf(otherChain) });
  assert.match(rc.reason, /another job or chain/);
  const noBlock = await ruleOnBnbJob({ ...base, job: jobFor(7, m, { description: JSON.stringify({ version: 1, task: "x", terms: {} }) }) });
  assert.match(noBlock.reason, /no judge-criteria/);
});

// The fixed vector the Solidity test checks: same key, chain, policy address and verdict.
export const VECTOR_KEY = "0x00000000000000000000000000000000000000000000000000000000000a11ce";
export const VECTOR_POLICY = "0x00000000000000000000000000000000b0bab0ba";
export const VECTOR_EVIDENCE = "0x00000000000000000000000000000000000000000000000000000000000000078d154dad9b173273bd6a06953e52255c46c505eb740d5d3123ed996d82b23621cf872d830abc1cfdaf207b6054b9e503120d894a37b2c51253eb5f74c9315ee000000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000114030b16b9d0817ea21580d216efab41b25e0b356bd4c3d2b8d5da1b909ce82e000000000000000000000000000000000000000000000000000000006acfc0c8000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000412e614201a4a7e813cb1d834d099cceaf1f46803072e96b86442a0d5cba26d7da6b4a1324366f99bbc878366e063a0acba94566065095a0b2cb3a15def009e8991c00000000000000000000000000000000000000000000000000000000000000";
export const VECTOR = { jobId: 7n, criteriaHash: keccak256(toHex("criteria-json-v1")), deliverable: keccak256(toHex("manifest-canonical-json")),
  score: 100, threshold: 100, pass: true, evidenceHash: keccak256(toHex("verdict-core-json")), timestamp: 1792000200n };

test("signed evidence decodes to the verdict and recovers the signer under the policy's domain only", async () => {
  const account = privateKeyToAccount(VECTOR_KEY);
  const { evidence, signature } = await signBnbEvidence(account, { chainId: 97, policy: VECTOR_POLICY, verdict: VECTOR });
  const [v, sig] = decodeAbiParameters([{ type: "tuple", components: VERDICT_TYPES.Verdict }, { type: "bytes" }], evidence);
  assert.deepEqual(v, VECTOR);
  assert.equal(sig, signature);
  const signer = await recoverTypedDataAddress({ domain: policyDomain(97, VECTOR_POLICY), types: VERDICT_TYPES, primaryType: "Verdict", message: VECTOR, signature });
  assert.equal(signer, account.address);
  const elsewhere = await recoverTypedDataAddress({ domain: policyDomain(56, VECTOR_POLICY), types: VERDICT_TYPES, primaryType: "Verdict", message: VECTOR, signature });
  assert.notEqual(elsewhere, account.address, "a testnet signature is not a mainnet one");
  // The digest and evidence the Solidity test pins (test_aVerdictSignedByTheServiceIsAccepted).
  assert.equal(hashTypedData({ domain: policyDomain(97, VECTOR_POLICY), types: VERDICT_TYPES, primaryType: "Verdict", message: VECTOR }),
    "0x35ec0de757c820d90c27689493e87f9d356eb4353516b69a1042f1fda0c81b48");
  assert.equal(account.address, "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7");
  assert.equal(evidence, VECTOR_EVIDENCE);
});

test("the CLI reads the job, the bound policy and the submit tx's URL from chain, then rules and signs", async () => {
  const m = manifestFor(7, "the swap filled at the quoted price");
  const job = jobFor(7, m);
  const submitData = encodeFunctionData({ abi: parseAbi(["function submit(uint256,bytes32,bytes)"]), functionName: "submit",
    args: [7n, job.deliverable, stringToHex('{"deliverable_url":"https://p.example/m.json"}')] });
  const client = {
    async readContract({ functionName }) { return functionName === "getJob" ? job : POLICY; },
    async getBlockNumber() { return 1000n; },
    async getLogs() { return [{ transactionHash: "0x" + "ab".repeat(32) }]; },
    async getTransaction() { return { input: submitData }; },
  };
  const seen = await readBnbJob(client, { kernel: KERNEL, router: ROUTER }, 7);
  assert.equal(seen.url, "https://p.example/m.json");
  const r = await runCli(["7", "--network", "bsc-testnet", "--router", ROUTER, "--policy", POLICY, "--manifest", "/dev/null"],
    { makeClient: () => client, signerKey: VECTOR_KEY, now: () => 1792000200 });
  assert.equal(r.status, "abstained", "an empty manifest file is not a manifest");
  const usage = await runCli(["7"], { makeClient: () => client });
  assert.match(usage.reason, /--router and --policy/);
});
