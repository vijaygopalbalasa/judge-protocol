#!/usr/bin/env node
// Runs the ERC-8183 conformance suite (test/conformance) against every target and prints the matrix as Markdown.
// Forks use public RPC endpoints unless ARC_TESTNET_RPC, ARC_MAINNET_RPC or BASE_RPC are set. Read-only: nothing is
// sent to any chain; every job is created on a local fork.
//   node script/conformance-matrix.mjs > ../docs/conformance-matrix.md
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RPC = {
  ARC_TESTNET_RPC: process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.io",
  ARC_MAINNET_RPC: process.env.ARC_MAINNET_RPC || "https://rpc.mainnet.arc.io",
  BASE_RPC: process.env.BASE_RPC || "https://mainnet.base.org",
};

// The targets, in column order, with what each one is and the chain it was read from.
const TARGETS = [
  ["ConformanceReferenceImplementation", "ERC reference code", null],
  ["ConformanceCircleArcTestnet", "Circle, Arc testnet", "ARC_TESTNET_RPC"],
  ["ConformanceArcBountyArcMainnet", "ArcBounty, Arc mainnet", "ARC_MAINNET_RPC"],
  ["ConformanceG2JobsArcMainnet", "G2 Jobs, Arc mainnet", "ARC_MAINNET_RPC"],
  ["ConformanceVirtualsBase", "Virtuals V3, Base", "BASE_RPC"],
];

// Each test, the rule it checks (quoted or paraphrased from the Specification section) and whether it is a SHALL.
export const RULES = [
  ["test_createJob_opensAJobForTheCaller", "createJob opens an Open job with client = caller", "SHALL"],
  ["test_createJob_revertsWithoutAnEvaluator", "createJob reverts if the evaluator is zero", "SHALL"],
  ["test_createJob_revertsWhenExpiryIsNotInTheFuture", "createJob reverts unless expiredAt is in the future", "SHALL"],
  ["test_setProvider_clientOnlyOnceAndNeverZero", "setProvider: client only, once, never zero (when a job may start without one)", "SHALL"],
  ["test_fund_revertsWhileTheProviderIsUnset", "fund reverts while the provider is unset", "SHALL"],
  ["test_setBudget_theClientMaySetIt", "setBudget may be called by the client", "SHALL"],
  ["test_setBudget_theProviderMaySetIt", "setBudget may be called by the provider", "SHALL"],
  ["test_setBudget_revertsForAnyoneElse", "setBudget reverts for anyone else", "SHALL"],
  ["test_setBudget_revertsOnceFunded", "setBudget reverts once the job is not Open", "SHALL"],
  ["test_fund_revertsForAnyoneButTheClient", "fund reverts unless the caller is the client", "SHALL"],
  ["test_fund_revertsWhenTheBudgetIsZero", "fund reverts if the budget is zero", "SHALL"],
  ["test_fund_revertsWhenTheBudgetIsNotTheExpectedOne", "fund reverts if budget != expectedBudget (front-running guard)", "SHALL"],
  ["test_fund_movesExactlyTheBudgetIntoEscrow", "fund pulls exactly the budget into escrow and sets Funded", "SHALL"],
  ["test_fund_revertsOnceFunded", "fund reverts unless the job is Open", "SHALL"],
  ["test_submit_revertsForAnyoneButTheProvider", "submit reverts unless the caller is the provider", "SHALL"],
  ["test_submit_revertsUnlessFunded", "submit reverts unless the job is Funded", "SHALL"],
  ["test_submit_recordsTheWorkAndEmitsTheDeliverable", "submit sets Submitted and emits the deliverable", "SHALL"],
  ["test_complete_revertsForAnyoneButTheEvaluator", "complete reverts unless the caller is the evaluator", "SHALL"],
  ["test_complete_revertsUnlessSubmitted", "complete reverts unless the job is Submitted", "SHALL"],
  ["test_complete_paysTheProviderFromTheEscrow", "complete pays the provider (fees only on completion)", "SHALL"],
  ["test_reject_anOpenJobByTheClientOnly", "reject of an Open job: client only", "SHALL"],
  ["test_reject_aFundedJobByTheEvaluatorRefundsInFull", "reject of a Funded job: evaluator only, full refund", "SHALL"],
  ["test_reject_aSubmittedJobByTheEvaluatorRefundsInFull", "reject of a Submitted job: evaluator only, full refund", "SHALL"],
  ["test_claimRefund_revertsBeforeExpiry", "claimRefund reverts before expiredAt", "SHALL"],
  ["test_claimRefund_aFundedJobAtExpiryRefundsInFull", "claimRefund of a Funded job at expiredAt refunds in full", "SHALL"],
  ["test_claimRefund_aSubmittedJobAtExpiryRefundsInFull", "claimRefund of a Submitted job at expiredAt refunds in full", "SHALL"],
  ["test_claimRefund_revertsForOpenOrSettledJobs", "claimRefund reverts unless the job is Funded or Submitted", "SHALL"],
  ["test_completed_isFinal", "Completed is terminal, and its money moves once", "SHALL"],
  ["test_rejectedAndExpired_areFinal", "Rejected and Expired are terminal, and their money moves once", "SHALL"],
  ["test_should_claimRefund_anyoneMayTriggerIt", "anyone may trigger a refund after expiry", "RECOMMENDED"],
];

function runForge() {
  const env = { ...process.env, ...RPC, ERC8183_CONFORMANCE: "1" };
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  let out;
  try {
    out = execFileSync("forge", ["test", "--match-path", "test/conformance/*", "--json"], { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = e.stdout; // forge exits non-zero when any test fails; failures are the data here
  }
  return JSON.parse(out);
}

async function blockOf(url) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
  return Number(BigInt((await res.json()).result));
}

export function matrix(results) {
  const bySuite = Object.fromEntries(Object.entries(results).map(([k, v]) => [k.split(":").pop(), v.test_results]));
  const cell = (suite, test) => {
    const r = bySuite[suite]?.[`${test}()`];
    if (!r) return "not run";
    if (r.status === "Success") return "pass";
    if (r.status === "Skipped") return "n/a";
    const reason = String(r.reason ?? "failed");
    const must = reason.match(/^this call must succeed: (.*)$/);
    return must ? `FAIL: ${must[1]} reverts` : `FAIL: ${reason}`;
  };
  const rows = RULES.map(([test, rule, level]) => [rule, level, ...TARGETS.map(([s]) => cell(s, test))]);
  const totals = TARGETS.map(([s]) => {
    const shall = RULES.filter(([, , l]) => l === "SHALL").map(([t]) => cell(s, t));
    return `${shall.filter((c) => c === "pass").length}/${shall.filter((c) => c !== "n/a").length}`;
  });
  return { rows, totals };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = runForge();
  const { rows, totals } = matrix(results);
  const blocks = {};
  for (const [name, url] of Object.entries(RPC)) {
    try { blocks[name] = await blockOf(url); } catch { blocks[name] = "unknown"; }
  }
  const head = ["Rule", "Level", ...TARGETS.map(([, label]) => label)];
  const line = (cells) => `| ${cells.join(" | ")} |`;
  console.log(`Measured ${new Date().toISOString().slice(0, 10)} on forks of Arc testnet (block ${blocks.ARC_TESTNET_RPC}), Arc mainnet (block ${blocks.ARC_MAINNET_RPC}) and Base (block ${blocks.BASE_RPC}).\n`);
  console.log(line(head));
  console.log(line(head.map(() => "---")));
  for (const r of rows) console.log(line(r.map((c) => c.replaceAll("|", "/"))));
  console.log(line(["SHALL rules passed", "", ...totals]));
}
