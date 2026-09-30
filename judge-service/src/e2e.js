#!/usr/bin/env node
// End-to-end proof on Circle's canonical Arc ACP, judged by our JudgeEvaluator.
//
// This version proves the CORRECTED flow the earlier demo lacked:
//   • the CLIENT authors only the acceptance criteria (in the job description)
//   • a SIGNER registers the criteria hash on-chain while the job is still Open
//   • the PROVIDER authors the deliverable and supplies it via submit() optParams
//   • the judge reads the provider's deliverable, asserts it hashes to the
//     committed bytes32, runs deterministic checks, and settles escrow
//
//   node src/e2e.js            # passing deliverable → COMPLETE
//   node src/e2e.js --reject   # criteria-violating deliverable → REJECT
//
// Any ERC-8183 escrow with Circle's Job layout works: set ACP_ADDRESS, JUDGE_ADDRESS, ARC_RPC_URL and
// CHAIN_ID (5042 for Arc mainnet). E2E_BUDGET is the job's budget in USDC (default 1); 0 skips approve
// and fund, for escrows that let a zero-budget job be submitted while Open (ArcBounty's and Virtuals').
// --judge-now rules in this process right after submission (the hosted judge's judgeNow), so no
// watcher or hosted API is needed. E2E_REGISTRAR_KEY registers the criteria (default JUDGE_SIGNER_KEY; the
// judge's owner may also register). E2E_TOKEN is the escrow's payment token (default Arc's USDC) and E2E_HOOK
// the hook the job names (default none), for escrows deployed with contracts/script/DeployKit.s.sol.
import { createPublicClient, createWalletClient, http, keccak256, toHex, stringToHex, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { criteriaHash, extractCriteria } from "./criteria.js";

const USDC = process.env.E2E_TOKEN || "0x3600000000000000000000000000000000000000";
const HOOK = process.env.E2E_HOOK || "0x0000000000000000000000000000000000000000";
const erc20Abi = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];

const ACP = [
  { name: "createJob", type: "function", stateMutability: "nonpayable", inputs: [{ name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "expiredAt", type: "uint256" }, { name: "description", type: "string" }, { name: "hook", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "setBudget", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "fund", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "submit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "deliverable", type: "bytes32" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "getJob", type: "function", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [{ type: "tuple", components: [{ name: "id", type: "uint256" }, { name: "client", type: "address" }, { name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "description", type: "string" }, { name: "budget", type: "uint256" }, { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" }, { name: "hook", type: "address" }] }] },
  { name: "JobCreated", type: "event", anonymous: false, inputs: [{ indexed: true, name: "jobId", type: "uint256" }, { indexed: true, name: "client", type: "address" }, { indexed: true, name: "provider", type: "address" }, { indexed: false, name: "evaluator", type: "address" }, { indexed: false, name: "expiredAt", type: "uint256" }, { indexed: false, name: "hook", type: "address" }] },
];
const JUDGE = [
  { name: "registerCriteria", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "criteriaHash", type: "bytes32" }], outputs: [] },
];
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
const wc = (key) => createWalletClient({ account: privateKeyToAccount(key), chain: config.chain, transport: http(config.rpcUrl) });

