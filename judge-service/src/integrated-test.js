#!/usr/bin/env node
// Integrated local proof: assumes contracts are freshly deployed and prints the
// full judged-job lifecycle. Uses Anvil accounts 0 (deployer/judge) 1 (client) 2 (provider).
import { createPublicClient, createWalletClient, http, keccak256, toHex, parseUnits, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { extractCriteria, criteriaHash } from "./criteria.js";
import { resolveDeliverable, storeEvidence } from "./evidence.js";
import { runAllChecks } from "./checkers/index.js";

const RPC = "http://127.0.0.1:8545";
const [DEPLOYER_KEY, CLIENT_KEY, PROVIDER_KEY] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc69fb9a804cdab365",
];
const [USDC, ACP, JUDGE] = [process.env.USDC, process.env.ACP, process.env.JUDGE];

const chain = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wc = (k) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(RPC) });
const deployer = wc(DEPLOYER_KEY), client = wc(CLIENT_KEY), provider = wc(PROVIDER_KEY);

const erc20 = [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] }, { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }, { name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "t", type: "address" }, { name: "a", type: "uint256" }], outputs: [] }];
const acpAbi = [
  { name: "createJob", type: "function", stateMutability: "nonpayable", inputs: [{ name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "expiredAt", type: "uint256" }, { name: "description", type: "string" }, { name: "hook", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "setBudget", type: "function", stateMutability: "nonpayable", inputs: [{ name: "j", type: "uint256" }, { name: "a", type: "uint256" }, { name: "o", type: "bytes" }], outputs: [] },
  { name: "fund", type: "function", stateMutability: "nonpayable", inputs: [{ name: "j", type: "uint256" }, { name: "o", type: "bytes" }], outputs: [] },
  { name: "submit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "j", type: "uint256" }, { name: "d", type: "bytes32" }, { name: "o", type: "bytes" }], outputs: [] },
  { name: "getJob", type: "function", stateMutability: "view", inputs: [{ name: "j", type: "uint256" }], outputs: [{ type: "tuple", components: [{ name: "id", type: "uint256" }, { name: "client", type: "address" }, { name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "description", type: "string" }, { name: "budget", type: "uint256" }, { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" }, { name: "hook", type: "address" }] }] },
];
const judgeAbi = [{ name: "submitVerdict", type: "function", stateMutability: "nonpayable", inputs: [{ name: "v", type: "tuple", components: [{ name: "jobId", type: "uint256" }, { name: "criteriaHash", type: "bytes32" }, { name: "deliverable", type: "bytes32" }, { name: "score", type: "uint8" }, { name: "pass", type: "bool" }, { name: "evidenceHash", type: "bytes32" }, { name: "timestamp", type: "uint64" }] }, { name: "sig", type: "bytes" }], outputs: [] }];

const TYPES = { Verdict: [{ name: "jobId", type: "uint256" }, { name: "criteriaHash", type: "bytes32" }, { name: "deliverable", type: "bytes32" }, { name: "score", type: "uint8" }, { name: "pass", type: "bool" }, { name: "evidenceHash", type: "bytes32" }, { name: "timestamp", type: "uint64" }] };

const ok = (s) => console.log("  ✓", s);

async function main() {
  console.log("=== Judge Protocol: integrated local proof ===\n");

  // fund client USDC
  let h = await deployer.writeContract({ address: USDC, abi: erc20, functionName: "mint", args: [client.account.address, parseUnits("10", 6)] });
  await pub.waitForTransactionReceipt({ hash: h });
  ok("client funded 10 USDC");

  // build a passing job
  const payload = "This deliverable covers ERC-8183 escrow and USDC settlement thoroughly and completely.";
  const description = ["Analyze ERC-8183.", "```judge-criteria", JSON.stringify({ version: 1, jobType: "doc", passThreshold: 100, checks: [{ kind: "length", params: { min: 5, max: 5000 }, weight: 1 }, { kind: "contains", params: { all: ["ERC-8183", "USDC"] }, weight: 1 }] }), "```", `deliverableURI: data:text/plain;base64,${Buffer.from(payload).toString("base64")}`].join("\n");
  const deliverableHash = keccak256(toHex(payload));
  const budget = parseUnits("1", 6);

  h = await client.writeContract({ address: ACP, abi: acpAbi, functionName: "createJob", args: [provider.account.address, JUDGE, BigInt(Math.floor(Date.now() / 1000) + 3600), description, "0x0000000000000000000000000000000000000000"] });
  let rc = await pub.waitForTransactionReceipt({ hash: h });
  const jobId = 1n; // fresh ACP → first job
  ok(`job created (id=${jobId}) evaluator=Judge`);

  h = await provider.writeContract({ address: ACP, abi: acpAbi, functionName: "setBudget", args: [jobId, budget, "0x"] }); await pub.waitForTransactionReceipt({ hash: h });
  h = await client.writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [ACP, budget] }); await pub.waitForTransactionReceipt({ hash: h });
  h = await client.writeContract({ address: ACP, abi: acpAbi, functionName: "fund", args: [jobId, "0x"] }); await pub.waitForTransactionReceipt({ hash: h });
  h = await provider.writeContract({ address: ACP, abi: acpAbi, functionName: "submit", args: [jobId, deliverableHash, "0x"] }); await pub.waitForTransactionReceipt({ hash: h });
  ok("job funded + submitted, escrow locked");

  // ===== JUDGE ENGINE =====
  const job = await pub.readContract({ address: ACP, abi: acpAbi, functionName: "getJob", args: [jobId] });
  const criteria = extractCriteria(job.description);
  const deliverable = await resolveDeliverable(`data:text/plain;base64,${Buffer.from(payload).toString("base64")}`);
  const { results, score, pass } = await runAllChecks(criteria, deliverable);
  results.forEach((r) => ok(`check ${r.kind}: ${r.pass ? "pass" : "fail"}, ${r.detail}`));

  const cHash = criteriaHash(criteria);
  const verdictObj = { jobId: jobId.toString(), criteriaHash: cHash, deliverable: deliverableHash, results, score, pass, judge: deployer.account.address, finishedAt: new Date().toISOString() };
  const { evidenceHash } = storeEvidence(verdictObj);

  const verdict = { jobId, criteriaHash: cHash, deliverable: deliverableHash, score, pass, evidenceHash, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
  const sig = await deployer.account.signTypedData({ domain: { name: "JudgeEvaluator", version: "1", chainId: 31337, verifyingContract: JUDGE }, types: TYPES, primaryType: "Verdict", message: verdict });
  ok(`verdict signed (EIP-712) pass=${pass} score=${score}`);

  const balBefore = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [provider.account.address] });
  h = await deployer.writeContract({ address: JUDGE, abi: judgeAbi, functionName: "submitVerdict", args: [verdict, sig] });
  await pub.waitForTransactionReceipt({ hash: h });

  const final = await pub.readContract({ address: ACP, abi: acpAbi, functionName: "getJob", args: [jobId] });
  const balAfter = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [provider.account.address] });
  const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
  console.log(`\n  FINAL STATUS: ${STATUS[Number(final.status)]}`);
  console.log(`  PROVIDER USDC: ${Number(balBefore) / 1e6} → ${Number(balAfter) / 1e6}`);
  console.log(`  VERDICT TX: ${h}`);
  console.log(`\n=== ${STATUS[Number(final.status)] === "Completed" && balAfter > balBefore ? "E2E PASS ✓: escrow released by deterministic judge" : "E2E UNEXPECTED"} ===`);
}
main().catch((e) => { console.error(e.shortMessage || e.message || e); process.exit(1); });
