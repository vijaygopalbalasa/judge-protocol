// The judge engine: watch → resolve → check → sign → submit.
import { createPublicClient, http, parseAbiItem, keccak256, decodeFunctionData, hexToString } from "viem";
import { config } from "./config.js";
import { acpAbi, judgeAbi, STATUS } from "./abi.js";
import { extractCriteria, criteriaHash } from "./criteria.js";
import { extractDeliverableURI, resolveDeliverable, storeEvidence, evidenceHashOf } from "./evidence.js";
import { runAllChecks, validateCriteria, InvalidCriteriaError } from "./checkers/index.js";
import { makeClients, signVerdict, submitVerdictOnChain } from "./signer.js";
import { loadCursor, saveCursor } from "./cursor.js";

const processed = new Set();

// Live service state surfaced by the HTTP /healthz endpoint.
export const serviceState = {
  startedAt: new Date().toISOString(),
  cursor: null,
  lastPollAt: null,
  lastError: null,
};

// Max block span per getLogs call. Catch-up after downtime iterates in chunks
// so a single huge-range query can't hit RPC range/rate limits.
const MAX_BLOCK_RANGE = 10_000n;

// Minimum job budget (in USDC 6-dp units) we will spend gas to judge. Anyone can
// name our address as evaluator on a zero-value job; without this floor they can
// make the relayer pay gas for unlimited junk verdicts. 0.01 USDC default.
export const MIN_BUDGET = BigInt(process.env.MIN_JOB_BUDGET || 10_000);

// ACP submit(jobId, bytes32 deliverable, bytes optParams): used to recover the
// PROVIDER-authored deliverable URI from their own submit-transaction calldata,
// rather than trusting the client-authored job description.
const acpSubmitAbi = [{
  name: "submit", type: "function", stateMutability: "nonpayable",
  inputs: [
    { name: "jobId", type: "uint256" },
    { name: "deliverable", type: "bytes32" },
    { name: "optParams", type: "bytes" },
  ],
  outputs: [],
}];

/**
 * Recover the deliverable URI. Preference order:
 *   1. the provider's `submit` calldata optParams (provider-authored, correct)
 *   2. a `deliverableURI:` line in the job description (client-authored, legacy)
 * Returns { uri, authoredBy }.
 */
export async function resolveDeliverableSource(publicClient, submitTxHash, description) {
  if (submitTxHash) {
    try {
      const tx = await publicClient.getTransaction({ hash: submitTxHash });
      const { args } = decodeFunctionData({ abi: acpSubmitAbi, data: tx.input });
      const optParams = args?.[2];
      if (optParams && optParams !== "0x") {
        // optParams carries the provider's deliverable URI as UTF-8 bytes,
        // optionally prefixed "deliverableURI: ".
        let s = "";
        try { s = hexToString(optParams); } catch { s = ""; }
        const uri = extractDeliverableURI(s) || (isUri(s.trim()) ? s.trim() : null);
        if (uri) return { uri, authoredBy: "provider" };
      }
    } catch { /* fall through to description */ }
  }
  const fromDesc = extractDeliverableURI(description);
  if (fromDesc) return { uri: fromDesc, authoredBy: "client" };
  return { uri: null, authoredBy: null };
}

function isUri(s) {
  return s.startsWith("data:") || s.startsWith("ipfs://") || s.startsWith("http://") || s.startsWith("https://");
}

/** Rule on a job end to end: prepare the verdict, then sign and settle it. */
export async function evaluateJob(jobId, deliverableHash, clients, submitTxHash) {
  const prepared = await prepareRuling(jobId, deliverableHash, clients, submitTxHash);
  if (prepared.outcome !== "ready") return prepared;
  return settleRuling(prepared, clients, clients.relayRetry);
}

/**
 * Everything up to the verdict, without signing, storing or sending anything:
 * read the job, validate the criteria, load the provider's deliverable, check
 * it against the commitment and run the checks. A paid ruling takes payment
 * between this and settleRuling(), so nothing is signed for a payment that
 * did not settle.
 */
