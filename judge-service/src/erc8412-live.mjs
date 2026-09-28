#!/usr/bin/env node
// One ERC-8183 job on Arc testnet, end to end under the ERC-8412 profile
// (docs/ERC-8412.md), with real transactions at every step:
//   1. the client creates the job, criteria in the description, evaluator = JudgeEvaluator
//   2. the client preregisters the ERC-8412 criteria document, before any work exists
//   3. the provider sets the budget, the client funds it, the provider submits
//   4. the judge rules and settles the escrow (the same engine the live service runs)
//   5. the judge, as the ERC-8412 verifier, attests the itemized outcome
//   6. the chain state is read back from the registry and the package is checked and written
//
//   node --env-file=.env src/erc8412-live.mjs --registry <address> [--reject] [--out <file>]
//
// Needs CLIENT_KEY, PROVIDER_KEY and JUDGE_SIGNER_KEY (testnet keys).
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseUnits, stringToHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { extractCriteria } from "./criteria.js";
import { prepareRuling, settleRuling } from "./engine.js";
import { makeClients } from "./signer.js";
import { NS, ZERO32, attestationFor, checkPackage, criteriaDocument, evidenceBundle } from "./erc8412.js";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null; };
const registry = opt("--registry");
if (!/^0x[0-9a-fA-F]{40}$/.test(registry ?? "")) {
  console.error("usage: node --env-file=.env src/erc8412-live.mjs --registry <address> [--reject] [--out <file>]");
  process.exit(2);
}
const reject = argv.includes("--reject");

