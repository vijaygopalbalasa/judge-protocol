#!/usr/bin/env node
// Freeze the chain evidence for one Judge ruling into the evidence closure of
// the ERC-8404 profile judge-protocol-rvr-v0 (rvr/profiles/judge-protocol-rvr-v0):
// a chain snapshot in rvr-canonical-json-v0 and the exact deliverable bytes.
// Recomputation never reads the chain; this producer tool reads it once, at one
// named block, and records that block.
//
//   node src/rvr-snapshot.mjs <jobId> [--submit-tx 0x...] [--out <dir>] [--rpc <url>]
//
// Writes <dir>/job-<id>.snapshot.json (canonical bytes, no trailing newline) and
// <dir>/job-<id>.deliverable.bin. Needs no keys.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, keccak256, parseAbiItem } from "viem";
import { config } from "./config.js";
import { acpAbi, judgeAbi } from "./abi.js";
import { resolveDeliverableSource } from "./engine.js";
import { resolveDeliverable } from "./evidence.js";

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null; };
const jobIdArg = argv[0] ?? "";
if (!/^[0-9]{1,30}$/.test(jobIdArg) || BigInt(jobIdArg) === 0n) {
  console.error("usage: node src/rvr-snapshot.mjs <jobId> [--submit-tx 0x...] [--out <dir>] [--rpc <url>]");
  process.exit(2);
}
const jobId = BigInt(jobIdArg);
const out = opt("--out") || ".";
const pub = createPublicClient({ chain: config.chain, transport: http(opt("--rpc") || config.rpcUrl) });

/** rvr-canonical-json-v0 (ERC-8404): strings, booleans, null, arrays, objects; keys by code point. */
function rvrCanonical(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { i++; continue; }
      if (c >= 0xd800 && c <= 0xdfff) throw new Error("rvr-canonical-json-v0 forbids lone surrogates");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(rvrCanonical).join(",")}]`;
  if (value && typeof value === "object") {
    const byCodePoint = (a, b) => {
      const x = Array.from(a, (ch) => ch.codePointAt(0)), y = Array.from(b, (ch) => ch.codePointAt(0));
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
      return x.length - y.length;
    };
    return `{${Object.keys(value).sort(byCodePoint).map((k) => `${rvrCanonical(k)}:${rvrCanonical(value[k])}`).join(",")}}`;
  }
  throw new Error(`rvr-canonical-json-v0 forbids ${typeof value}`);
}

const lower = (x) => String(x).toLowerCase();
const JOB_SUBMITTED = parseAbiItem("event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)");
const VERDICT_SUBMITTED = parseAbiItem("event VerdictSubmitted(uint256 indexed jobId, bool indexed pass, uint8 score, bytes32 criteriaHash, bytes32 deliverable, bytes32 evidenceHash, address signer)");

async function findLog(address, event, args, from, to, forward) {
  const SPAN = 10_000n;
  for (let i = 0; i < 60; i++) {
    const lo = forward ? from + BigInt(i) * SPAN : to - BigInt(i + 1) * SPAN + 1n;
    const hi = forward ? lo + SPAN - 1n : to - BigInt(i) * SPAN;
    if (forward ? lo > to : hi < from) break;
    const logs = await pub.getLogs({ address, event, args, fromBlock: lo < from ? from : lo, toBlock: hi > to ? to : hi });
    if (logs.length) return forward ? logs[0] : logs[logs.length - 1];
  }
  return null;
}

const block = await pub.getBlock({ blockTag: "latest" });
const at = block.number;
const job = await pub.readContract({ address: config.acpAddress, abi: acpAbi, functionName: "getJob", args: [jobId], blockNumber: at });
if (BigInt(job.client) === 0n) throw new Error(`job ${jobId} does not exist`);

let submitLog;
const hint = opt("--submit-tx");
if (hint) {
  const receipt = await pub.getTransactionReceipt({ hash: hint });
  submitLog = receipt.logs.find((l) => lower(l.address) === lower(config.acpAddress) && l.topics[0] === keccak256(new TextEncoder().encode("JobSubmitted(uint256,address,bytes32)"))
    && BigInt(l.topics[1]) === jobId);
  if (submitLog) submitLog = { ...submitLog, args: { provider: "0x" + submitLog.topics[2].slice(26), deliverable: submitLog.data } };
} else {
  submitLog = await findLog(config.acpAddress, JOB_SUBMITTED, { jobId }, 0n, at, false);
}
if (!submitLog) throw new Error(`no JobSubmitted log found for job ${jobId}; pass --submit-tx`);

const { uri } = await resolveDeliverableSource(pub, submitLog.transactionHash, job.description);
const content = new Uint8Array((await resolveDeliverable(uri)).content);
if (keccak256(content) !== lower(submitLog.args.deliverable)) throw new Error("the deliverable does not hash to the provider's commitment");

const v = await pub.readContract({ address: config.judgeAddress, abi: judgeAbi, functionName: "getVerdict", args: [jobId], blockNumber: at });
let verdict = null;
if (BigInt(v.timestamp) !== 0n) {
  const vlog = await findLog(config.judgeAddress, VERDICT_SUBMITTED, { jobId }, submitLog.blockNumber, at, true);
  verdict = { jobId: String(v.jobId), criteriaHash: lower(v.criteriaHash), deliverable: lower(v.deliverable), score: String(v.score),
    threshold: String(v.threshold), pass: v.pass, evidenceHash: lower(v.evidenceHash), timestamp: String(v.timestamp),
    txHash: vlog ? lower(vlog.transactionHash) : null, blockNumber: vlog ? String(vlog.blockNumber) : null };
}

const snapshot = {
  schema: "rvr.judge-protocol.chain-snapshot.v0",
  chainId: String(config.chain.id),
  acp: lower(config.acpAddress),
  evaluatorContract: lower(config.judgeAddress),
  readAt: { blockNumber: String(at), blockHash: lower(block.hash) },
  job: { id: String(job.id), client: lower(job.client), provider: lower(job.provider), evaluator: lower(job.evaluator),
    description: job.description, budget: String(job.budget), expiredAt: String(job.expiredAt), status: String(job.status), hook: lower(job.hook) },
  submission: { txHash: lower(submitLog.transactionHash), blockNumber: String(submitLog.blockNumber), blockHash: lower(submitLog.blockHash),
    provider: lower(submitLog.args.provider), deliverable: lower(submitLog.args.deliverable) },
  verdict,
};
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `job-${jobId}.snapshot.json`), rvrCanonical(snapshot));
fs.writeFileSync(path.join(out, `job-${jobId}.deliverable.bin`), content);
console.log(JSON.stringify({ jobId: String(jobId), readAt: snapshot.readAt, submission: snapshot.submission.txHash,
  verdict: verdict && { pass: verdict.pass, score: verdict.score, txHash: verdict.txHash }, deliverableBytes: content.length }));