async function main() {
  const rejectMode = process.argv.includes("--reject");
  const pub = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
  const client = wc(process.env.CLIENT_KEY);
  const provider = wc(process.env.PROVIDER_KEY);
  const providerAddr = provider.account.address;

  // CLIENT authors ONLY the acceptance criteria, never the deliverable.
  const description = [
    "Analyze ERC-8183 escrow on Arc.",
    "```judge-criteria",
    JSON.stringify({ version: 1, jobType: "doc", passThreshold: 100, checks: [
      { kind: "length", params: { min: 10, max: 5000 }, weight: 1 },
      { kind: "contains", params: { all: ["ERC-8183", "USDC"] }, weight: 1 },
    ] }),
    "```",
  ].join("\n");
  const criteria = extractCriteria(description);
  const cHash = criteriaHash(criteria);

  // PROVIDER authors the deliverable independently, at submit time.
  const payload = rejectMode
    ? "Low-effort filler with no relevant content whatsoever."
    : "This analysis covers ERC-8183 escrow mechanics and USDC settlement on Arc in sufficient detail to satisfy the acceptance criteria.";
  const deliverableHash = keccak256(toHex(payload));
  const deliverableURI = `data:text/plain;base64,${Buffer.from(payload).toString("base64")}`;
  const optParams = stringToHex(`deliverableURI: ${deliverableURI}`); // provider's channel

  const budget = parseUnits(process.env.E2E_BUDGET ?? "1", 6);

  console.log(`\n=== E2E (${rejectMode ? "REJECT" : "PASS"} path): provider-authored deliverable ===`);
  console.log("1) client createJob (criteria only, evaluator = JudgeEvaluator)");
  const createHash = await client.writeContract({ address: config.acpAddress, abi: ACP, functionName: "createJob",
    args: [providerAddr, config.judgeAddress, BigInt(Math.floor(Date.now() / 1000) + 3600), description, HOOK] });
  const rcpt = await pub.waitForTransactionReceipt({ hash: createHash });
  let jobId;
  const { decodeEventLog } = await import("viem");
  for (const lg of rcpt.logs) { try { const d = decodeEventLog({ abi: ACP, data: lg.data, topics: lg.topics }); if (d.eventName === "JobCreated") { jobId = d.args.jobId; break; } } catch {} }
  console.log(`   jobId = ${jobId} | tx ${createHash}`);

  // With JUDGE_API_URL set, run exactly the path a third party takes: no
  // registration by us (the immutable description already binds the criteria),
  // then ask the hosted judge to rule right after submitting.
  const hosted = process.env.JUDGE_API_URL || "";
  if (hosted) {
    console.log(`2) (third-party flow) no criteria registration; criteriaHash ${cHash} is bound by the description`);
  } else {
    console.log("2) a signer (or the judge's owner) registers the criteria hash on-chain (while Open, before submission)");
    // A signer or the judge's owner; only this path needs one, so a third party (JUDGE_API_URL) needs no judge key.
    const registrarKey = process.env.E2E_REGISTRAR_KEY || process.env.JUDGE_SIGNER_KEY;
    if (!registrarKey) throw new Error("registering criteria needs E2E_REGISTRAR_KEY or JUDGE_SIGNER_KEY (or set JUDGE_API_URL)");
    const rc = await wc(registrarKey).writeContract({ address: config.judgeAddress, abi: JUDGE, functionName: "registerCriteria", args: [jobId, cHash] });
    await pub.waitForTransactionReceipt({ hash: rc });
    console.log(`   criteriaHash ${cHash} committed`);
  }

  console.log("3) provider setBudget");
  await pub.waitForTransactionReceipt({ hash: await provider.writeContract({ address: config.acpAddress, abi: ACP, functionName: "setBudget", args: [jobId, budget, "0x"] }) });
  if (budget > 0n) {
    console.log("4) client approve + fund");
    await pub.waitForTransactionReceipt({ hash: await client.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [config.acpAddress, budget] }) });
    await pub.waitForTransactionReceipt({ hash: await client.writeContract({ address: config.acpAddress, abi: ACP, functionName: "fund", args: [jobId, "0x"] }) });
  } else {
    console.log("4) budget 0: nothing to escrow, the job stays Open until submitted");
  }

  console.log("5) PROVIDER submit: deliverable hash + deliverable URI in optParams");
  const submitTx = await provider.writeContract({ address: config.acpAddress, abi: ACP, functionName: "submit", args: [jobId, deliverableHash, optParams] });
  await pub.waitForTransactionReceipt({ hash: submitTx });
  if (process.argv.includes("--judge-now")) {
    console.log("6) judge now, in this process");
    const { judgeNow } = await import("./judge-now.js");
    const r = await judgeNow({ jobId: jobId.toString(), submitTx });
    console.log(`   ${r.status}: ${JSON.stringify(r.body, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 400)}`);
  } else if (hosted) {
    console.log(`6) ask the hosted judge: POST ${hosted}/api/judge`);
    const r = await fetch(`${hosted}/api/judge`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: jobId.toString(), submitTx }) });
    console.log(`   HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
  }

  const before = Number(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [providerAddr] })) / 1e6;
  const cBefore = Number(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [client.account.address] })) / 1e6;
  console.log(`   provider ${before} USDC | client ${cBefore} USDC, waiting for judge…`);

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await pub.readContract({ address: config.acpAddress, abi: ACP, functionName: "getJob", args: [jobId] });
    const st = STATUS[Number(job.status)];
    if (st === "Completed" || st === "Rejected") {
      const after = Number(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [providerAddr] })) / 1e6;
      const cAfter = Number(await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [client.account.address] })) / 1e6;
      const want = rejectMode ? "Rejected" : "Completed";
      console.log(`   FINAL: ${st} | provider ${before}→${after} | client ${cBefore}→${cAfter}`);
      console.log(`\nE2E RESULT: ${st === want ? `${st.toUpperCase()} as expected ✓` : `UNEXPECTED ${st} (wanted ${want})`}  jobId=${jobId}\n`);
      process.exit(st === want ? 0 : 1);
    }
    process.stdout.write(".");
  }
  console.log("\nTIMEOUT waiting for verdict"); process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