const USDC = "0x3600000000000000000000000000000000000000";
const ACP = [
  { name: "createJob", type: "function", stateMutability: "nonpayable", inputs: [{ name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "expiredAt", type: "uint256" }, { name: "description", type: "string" }, { name: "hook", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "setBudget", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "fund", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "submit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "deliverable", type: "bytes32" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "JobCreated", type: "event", anonymous: false, inputs: [{ indexed: true, name: "jobId", type: "uint256" }, { indexed: true, name: "client", type: "address" }, { indexed: true, name: "provider", type: "address" }, { indexed: false, name: "evaluator", type: "address" }, { indexed: false, name: "expiredAt", type: "uint256" }, { indexed: false, name: "hook", type: "address" }] },
];
const ERC20 = [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] }];
const REGISTRY = [
  { name: "preregister", type: "function", stateMutability: "nonpayable", inputs: [{ name: "criteriaDigest", type: "bytes32" }, { name: "taskRef", type: "bytes32" }, { name: "obligationCount", type: "uint16" }, { name: "obligationFlags", type: "bytes" }, { name: "expiry", type: "uint64" }, { name: "verifier", type: "address" }, { name: "supersedes", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { name: "attestOutcome", type: "function", stateMutability: "nonpayable", inputs: [{ name: "preregistrationId", type: "bytes32" }, { name: "bundleDigest", type: "bytes32" }, { name: "attestationDigest", type: "bytes32" }, { name: "verdict", type: "uint8" }, { name: "obligationOutcomes", type: "bytes" }], outputs: [] },
  { name: "getPreregistration", type: "function", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint16" }, { type: "bytes" }, { type: "uint64" }, { type: "uint64" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }] },
  { name: "getAttestation", type: "function", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes" }, { type: "uint64" }] },
  { name: "CriteriaPreregistered", type: "event", anonymous: false, inputs: [{ indexed: true, name: "preregistrationId", type: "bytes32" }, { indexed: true, name: "author", type: "address" }, { indexed: false, name: "criteriaDigest", type: "bytes32" }, { indexed: true, name: "taskRef", type: "bytes32" }, { indexed: false, name: "obligationCount", type: "uint16" }, { indexed: false, name: "obligationFlags", type: "bytes" }, { indexed: false, name: "expiry", type: "uint64" }, { indexed: false, name: "verifier", type: "address" }, { indexed: false, name: "supersedes", type: "bytes32" }] },
];
const VERDICTS = ["None", "Satisfied", "NotSatisfied", "Indeterminate", "ExpiredUnresolved"];

const pub = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
const wallet = (key) => createWalletClient({ account: privateKeyToAccount(key), chain: config.chain, transport: http(config.rpcUrl) });
const client = wallet(process.env.CLIENT_KEY);
const provider = wallet(process.env.PROVIDER_KEY);
const judge = wallet(process.env.JUDGE_SIGNER_KEY); // the ERC-8412 verifier: the key JudgeEvaluator trusts
const tx = {};
async function send(label, w, args) {
  const hash = await w.writeContract(args);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  tx[label] = hash;
  console.log(`   ${label.padEnd(12)} ${hash}`);
  return receipt;
}
const blockTime = async (receipt) => Number((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);

const criteria = { version: 1, jobType: "doc", passThreshold: 100, checks: [
  { kind: "length", params: { min: 10, max: 5000 } },
  { kind: "contains", params: { all: ["ERC-8183", "USDC"], wholeWords: true } },
] };
const description = ["Summarize ERC-8183 escrow on Arc. Judged under the ERC-8412 profile.", "```judge-criteria", JSON.stringify(criteria), "```"].join("\n");
const payload = reject
  ? "A short note that never names the escrow standard or the settlement token."
  : "ERC-8183 holds the client's USDC in escrow on Arc until the evaluator rules on the submitted work.";

console.log(`\nERC-8412 live run on chain ${config.chain.id} (${reject ? "a deliverable that fails a check" : "a deliverable that passes"})`);
console.log(`   registry ${registry}\n   verifier ${judge.account.address}\n`);

// 1. the job, with the criteria written into it
const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
const created = await send("createJob", client, { address: config.acpAddress, abi: ACP, functionName: "createJob",
  args: [provider.account.address, config.judgeAddress, expiredAt, description, "0x0000000000000000000000000000000000000000"] });
const jobId = created.logs.map((l) => { try { return decodeEventLog({ abi: ACP, data: l.data, topics: l.topics }); } catch { return null; } })
  .find((e) => e?.eventName === "JobCreated").args.jobId;
console.log(`   jobId        ${jobId}`);
if (JSON.stringify(extractCriteria(description)) !== JSON.stringify(criteria)) throw new Error("the description does not carry the criteria");

// 2. the ERC-8412 preregistration, before any deliverable exists
const c = criteriaDocument(criteria, { chainId: config.chain.id, acp: config.acpAddress, jobId, verifier: judge.account.address, expiry: expiredAt });
const pre = await send("preregister", client, { address: registry, abi: REGISTRY, functionName: "preregister",
  args: [c.criteriaDigest, c.taskRef, c.obligationCount, c.obligationFlags, expiredAt, judge.account.address, ZERO32] });
const preregistrationId = pre.logs.map((l) => { try { return decodeEventLog({ abi: REGISTRY, data: l.data, topics: l.topics }); } catch { return null; } })
  .find((e) => e?.eventName === "CriteriaPreregistered").args.preregistrationId;
console.log(`   prereg id    ${preregistrationId}`);

// 3. budget, funding and the provider's deliverable
const budget = parseUnits("0.01", 6);
await send("setBudget", provider, { address: config.acpAddress, abi: ACP, functionName: "setBudget", args: [jobId, budget, "0x"] });
await send("approve", client, { address: USDC, abi: ERC20, functionName: "approve", args: [config.acpAddress, budget] });
await send("fund", client, { address: config.acpAddress, abi: ACP, functionName: "fund", args: [jobId, "0x"] });
const deliverableHash = keccak256(toHex(payload));
const uri = `data:text/plain;base64,${Buffer.from(payload).toString("base64")}`;
const submitted = await send("submit", provider, { address: config.acpAddress, abi: ACP, functionName: "submit",
  args: [jobId, deliverableHash, stringToHex(`deliverableURI: ${uri}`)] });

// 4. the ruling, exactly as the live judge makes it
const clients = makeClients();
const prepared = await prepareRuling(jobId, deliverableHash, clients, tx.submit);
if (prepared.outcome !== "ready") throw new Error(`the judge did not rule: ${prepared.outcome} ${prepared.reason ?? ""}`);
const judged = await settleRuling(prepared, clients);
tx.verdict = judged.txHash;
console.log(`   verdict      ${judged.txHash} (${judged.pass ? "PASS" : "REJECT"}, score ${judged.score})`);
const verdictReceipt = await pub.waitForTransactionReceipt({ hash: judged.txHash });

// 5. the itemized attestation, by the verifier named at preregistration
const results = prepared.verdictObj.results;
const b = evidenceBundle({ preregistrationId, criteria, deliverable: { digest: deliverableHash, uri, submittedAt: await blockTime(submitted) },
  results, judgedAt: await blockTime(verdictReceipt) });
const a = attestationFor({ preregistrationId, criteriaDoc: c.doc, bundleDigest: b.bundleDigest, results, pass: prepared.pass });
await send("attest", judge, { address: registry, abi: REGISTRY, functionName: "attestOutcome",
  args: [preregistrationId, b.bundleDigest, a.attestationDigest, VERDICTS.indexOf(a.verdict), a.obligationOutcomes] });

// 6. what the chain recorded, and the package a third party checks against it
const [author, criteriaDigest, taskRef, obligationCount, obligationFlags, expiry, registeredAt, verifier, supersedes] =
  await pub.readContract({ address: registry, abi: REGISTRY, functionName: "getPreregistration", args: [preregistrationId] });
const [attVerifier, bundleDigest, attestationDigest, verdict, obligationOutcomes, attestedAt] =
  await pub.readContract({ address: registry, abi: REGISTRY, functionName: "getAttestation", args: [preregistrationId] });
const pkg = {
  name: `judge-protocol-job-${jobId}`,
  description: `A live Judge Protocol ruling on Arc testnet under the ERC-8412 profile: ERC-8183 job ${jobId}, ${a.verdict}. Chain state read back from the registry.`,
  expect: { valid: true, violations: [] },
  chainAccepts: true,
  chain: { chainId: config.chain.id, registry, preregistrationId, author, criteriaDigest, taskRef, obligationCount: Number(obligationCount),
    obligationFlags, expiry: Number(expiry), registeredAt: Number(registeredAt), verifier, supersedes,
    attestation: { verifier: attVerifier, bundleDigest, attestationDigest, verdict: VERDICTS[verdict], obligationOutcomes, attestedAt: Number(attestedAt) } },
  criteria: c.doc, bundle: b.bundle, attestation: a.attestation,
  [`${NS}.transactions`]: tx,
};
const check = await checkPackage(pkg);
const out = opt("--out") || `../docs/erc8412/job-${jobId}.json`;
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(pkg, null, 2) + "\n");
console.log(`\n   package      ${out}`);
console.log(`   check        ${check.valid ? "valid on every rule" : JSON.stringify(check.violations)}${check.unchecked.length ? ` (unchecked: ${check.unchecked})` : ""}`);
console.log(`\n   reference verifier: python3 test/fixtures/erc8412/reference/verifier/verify.py ${out}\n`);
process.exit(check.valid ? 0 : 1);
