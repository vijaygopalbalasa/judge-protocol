// The hosted judge's two entry points, framework-agnostic:
//
//   judgeNow({ jobId, submitTx? })  rule on one job now, on request. Anyone may
//                                   ask: the ruling is a deterministic function
//                                   of the committed criteria and the provider's
//                                   deliverable, so it does not matter who asks.
//   sweepRecent(deps, opts)         the safety net: rule on every pending job
//                                   in a recent block window (daily cron).
//
// Both only ever act on jobs that name this judge as evaluator, are Submitted,
// and have no verdict yet. Everything else is reported, never guessed.
import { parseAbiItem, decodeEventLog } from "viem";
import { config } from "./config.js";
import { acpAbi, judgeAbi, STATUS } from "./abi.js";
import { prepareRuling, settleRuling, offerToErc8412, attesterFor, pollOnce, isRevert, MIN_BUDGET } from "./engine.js";
import { extractCriteria, criteriaHash } from "./criteria.js";
import { validateCriteria } from "./checkers/index.js";
import { makeClients as defaultMakeClients, makePublicClient as defaultMakePublicClient } from "./signer.js";

const JOB_SUBMITTED = parseAbiItem("event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)");
const LOG_SPAN = 10_000n;          // the public RPC's eth_getLogs limit
// On-demand requests search only recent blocks (about 4 hours): bounded work
// per unauthenticated request. Older submissions: pass submitTx, or the daily
// sweep will find them.
const SEARCH_WINDOWS = 3;
const SEARCH_HOURS = Math.round((SEARCH_WINDOWS * 10_000 * 0.52) / 3600);
// The daily sweep's window: about 58 hours, so one skipped or late cron run
// still leaves no gap.
export const SWEEP_LOOKBACK_BLOCKS = 400_000n;

// Short in-instance memory of answers that cannot change soon (an abstention,
// or a transient failure), so a repeated request does not redo the work.
const recent = new Map();
const CACHE_MS = { abstained: 10 * 60_000, "retry-later": 60_000 };
function remember(key, status, body) {
  const ttl = CACHE_MS[body.result];
  if (ttl) recent.set(key, { status, body, until: Date.now() + ttl });
  if (recent.size > 500) recent.delete(recent.keys().next().value);
}
function recall(key) {
  const hit = recent.get(key);
  if (!hit) return null;
  if (hit.until < Date.now()) { recent.delete(key); return null; }
  return { status: hit.status, body: { ...hit.body, cached: true } };
}

const jsonable = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const reply = (status, body) => ({ status, body: jsonable(body) });

/** Circle's contract answers an unknown job id with an all-zero job, not a revert. */
const isNoJob = (job) => !job || /^0x0{40}$/i.test(String(job.client ?? "")) && /^0x0{40}$/i.test(String(job.evaluator ?? ""));
/** What a job that is not Submitted means for a ruling. */
const statusResult = (status) => status === "Open" || status === "Funded" ? "not-submitted" : status === "Expired" ? "expired" : "closed";

export function parseJobIdInput(v) {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^[0-9]{1,30}$/.test(s)) return null;
  const n = BigInt(s);
  return n > 0n ? n : null;
}

function clientsFrom(deps) {
  if (deps.clients) return deps.clients;
  return (deps.makeClients || defaultMakeClients)();
}

async function readVerdict(publicClient, jobId) {
  const v = await publicClient.readContract({ address: config.judgeAddress, abi: judgeAbi, functionName: "getVerdict", args: [jobId] });
  return v && BigInt(v.timestamp ?? 0) !== 0n ? v : null;
}

/** Find the provider's JobSubmitted log for this job: from a tx hint, or by a bounded backward search. */
export async function findSubmission(publicClient, jobId, submitTx) {
  if (submitTx) {
    let receipt;
    try { receipt = await publicClient.getTransactionReceipt({ hash: submitTx }); } catch { return null; }
    for (const l of receipt.logs || []) {
      if (String(l.address).toLowerCase() !== config.acpAddress.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: [JOB_SUBMITTED], data: l.data, topics: l.topics });
        if (ev.args.jobId === jobId) return { deliverable: ev.args.deliverable, txHash: submitTx };
      } catch { /* a different event */ }
    }
    return null;
  }
  const latest = await publicClient.getBlockNumber();
  for (let w = 0n; w < BigInt(SEARCH_WINDOWS); w++) {
    const to = latest - LOG_SPAN * w;
    if (to < 1n) break;
    const from = to >= LOG_SPAN ? to - LOG_SPAN + 1n : 1n;
    const logs = await publicClient.getLogs({ address: config.acpAddress, event: JOB_SUBMITTED, args: { jobId }, fromBlock: from, toBlock: to });
    if (logs.length) {
      const l = logs[logs.length - 1];
      return { deliverable: l.args.deliverable, txHash: l.transactionHash };
    }
  }
  return null;
}