export async function prepareRuling(jobId, deliverableHash, clients, submitTxHash) {
  const { publicClient, signerAccount } = clients;
  const startedAt = Date.now();
  const log = (...a) => console.log(`[job ${jobId}]`, ...a);

  // 1. Read the job; only judge jobs that name us and are Submitted.
  const job = await publicClient.readContract({
    address: config.acpAddress, abi: acpAbi, functionName: "getJob", args: [jobId],
  });
  const evaluator = job.evaluator ?? job[3];
  const status = Number(job.status ?? job[7]);
  const description = job.description ?? job[4];
  const budget = BigInt(job.budget ?? job[5] ?? 0n);
  if (evaluator.toLowerCase() !== config.judgeAddress.toLowerCase()) {
    return { outcome: "not-ours" }; // silent: the vast majority of chain traffic
  }
  if (STATUS[status] !== "Submitted") {
    log(`skip: status ${STATUS[status]}`);
    return { outcome: "skip", reason: `status is ${STATUS[status]}, not Submitted` };
  }
  // Gas-drain guard: refuse to spend a verdict tx on a sub-threshold job.
  if (budget < MIN_BUDGET) {
    log(`skip: budget ${budget} < MIN_BUDGET ${MIN_BUDGET} (spam guard)`);
    return { outcome: "skip", reason: `budget ${budget} is below the minimum of ${MIN_BUDGET} (USDC 6-decimal units)` };
  }

  // 2. Criteria (committed in the immutable job description).
  const criteria = extractCriteria(description);
  if (!criteria) {
    log("abstain: no judge-criteria block in description");
    return { outcome: "abstain", reason: "no judge-criteria block in the job description" };
  }
  // Validate before hashing: malformed criteria abstain here, and nothing can
  // nest deep enough to overflow the hash.
  const valid = validateCriteria(criteria);
  if (!valid.valid) {
    log(`abstain: invalid criteria: ${valid.reason}`);
    return { outcome: "abstain", reason: `invalid criteria: ${valid.reason}` };
  }
  const cHash = criteriaHash(criteria);

  // 3. Resolve the PROVIDER-authored deliverable and bind it to the on-chain
  //    commitment. If the content does not hash to what the provider submitted,
  //    we refuse to judge (never grade unverified/substituted content).
  const { uri, authoredBy } = await resolveDeliverableSource(publicClient, submitTxHash, description);
  if (!uri) {
    log("abstain: no deliverable URI (provider optParams or description)");
    return { outcome: "abstain", reason: "no deliverable URI in the provider's submit() or the job description" };
  }
  let deliverable;
  try {
    deliverable = await resolveDeliverable(uri);
  } catch (e) {
    // A remote host that is down, slow or refusing is a transient condition:
    // retry later. A data: URI or an unsupported scheme will never load:
    // abstain. Details stay in the server log, never in the reply, so the
    // judge is not an oracle for internal network probing.
    log(`deliverable resolution failed: ${e.message}`);
    if (/^(https?|ipfs):\/\//i.test(uri)) {
      return { outcome: "retry", reason: "the deliverable host could not be reached or refused the request; try again later" };
    }
    return { outcome: "abstain", reason: /unsupported deliverable URI scheme/.test(e.message)
      ? "unsupported deliverable URI scheme (use data:, https:// or ipfs://)"
      : "the deliverable could not be decoded or exceeds the size limit" };
  }
  const contentHash = keccak256(deliverable.content);
  if (contentHash.toLowerCase() !== String(deliverableHash).toLowerCase()) {
    log(`abstain: deliverable hash mismatch: ${contentHash} != committed ${deliverableHash}`);
    return { outcome: "abstain", reason: `deliverable hash mismatch: content hashes to ${contentHash}, provider committed ${deliverableHash}` };
  }
  log(`deliverable resolved (${authoredBy}-authored, ${deliverable.source}), hash matches commitment`);

  // 4. Run deterministic checkers. Malformed criteria → abstain (never score).
  let checkResult;
  try {
    checkResult = await runAllChecks(criteria, deliverable);
  } catch (e) {
    if (e instanceof InvalidCriteriaError) {
      log(`abstain: invalid criteria: ${e.message}`);
      return { outcome: "abstain", reason: `invalid criteria: ${e.message}` };
    }
    throw e;
  }
  const { results, score, pass, threshold } = checkResult;
  log(`checks done: score=${score} threshold=${threshold} pass=${pass}`);

  // 5. Build + store evidence, derive evidenceHash (over the recomputable core).
  const verdictObj = {
    jobId: jobId.toString(),
    criteriaHash: cHash,
    deliverable: deliverableHash,
    criteria,
    results,
    score,
    pass,
    threshold,
    deliverableSource: deliverable.source,
    deliverableAuthoredBy: authoredBy,
    deliverableURI: uri,               // how to retrieve the deliverable (for verify)
    deliverableURL: deliverable.url || null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    judge: signerAccount.address,
  };
  return { outcome: "ready", jobId, verdictObj, criteriaHash: cHash, deliverable: deliverableHash, pass, score, threshold,
    evidenceHash: evidenceHashOf(verdictObj) };
}

