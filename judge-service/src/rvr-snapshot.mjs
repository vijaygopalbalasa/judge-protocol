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
import { pathToFileURL } from "node:url";
import { createPublicClient, decodeEventLog, decodeFunctionData, hexToString, http, keccak256, parseAbiItem } from "viem";
import { config } from "./config.js";
import { acpAbi, judgeAbi } from "./abi.js";
import { extractDeliverableURI, resolveDeliverable } from "./evidence.js";

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
const SUBMIT = [parseAbiItem("function submit(uint256 jobId, bytes32 deliverable, bytes optParams)")];
const SPAN = 10_000n;

/** The last matching log at or before `to` (searching back), or the first at or after `from` (forward). */
async function findLog(pub, address, event, args, from, to, forward) {
  for (let i = 0; i < 60; i++) {
    const lo = forward ? from + BigInt(i) * SPAN : to - BigInt(i + 1) * SPAN + 1n;
    const hi = forward ? lo + SPAN - 1n : to - BigInt(i) * SPAN;
    if (forward ? lo > to : hi < from) break;
    const logs = await pub.getLogs({ address, event, args, fromBlock: lo < from ? from : lo, toBlock: hi > to ? to : hi });
    if (logs.length) return forward ? logs[0] : logs[logs.length - 1];
  }
  return null;
}

/** The provider's JobSubmitted for this job, from the hinted transaction or the newest one at or before `at`. */
async function findSubmission(pub, jobId, submitTx, at) {
  if (!submitTx) {
    const log = await findLog(pub, config.acpAddress, JOB_SUBMITTED, { jobId }, 0n, at, false);
    return log && { txHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash, ...log.args };
  }
  const receipt = await pub.getTransactionReceipt({ hash: submitTx });
  if (receipt.status !== "success") throw new Error(`submit transaction ${submitTx} did not succeed`);
  if (BigInt(receipt.blockNumber) > at) throw new Error(`submit transaction ${submitTx} was mined after readAt (${at})`);
  for (const l of receipt.logs || []) {
    if (lower(l.address) !== lower(config.acpAddress)) continue;
    try {
      const { args } = decodeEventLog({ abi: [JOB_SUBMITTED], data: l.data, topics: l.topics });
      if (args.jobId === jobId) return { txHash: submitTx, blockNumber: receipt.blockNumber, blockHash: l.blockHash ?? receipt.blockHash, ...args };
    } catch { /* a different event */ }
  }
  return null;
}

/** The deliverable URI the provider put in submit's optParams, else the one in the job description. */
async function deliverableUri(pub, submitTx, description) {
  let tx;
  try { tx = await pub.getTransaction({ hash: submitTx }); } catch (e) {
    throw new Error(`cannot read the submit transaction ${submitTx}: ${e.message}`);
  }
  let optParams = "0x";
  try { optParams = decodeFunctionData({ abi: SUBMIT, data: tx.input }).args[2]; } catch { /* not a direct submit call */ }
  if (optParams && optParams !== "0x") {
    let text = "";
    try { text = hexToString(optParams); } catch { text = ""; }
    const uri = extractDeliverableURI(text) || (/^(data:|ipfs:\/\/|https?:\/\/)/.test(text.trim()) ? text.trim() : null);
    if (uri) return uri;
  }
  const fromDescription = extractDeliverableURI(description);
  if (!fromDescription) throw new Error("neither the submit transaction nor the job description names a deliverable URI");
  return fromDescription;
}

/**
 * Read one ruling at the latest block and return { snapshot, content }.
 * Throws rather than write a snapshot that could misstate the chain.
 */
