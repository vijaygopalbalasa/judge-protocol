#!/usr/bin/env node
// Full census of an ERC-8183 contract: every job read from chain, no sampling.
//
//   node src/census.mjs [--out census.jsonl] [--rpc URL] [--acp ADDR] [--layout circle|virtuals-v3] [--judge ADDR]... [--to N] [--no-logs] [--from-block N]
//
// Defaults: Circle's ERC-8183 contract on Arc testnet and JudgeEvaluator. --layout
// virtuals-v3 reads Virtuals' AgenticCommerceV3 (on Base and Arc mainnet), whose getJob
// returns the fields in another order. Jobs go to --out as one JSON line each
// (resumable: jobs already there are not read again). It also scans the contract's logs from its deployment for
// HookWhitelistUpdated, with a control: the JobCreated logs it finds must equal
// the job counter at the same block, or the hook count is reported as unknown.
// The summary (definitions in census-lib.js) is printed and written to
// <out>.summary.json. No keys needed; it only reads.
import fs from "node:fs";
import { createPublicClient, http, keccak256, parseAbiItem, stringToBytes } from "viem";
import { JOB_LAYOUTS, analyzeCensus, fetchAll, recordFromJob, scanRanges } from "./census-lib.js";

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : dflt; };
const all = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const RPC = opt("--rpc", process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io");
const ACP = opt("--acp", "0x0747EEf0706327138c69792bF28Cd525089e4583");
const OUT = opt("--out", "census.jsonl");
const JUDGES = all("--judge").length ? all("--judge") : ["0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD"];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const LAYOUT = opt("--layout", "circle");
if (!JOB_LAYOUTS[LAYOUT]) { console.error(`unknown --layout ${LAYOUT} (known: ${Object.keys(JOB_LAYOUTS).join(", ")})`); process.exit(2); }

const abi = [
  parseAbiItem("function jobCounter() view returns (uint256)"),
  parseAbiItem("function evaluatorFeeBP() view returns (uint256)"),
  parseAbiItem("function platformFeeBP() view returns (uint256)"),
  { name: "getJob", type: "function", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [{ type: "tuple", components: JOB_LAYOUTS[LAYOUT].map(([name, type]) => ({ name, type })) }] },
  parseAbiItem("function paymentToken() view returns (address)"),
];
const erc20 = [parseAbiItem("function symbol() view returns (string)"), parseAbiItem("function decimals() view returns (uint8)")];
const HOOK_WHITELIST_TOPIC = keccak256(stringToBytes("HookWhitelistUpdated(address,bool)"));
const JOB_CREATED_TOPIC = keccak256(stringToBytes("JobCreated(uint256,address,address,address,uint256,address)"));

const client = createPublicClient({ transport: http(RPC, { retryCount: 3, retryDelay: 500, timeout: 30_000 }) });
const read = (functionName, args, blockNumber) => client.readContract({ address: ACP, abi, functionName, ...(args ? { args } : {}), ...(blockNumber ? { blockNumber } : {}) });

async function readBatch(ids) {
  const res = await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true,
    contracts: ids.map((id) => ({ address: ACP, abi, functionName: "getJob", args: [BigInt(id)] })) });
  return res.map((r, i) => {
    if (r.status !== "success") throw new Error(`job ${ids[i]}: ${r.error?.shortMessage || "failed"}`);
    return recordFromJob(r.result, ids[i]);
  });
}

/** Retry a read the public RPC rate-limits, backing off. */
async function patient(fn, tries = 8) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 1000 * 2 ** Math.min(i, 5))); }
  }
}

/** The first block at which the contract has code (binary search). */
async function deployBlock(hi) {
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await patient(() => client.getCode({ address: ACP, blockNumber: mid }));
    if (code && code !== "0x") hi = mid; else lo = mid + 1n;
  }
  return lo;
}

async function readLogCounts(from, to) {
  const logs = await client.request({ method: "eth_getLogs", params: [{ address: ACP,
    fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [[HOOK_WHITELIST_TOPIC, JOB_CREATED_TOPIC]] }] });
  let hooks = 0, created = 0;
  for (const l of logs) { if (l.topics[0] === HOOK_WHITELIST_TOPIC) hooks++; else if (l.topics[0] === JOB_CREATED_TOPIC) created++; }
  return { hooks, created };
}

const block = await client.getBlockNumber();
const onChain = Number(await read("jobCounter", undefined, block));
const total = opt("--to") ? Math.min(onChain, Number(opt("--to"))) : onChain; // --to: a partial run, for trying it out
const have = new Set();
if (fs.existsSync(OUT)) for (const line of fs.readFileSync(OUT, "utf8").split("\n")) if (line) have.add(JSON.parse(line).id);
const missing = [];
for (let id = 1; id <= total; id++) if (!have.has(id)) missing.push(id);
console.error(`census of ${ACP} at block ${block}: ${total} jobs, ${have.size} already in ${OUT}, reading ${missing.length}`);