/**
 * Rule on one job now. `deps.beforeSettle(prepared)`, if given, runs after the
 * verdict is ready and before anything is signed; returning { ok: false, status,
 * body } stops there (the paid path takes payment in this hook).
 */
export async function judgeNow(input = {}, deps = {}) {
  const jobId = parseJobIdInput(input.jobId);
  if (jobId === null) return reply(400, { error: "jobId must be a positive integer" });
  if (input.submitTx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(String(input.submitTx))) {
    return reply(400, { error: "submitTx must be a 32-byte transaction hash" });
  }
  let clients;
  try { clients = clientsFrom(deps); } catch (e) {
    return reply(503, { error: "the judge signer is not configured on this deployment" });
  }
  try {
    return await ruleOn(jobId, input, clients, deps);
  } catch (e) {
    // A chain read failed (rate limit, RPC outage): temporary, never a crash.
    return reply(503, { result: "retry-later", jobId, reason: "could not read Arc testnet right now; try again shortly" });
  }
}

async function ruleOn(jobId, input, clients, deps) {
  const { publicClient } = clients;
  // An unknown id reads as an all-zero job, so a read that throws is the RPC
  // failing: judgeNow answers "retry later", never "no such job".
  const job = await publicClient.readContract({ address: config.acpAddress, abi: acpAbi, functionName: "getJob", args: [jobId] });
  if (isNoJob(job)) return reply(404, { result: "not-found", error: "no such job on the ACP contract" });
  if (String(job.evaluator).toLowerCase() !== config.judgeAddress.toLowerCase()) {
    return reply(200, { result: "not-ours", jobId, evaluator: job.evaluator });
  }
  const existing = await readVerdict(publicClient, jobId);
  if (existing) return reply(200, { result: "already-judged", jobId, verdict: existing });
  const status = STATUS[Number(job.status)];
  if (status !== "Submitted") return reply(200, { result: statusResult(status), jobId, status });

  const key = jobId.toString();
  const cached = recall(key);
  if (cached) return cached;

  const sub = await findSubmission(publicClient, jobId, input.submitTx);
  if (!sub) {
    return reply(404, { result: "submission-not-found", jobId,
      error: `no JobSubmitted event for this job in the last ~${SEARCH_HOURS} hours; pass submitTx (the provider's submit transaction hash) to rule on an older submission (the daily sweep also finds submissions from the last ~2 days)` });
  }

  let outcome, prepared;
  try {
    prepared = await prepareRuling(jobId, sub.deliverable, clients, sub.txHash);
    if (prepared.outcome === "ready") {
      const refused = await contractRefusal(publicClient, jobId, prepared.criteriaHash, clients.signerAccount.address);
      if (refused) return refused;
    }
    if (prepared.outcome === "ready" && deps.beforeSettle) {
      const gate = await deps.beforeSettle(prepared);
      if (!gate || gate.ok !== true) return reply(gate?.status ?? 402, gate?.body ?? { result: "payment-failed", jobId });
    }
    outcome = prepared.outcome === "ready"
      ? await settleRuling(prepared, clients, deps.relayRetryDelayMs !== undefined ? { retryDelayMs: deps.relayRetryDelayMs } : undefined)
      : prepared;
  } catch (e) {
    // Most often a concurrent caller settled first; report their verdict.
    const now = await readVerdict(publicClient, jobId).catch(() => null);
    if (now) return reply(200, { result: "already-judged", jobId, verdict: now });
    return reply(502, { result: "error", jobId, reverted: isRevert(e), error: String(e.message || e).slice(0, 300) });
  }
  if (!outcome) return reply(500, { result: "error", jobId, error: "no outcome" });
  if (outcome.outcome === "judged") {
    const { pass, score, threshold, txHash, evidenceHash } = outcome;
    const erc8412 = await offerToErc8412(prepared, outcome, deps.attest !== undefined ? deps.attest : attesterFor(clients));
    // The documents can embed a large deliverable; GET /api/erc8412 serves them rebuilt from chain.
    const { documents, ...attestation } = erc8412 ?? {};
    return reply(200, { result: "judged", jobId, pass, score, threshold, txHash, evidenceHash, submitTx: sub.txHash, ...(erc8412 ? { erc8412: attestation } : {}) });
  }
  if (outcome.outcome === "abstain" || outcome.outcome === "retry") {
    const r = outcome.outcome === "abstain"
      ? reply(422, { result: "abstained", jobId, reason: outcome.reason })
      : reply(503, { result: "retry-later", jobId, reason: outcome.reason });
    remember(key, r.status, r.body);
    return r;
  }
  if (outcome.outcome === "skip") return reply(200, { result: "skipped", jobId, reason: outcome.reason });
  return reply(200, { result: outcome.outcome, jobId });
}