export async function freezeRuling({ publicClient: pub, jobId, submitTx, fetchDeliverable = resolveDeliverable }) {
  const chainId = await pub.getChainId();
  if (chainId !== config.chain.id) throw new Error(`the RPC serves chain ${chainId}, not ${config.chain.id}`);
  const block = await pub.getBlock({ blockTag: "latest" });
  const at = block.number;
  const job = await pub.readContract({ address: config.acpAddress, abi: acpAbi, functionName: "getJob", args: [jobId], blockNumber: at });
  if (BigInt(job.client) === 0n) throw new Error(`job ${jobId} does not exist`);

  const submission = await findSubmission(pub, jobId, submitTx, at);
  if (!submission) throw new Error(`no JobSubmitted log found for job ${jobId}; pass --submit-tx`);
  const uri = await deliverableUri(pub, submission.txHash, job.description);
  const content = new Uint8Array((await fetchDeliverable(uri)).content);
  if (keccak256(content) !== lower(submission.deliverable)) throw new Error("the deliverable does not hash to the provider's commitment");

  const v = await pub.readContract({ address: config.judgeAddress, abi: judgeAbi, functionName: "getVerdict", args: [jobId], blockNumber: at });
  let verdict = null;
  if (BigInt(v.timestamp) !== 0n) {
    const log = await findLog(pub, config.judgeAddress, VERDICT_SUBMITTED, { jobId }, BigInt(submission.blockNumber), at, true);
    if (log && [["criteriaHash", v.criteriaHash], ["deliverable", v.deliverable], ["evidenceHash", v.evidenceHash]]
      .some(([k, stored]) => lower(log.args[k]) !== lower(stored)) || (log && (log.args.pass !== v.pass || Number(log.args.score) !== Number(v.score)))) {
      throw new Error(`the VerdictSubmitted log for job ${jobId} does not match the stored verdict`);
    }
    verdict = { jobId: String(v.jobId), criteriaHash: lower(v.criteriaHash), deliverable: lower(v.deliverable), score: String(v.score),
      threshold: String(v.threshold), pass: v.pass, evidenceHash: lower(v.evidenceHash), timestamp: String(v.timestamp),
      txHash: log ? lower(log.transactionHash) : null, blockNumber: log ? String(log.blockNumber) : null };
  }

  // Every read above was pinned to `at`; if the block at that height changed meanwhile, start over.
  const again = await pub.getBlock({ blockNumber: at });
  if (lower(again.hash) !== lower(block.hash)) throw new Error(`the chain reorganized at block ${at} while reading; run again`);

  const snapshot = {
    schema: "rvr.judge-protocol.chain-snapshot.v0",
    chainId: String(chainId),
    acp: lower(config.acpAddress),
    evaluatorContract: lower(config.judgeAddress),
    readAt: { blockNumber: String(at), blockHash: lower(block.hash) },
    job: { id: String(job.id), client: lower(job.client), provider: lower(job.provider), evaluator: lower(job.evaluator),
      description: job.description, budget: String(job.budget), expiredAt: String(job.expiredAt), status: String(job.status), hook: lower(job.hook) },
    submission: { jobId: String(submission.jobId), txHash: lower(submission.txHash), blockNumber: String(submission.blockNumber),
      blockHash: lower(submission.blockHash), provider: lower(submission.provider), deliverable: lower(submission.deliverable) },
    verdict,
  };
  return { snapshot, content, bytes: rvrCanonical(snapshot) };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null; };
  const jobIdArg = argv[0] ?? "";
  if (!/^[0-9]{1,30}$/.test(jobIdArg) || BigInt(jobIdArg) === 0n) {
    console.error("usage: node src/rvr-snapshot.mjs <jobId> [--submit-tx 0x...] [--out <dir>] [--rpc <url>]");
    process.exit(2);
  }
  const jobId = BigInt(jobIdArg);
  const out = opt("--out") || ".";
  const publicClient = createPublicClient({ chain: config.chain, transport: http(opt("--rpc") || config.rpcUrl) });
  const { snapshot, content, bytes } = await freezeRuling({ publicClient, jobId, submitTx: opt("--submit-tx") || undefined });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `job-${jobId}.snapshot.json`), bytes);
  fs.writeFileSync(path.join(out, `job-${jobId}.deliverable.bin`), content);
  console.log(JSON.stringify({ jobId: String(jobId), readAt: snapshot.readAt, submission: snapshot.submission.txHash,
    verdict: snapshot.verdict && { pass: snapshot.verdict.pass, score: snapshot.verdict.score, txHash: snapshot.verdict.txHash },
    verdictLogFound: snapshot.verdict ? snapshot.verdict.txHash !== null : null, deliverableBytes: content.length }));
}

// Started as a script (also through a symlink: import.meta.url is the resolved path), not imported.
const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1] ?? "")).href; } catch { return null; } })();
if (invoked === import.meta.url) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