let done = 0;
const { failed } = await fetchAll(missing, readBatch, { batch: 100, concurrency: 2, onRecords: (recs) => {
  if (recs.length) fs.appendFileSync(OUT, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  done += recs.length;
  if (Math.floor((done - recs.length) / 5000) !== Math.floor(done / 5000)) console.error(`  ${done} / ${missing.length}`);
} });
if (failed.length) { console.error(`could not read ${failed.length} jobs: ${failed.slice(0, 20).join(", ")}${failed.length > 20 ? " ..." : ""}. Run again to retry them.`); process.exit(1); }

const records = new Map();
for (const line of fs.readFileSync(OUT, "utf8").split("\n")) if (line) { const r = JSON.parse(line); records.set(r.id, r); }
const stats = analyzeCensus([...records.values()].filter((r) => r.id <= total).sort((x, y) => x.id - y.id), { judges: JUDGES });

// "No hook was ever whitelisted" only counts if the same scan finds exactly
// the JobCreated events the job counter says exist.
let logScan = null;
if (!argv.includes("--no-logs")) {
  const from = opt("--from-block") ? Number(opt("--from-block")) : Number(await deployBlock(block));
  console.error(`scanning logs from block ${from} to ${block}`);
  const { totals, failed: failedRanges } = await scanRanges(from, Number(block), readLogCounts, { span: 10_000, concurrency: 3 });
  logScan = { fromBlock: from, toBlock: Number(block), jobCreatedLogs: totals.created ?? 0, hookWhitelistLogs: totals.hooks ?? 0,
    failedRanges, controlPassed: failedRanges.length === 0 && (totals.created ?? 0) === onChain };
}
// A read the contract may not have (null), retried when the public RPC is merely busy.
const optional = (fn) => patient(fn, 4).catch(() => null);
const [evaluatorFeeBP, platformFeeBP] = await Promise.all([
  optional(() => read("evaluatorFeeBP", undefined, block)).then((x) => (x === null ? null : Number(x))),
  optional(() => read("platformFeeBP", undefined, block)).then((x) => (x === null ? null : Number(x)))]);
// Budgets are summed as 6-decimal USDC; say which token the contract escrows, and warn if it is not 6 decimals.
const paymentToken = await optional(() => read("paymentToken", undefined, block));
const token = paymentToken && await Promise.all([
  optional(() => client.readContract({ address: paymentToken, abi: erc20, functionName: "symbol", blockNumber: block })),
  optional(() => client.readContract({ address: paymentToken, abi: erc20, functionName: "decimals", blockNumber: block })),
]).then(([symbol, decimals]) => ({ address: paymentToken, symbol, decimals: decimals === null ? null : Number(decimals) }));
if (token && token.decimals !== 6) console.error(`warning: the payment token has ${token.decimals} decimals; budgets below are scaled as 6-decimal USDC`);
const summary = { acp: ACP, rpc: RPC, layout: LAYOUT, block: block.toString(), jobCounter: onChain, measured: total, measuredAt: new Date().toISOString(),
  paymentToken: token, evaluatorFeeBP, platformFeeBP, hookWhitelistEvents: logScan?.controlPassed ? logScan.hookWhitelistLogs : null, logScan, ...stats };
fs.writeFileSync(`${OUT}.summary.json`, JSON.stringify(summary, null, 2) + "\n");

const pct = (x) => `${(100 * x).toFixed(2)}%`;
console.log(`ERC-8183 census: ${ACP} (${LAYOUT} layout) at block ${block} (${summary.measuredAt})${token ? `, escrow token ${token.symbol ?? token.address} (${token.decimals} decimals)` : ""}`);
console.log(`  jobs ${stats.jobs}; self-evaluated ${pct(stats.selfEvaluatedRate)} (client ${stats.evaluator.client}, provider ${stats.evaluator.provider}); third party ${stats.evaluator.thirdParty}; no evaluator ${stats.evaluator.zero}`);
console.log(`  funded ${stats.funded}, median ${stats.medianFundedUSDC} USDC; statuses ${JSON.stringify(stats.statuses)}`);
console.log(`  third-party evaluators ${stats.thirdParty.distinctEvaluators}; paid through ${stats.thirdParty.paidThrough.jobs} jobs by ${stats.thirdParty.paidThrough.distinctEvaluators} evaluators, ${stats.thirdParty.paidThrough.totalUSDC} USDC`);
console.log(`  independent evaluators with 4+ paying clients: ${stats.independent.map((x) => `${x.evaluator} (${x.payingClients})`).join(", ") || "none"}`);
console.log(`  jobs with a hook ${stats.withHook}; HookWhitelistUpdated events ${summary.hookWhitelistEvents ?? "unknown"}${logScan ? ` (log scan from block ${logScan.fromBlock}: ${logScan.jobCreatedLogs} JobCreated vs counter ${onChain}, control ${logScan.controlPassed ? "passed" : "FAILED"})` : " (log scan skipped)"}; evaluatorFeeBP ${evaluatorFeeBP}, platformFeeBP ${platformFeeBP}`);
for (const [j, s] of Object.entries(stats.judges)) console.log(`  ${j}: ${s.jobs} jobs from ${s.distinctClients} distinct clients`);