// A revert is deterministic (the contract said no); anything else (an RPC
// hiccup, a timeout, a rate limit) is worth another try.
const isRevert = (e) => !!e?.reverted || /execution reverted|reverted with|ContractFunctionRevert/i.test(String(e?.message ?? e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Store the evidence, sign the verdict (EIP-712) and settle it on chain. */
export async function settleRuling(prepared, clients, { retries = 2, retryDelayMs = 1500 } = {}) {
  const { publicClient, signerAccount, relayerWallet } = clients;
  const log = (...a) => console.log(`[job ${prepared.jobId}]`, ...a);
  const { evidenceHash, file } = storeEvidence(prepared.verdictObj);
  log(`evidence stored: ${file} (hash ${evidenceHash.slice(0, 18)}…)`);
  const verdict = {
    jobId: prepared.jobId,
    criteriaHash: prepared.criteriaHash,
    deliverable: prepared.deliverable,
    score: prepared.score,
    threshold: prepared.threshold,
    pass: prepared.pass,
    evidenceHash,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
  };
  const sig = await signVerdict(signerAccount, verdict);
  const judged = (txHash) => ({ outcome: "judged", pass: prepared.pass, score: prepared.score, threshold: prepared.threshold, txHash, evidenceHash });
  for (let attempt = 0; ; attempt++) {
    try {
      const { hash } = await submitVerdictOnChain(relayerWallet, publicClient, verdict, sig);
      log(`verdict submitted: ${prepared.pass ? "COMPLETE" : "REJECT"} tx=${hash}`);
      return judged(hash);
    } catch (e) {
      if (isRevert(e)) throw e; // the contract refused; judgeNow reports a verdict someone else landed
      // The transaction may have landed even though the answer never came back: look before resending.
      const onChain = await publicClient.readContract({ address: config.judgeAddress, abi: judgeAbi, functionName: "getVerdict", args: [prepared.jobId] }).catch(() => null);
      if (onChain && BigInt(onChain.timestamp ?? 0) !== 0n && String(onChain.evidenceHash).toLowerCase() === evidenceHash.toLowerCase()) {
        log(`verdict confirmed on chain after: ${e.message}`);
        return judged(e.hash ?? null);
      }
      if (attempt >= retries) throw e;
      log(`verdict send failed (${String(e.message).slice(0, 120)}); retrying`);
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
}

/** One polling pass: find recent JobSubmitted events and evaluate them.
 *  Scans [fromBlock, tip] in MAX_BLOCK_RANGE chunks so long catch-ups stay
 *  within RPC range limits. Returns the tip block scanned. */
export async function pollOnce(clients, fromBlock, report) {
  const { publicClient, signerAccount, relayerWallet } = clients ?? makeClients();
  const latest = await publicClient.getBlockNumber();
  const event = parseAbiItem("event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)");
  for (let from = fromBlock; from <= latest; from += MAX_BLOCK_RANGE) {
    const to = from + MAX_BLOCK_RANGE - 1n < latest ? from + MAX_BLOCK_RANGE - 1n : latest;
    const logs = await publicClient.getLogs({
      address: config.acpAddress,
      event,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      const jobId = log.args.jobId;
      const key = jobId.toString();
      if (processed.has(key)) continue;
      processed.add(key);
      try {
        const o = await evaluateJob(jobId, log.args.deliverable, { publicClient, signerAccount, relayerWallet }, log.transactionHash);
        if (report && o && o.outcome !== "not-ours") report.push({ jobId, ...o });
        if (o && o.outcome === "retry") processed.delete(key); // transient: a later pass retries
      } catch (e) {
        console.error(`[job ${jobId}] evaluation error:`, e.message);
        if (report) report.push({ jobId, outcome: "error", reason: e.message });
        processed.delete(key); // transient failure, allow retry next pass
      }
    }
  }
  return latest;
}

export async function run() {
  const clients = makeClients();
  console.log(`Judge service up. chain=${config.chain.id} judge=${config.judgeAddress}`);
  console.log(`ACP=${config.acpAddress}`);
  const latest = await clients.publicClient.getBlockNumber();
  // Resume from the persisted cursor; fall back to a bounded lookback on
  // first boot (or if the cursor file is missing/corrupt).
  const saved = loadCursor(config.cursorFile);
  let fromBlock = saved ?? (latest > 5000n ? latest - 5000n : 0n);
  console.log(saved !== null
    ? `resuming from persisted cursor: block ${fromBlock}`
    : `no cursor, starting from block ${fromBlock} (bounded lookback)`);
  for (;;) {
    try {
      const tip = await pollOnce(clients, fromBlock);
      fromBlock = tip + 1n;
      saveCursor(config.cursorFile, fromBlock);
      serviceState.cursor = fromBlock;
      serviceState.lastPollAt = new Date().toISOString();
      serviceState.lastError = null;
    } catch (e) {
      serviceState.lastError = e.message;
      console.error("poll error:", e.message);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}
