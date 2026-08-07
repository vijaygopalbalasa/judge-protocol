#!/usr/bin/env node
// Measure the ERC-8183 evaluator market on Circle's canonical Arc deployment.
// Answers the only question that matters: has ANY third-party evaluator ever
// been paid through on a funded job? Writes CSV + JSON so every number we
// publish is reproducible by a stranger with this file.
//
//   node src/measure-acp.js [sampleSize]
import { createPublicClient, http } from "viem";
import { writeFileSync } from "node:fs";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io";
const ACP = process.env.ACP_ADDRESS || "0x0747EEf0706327138c69792bF28Cd525089e4583";
const ZERO = "0x0000000000000000000000000000000000000000";
const SAMPLE = Number(process.argv[2] || 600);
const CONCURRENCY = 8;

const abi = [
  { name: "jobCounter", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "getJob", type: "function", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ type: "tuple", components: [
      { name: "id", type: "uint256" }, { name: "client", type: "address" }, { name: "provider", type: "address" },
      { name: "evaluator", type: "address" }, { name: "description", type: "string" }, { name: "budget", type: "uint256" },
      { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" }, { name: "hook", type: "address" }] }] },
];
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

const pub = createPublicClient({ transport: http(RPC, { retryCount: 5, retryDelay: 400 }) });

async function getJob(jobId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const j = await pub.readContract({ address: ACP, abi, functionName: "getJob", args: [BigInt(jobId)] });
      return {
        jobId, client: j.client.toLowerCase(), provider: j.provider.toLowerCase(),
        evaluator: j.evaluator.toLowerCase(), budget: j.budget,
        status: STATUS[Number(j.status)] ?? `unknown(${j.status})`, hook: j.hook.toLowerCase(),
      };
    } catch {
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return null;
}

async function main() {
  const counter = Number(await pub.readContract({ address: ACP, abi, functionName: "jobCounter" }));
  const step = Math.max(1, Math.floor(counter / SAMPLE));
  const ids = [];
  for (let id = 1; id <= counter; id += step) ids.push(id);
  console.log(`jobCounter=${counter} · sampling ${ids.length} jobs (every ${step}th) · rpc=${RPC}`);

  const jobs = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = await Promise.all(ids.slice(i, i + CONCURRENCY).map(getJob));
    jobs.push(...batch.filter(Boolean));
    if (i % (CONCURRENCY * 20) === 0) process.stdout.write(".");
  }
  console.log(`\nfetched ${jobs.length}/${ids.length}`);

  const selfEval = jobs.filter((j) => j.evaluator === j.client);
  const thirdParty = jobs.filter((j) => j.evaluator !== j.client && j.evaluator !== ZERO);
  const funded = jobs.filter((j) => j.budget > 0n);
  const decided = jobs.filter((j) => j.status === "Completed" || j.status === "Rejected");
  const nonZeroHook = jobs.filter((j) => j.hook !== ZERO);

  // THE number: third-party evaluators that were paid through on a funded job.
  const paidThrough = jobs.filter(
    (j) => j.evaluator !== j.client && j.evaluator !== ZERO && j.budget > 0n && j.status === "Completed"
  );
  const paidThroughEvaluators = [...new Set(paidThrough.map((j) => j.evaluator))];
  const distinctThirdParty = [...new Set(thirdParty.map((j) => j.evaluator))];

  const byStatus = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  const budgets = funded.map((j) => Number(j.budget) / 1e6).sort((a, b) => a - b);
  const median = budgets.length ? budgets[Math.floor(budgets.length / 2)] : 0;

  const report = {
    measuredAt: new Date().toISOString(), rpc: RPC, acp: ACP, chainId: 5042002,
    jobCounter: counter, sampled: jobs.length, samplingStep: step,
    selfEvaluationRate: +(selfEval.length / jobs.length * 100).toFixed(2),
    thirdPartyEvaluatorJobs: thirdParty.length,
    distinctThirdPartyEvaluators: distinctThirdParty.length,
    fundedJobs: funded.length,
    fundedRate: +(funded.length / jobs.length * 100).toFixed(2),
    medianFundedBudgetUSDC: median,
    decidedJobs: decided.length,
    rejectionRate: decided.length ? +(byStatus.Rejected / decided.length * 100).toFixed(2) : null,
    jobsWithNonZeroHook: nonZeroHook.length,
    THIRD_PARTY_EVALUATORS_PAID_THROUGH: paidThroughEvaluators.length,
    thirdPartyPaidThroughJobs: paidThrough.length,
    paidThroughEvaluatorAddresses: paidThroughEvaluators.slice(0, 25),
    statusBreakdown: byStatus,
  };

  writeFileSync("acp-measurement.json", JSON.stringify(report, null, 2));
  writeFileSync("acp-measurement.csv",
    "jobId,client,provider,evaluator,selfEvaluated,budgetUSDC,status,hook\n" +
    jobs.map((j) => [j.jobId, j.client, j.provider, j.evaluator, j.evaluator === j.client,
      Number(j.budget) / 1e6, j.status, j.hook].join(",")).join("\n"));

  console.log("\n" + "=".repeat(60));
  console.log(JSON.stringify(report, null, 2));
  console.log("\nwrote acp-measurement.json + acp-measurement.csv");
}

main().catch((e) => { console.error(e); process.exit(1); });