/**
 * Cheap checks, before anyone is asked to pay: would the judge actually rule
 * on this job? Returns null if yes, or the answer to give instead.
 */
export async function rulingPrecheck(input = {}, deps = {}) {
  const jobId = parseJobIdInput(input.jobId);
  if (jobId === null) return reply(400, { error: "jobId must be a positive integer" });
  let clients;
  try { clients = clientsFrom(deps); } catch {
    return reply(503, { error: "the judge signer is not configured on this deployment" });
  }
  const publicClient = deps.clients ? deps.clients.publicClient : (deps.publicClient || (deps.makePublicClient || defaultMakePublicClient)());
  let job;
  try {
    job = await publicClient.readContract({ address: config.acpAddress, abi: acpAbi, functionName: "getJob", args: [jobId] });
  } catch {
    return reply(503, { result: "retry-later", jobId, reason: "could not read Arc testnet right now; try again shortly" });
  }
  if (BigInt(job.budget ?? 0n) < MIN_BUDGET) {
    return reply(200, { result: "skipped", jobId, reason: `budget ${job.budget} is below the minimum of ${MIN_BUDGET} (USDC 6-decimal units)` });
  }
  const criteria = extractCriteria(job.description);
  if (!criteria) return reply(422, { result: "abstained", jobId, reason: "no judge-criteria block in the job description" });
  const v = validateCriteria(criteria);
  if (!v.valid) return reply(422, { result: "abstained", jobId, reason: `invalid criteria: ${v.reason}` });
  try {
    return await contractRefusal(publicClient, jobId, criteriaHash(criteria), clients.signerAccount.address);
  } catch {
    return reply(503, { result: "retry-later", jobId, reason: "could not read Arc testnet right now; try again shortly" });
  }
}

/**
 * The contract's own refusals that do not depend on the signature. Checked
 * before anyone is asked to pay and again right before a payment settles, so
 * nobody pays for a verdict the contract would refuse. Null means none apply.
 */
async function contractRefusal(publicClient, jobId, cHash, signer) {
  const read = (functionName, args) => publicClient.readContract({ address: config.judgeAddress, abi: judgeAbi, functionName, ...(args ? { args } : {}) });
  const [paused, authorized, registered] = await Promise.all([read("paused"), read("isSigner", [signer]), read("jobCriteria", [jobId])]);
  if (paused) return reply(503, { result: "retry-later", jobId, reason: "the judge contract is paused right now; try again later" });
  if (!authorized) return reply(503, { result: "retry-later", jobId, reason: "the judge's signer is not authorized on chain right now; try again later" });
  if (!/^0x0{64}$/i.test(String(registered)) && String(registered).toLowerCase() !== String(cHash).toLowerCase()) {
    return reply(422, { result: "abstained", jobId, reason: "different criteria are registered on chain for this job, so the contract would refuse any verdict on the description's criteria" });
  }
  return null;
}

/** Read-only status for GET requests: never signs anything. */
export async function jobStatus(input = {}, deps = {}) {
  try {
    return await readStatus(input, deps);
  } catch {
    return reply(503, { result: "retry-later", jobId: String(input.jobId ?? ""), reason: "could not read Arc testnet right now; try again shortly" });
  }
}

async function readStatus(input, deps) {
  const jobId = parseJobIdInput(input.jobId);
  if (jobId === null) return reply(400, { error: "jobId must be a positive integer" });
  const publicClient = deps.clients ? deps.clients.publicClient : (deps.publicClient || (deps.makePublicClient || defaultMakePublicClient)());
  // A read that throws is the RPC failing (jobStatus answers "retry later").
  const job = await publicClient.readContract({ address: config.acpAddress, abi: acpAbi, functionName: "getJob", args: [jobId] });
  if (isNoJob(job)) return reply(404, { result: "not-found", jobId });
  if (String(job.evaluator).toLowerCase() !== config.judgeAddress.toLowerCase()) {
    return reply(200, { result: "not-ours", jobId, evaluator: job.evaluator });
  }
  const v = await readVerdict(publicClient, jobId);
  if (v) return reply(200, { result: "judged", jobId, verdict: v });
  const status = STATUS[Number(job.status)];
  return reply(200, { result: status === "Submitted" ? "pending" : statusResult(status), jobId, status });
}

export async function sweepRecent(deps = {}, { lookbackBlocks = SWEEP_LOOKBACK_BLOCKS } = {}) {
  const clients = clientsFrom(deps);
  const latest = await clients.publicClient.getBlockNumber();
  const from = latest > lookbackBlocks ? latest - lookbackBlocks + 1n : 1n;
  const report = [];
  const tip = await pollOnce(clients, from, report);
  const outcomes = report.map((o) => ({ ...o, jobId: String(o.jobId) }));
  return jsonable({ from, tip, judged: outcomes.filter((o) => o.outcome === "judged").length, outcomes });
}
