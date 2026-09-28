// Census statistics for an ERC-8183 contract: a pure function of the job
// records, so anyone with the same chain data gets the same numbers.
//
// A record is { id, client, provider, evaluator, budget, status, hook }, with
// addresses as hex strings, budget in USDC base units (6 decimals) as a
// decimal string, and status as the contract's enum index.
//
// Definitions:
//   self-evaluated   the evaluator is the job's client or its provider
//   third party      the evaluator is neither, and is not the zero address
//   paid through     third party, funded (budget > 0) and Completed
//   independent      an evaluator that never appears as a client or provider
//                    on any job, with at least `minPayingClients` distinct
//                    clients who funded a job naming it

const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

/**
 * getJob's return tuple for each contract the census reads. Both use the status enum above.
 *   circle       Circle's ERC-8183 contract (the reference layout)
 *   virtuals-v3  Virtuals' AgenticCommerceV3 (Base and Arc mainnet): other order, no id
 */
export const JOB_LAYOUTS = {
  circle: [["id", "uint256"], ["client", "address"], ["provider", "address"], ["evaluator", "address"], ["description", "string"],
    ["budget", "uint256"], ["expiredAt", "uint256"], ["status", "uint8"], ["hook", "address"]],
  "virtuals-v3": [["client", "address"], ["status", "uint8"], ["provider", "address"], ["expiredAt", "uint48"], ["evaluator", "address"],
    ["hook", "address"], ["budget", "uint256"], ["description", "string"]],
};

/** One census record from a decoded getJob result, whatever the layout; `id` is the job that was asked for. */
export function recordFromJob(job, id) {
  if (job.id !== undefined && Number(job.id) !== id) throw new Error(`job ${id}: the contract answered for job ${job.id}`);
  return { id, client: job.client, provider: job.provider, evaluator: job.evaluator, budget: job.budget.toString(), status: Number(job.status), hook: job.hook };
}
const ZERO = "0x0000000000000000000000000000000000000000";
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** USDC base units (6 decimals) to dollars, rounded to the nearest cent. */
const usdc = (units) => {
  const cents = (units + 5_000n) / 10_000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};

function normalize(r, seen) {
  const where = `record ${r?.id ?? "?"}`;
  if (!r || !Number.isSafeInteger(r.id) || r.id < 1) throw new Error(`${where}: id must be a positive integer`);
  for (const k of ["client", "provider", "evaluator", "hook"]) {
    if (typeof r[k] !== "string" || !ADDR.test(r[k])) throw new Error(`${where}: ${k} is not an address`);
  }
  if (typeof r.budget !== "string" || !/^[0-9]+$/.test(r.budget)) throw new Error(`${where}: budget must be a non-negative integer string`);
  if (!Number.isInteger(r.status) || r.status < 0) throw new Error(`${where}: status must be a non-negative integer`);
  if (seen.has(r.id)) throw new Error(`${where}: duplicate job id`);
  seen.add(r.id);
  return { id: r.id, client: r.client.toLowerCase(), provider: r.provider.toLowerCase(), evaluator: r.evaluator.toLowerCase(),
    hook: r.hook.toLowerCase(), budget: BigInt(r.budget), status: r.status };
}

export function analyzeCensus(records, { minPayingClients = 4, judges = [] } = {}) {
  const seen = new Set();
  const jobs = records.map((r) => normalize(r, seen));
  const evaluator = { client: 0, provider: 0, zero: 0, thirdParty: 0 };
  const statuses = {};
  const funded = [];
  const parties = new Set();     // every address that acted as a client or provider
  const clients = new Set();
  const thirdPartyEvaluators = new Set();
  const paid = { jobs: 0, evaluators: new Set(), total: 0n };
  const payingClientsOf = new Map(); // evaluator -> Set(client) over funded third-party jobs
  const jobsOf = new Map();          // evaluator -> funded third-party job count
  let withHook = 0;

  for (const j of jobs) {
    parties.add(j.client); parties.add(j.provider); clients.add(j.client);
    const name = STATUS[j.status] ?? `Unknown(${j.status})`;
    statuses[name] = (statuses[name] ?? 0) + 1;
    if (j.budget > 0n) funded.push(j.budget);
    if (j.hook !== ZERO) withHook++;
    if (j.evaluator === ZERO) { evaluator.zero++; continue; }
    if (j.evaluator === j.client) { evaluator.client++; continue; }
    if (j.evaluator === j.provider) { evaluator.provider++; continue; }
    evaluator.thirdParty++;
    thirdPartyEvaluators.add(j.evaluator);
    if (j.budget > 0n) {
      if (!payingClientsOf.has(j.evaluator)) payingClientsOf.set(j.evaluator, new Set());
      payingClientsOf.get(j.evaluator).add(j.client);
      jobsOf.set(j.evaluator, (jobsOf.get(j.evaluator) ?? 0) + 1);
      if (STATUS[j.status] === "Completed") { paid.jobs++; paid.evaluators.add(j.evaluator); paid.total += j.budget; }
    }
  }

  funded.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const n = funded.length;
  const median = n === 0 ? null : n % 2 ? funded[(n - 1) / 2] : (funded[n / 2 - 1] + funded[n / 2]) / 2n;

  const independent = [...payingClientsOf.entries()]
    .filter(([e, cs]) => !parties.has(e) && cs.size >= minPayingClients)
    .map(([e, cs]) => ({ evaluator: e, payingClients: cs.size, jobs: jobsOf.get(e) }))
    .sort((x, y) => y.payingClients - x.payingClients || y.jobs - x.jobs || (x.evaluator < y.evaluator ? -1 : 1));

  const judgeStats = {};
  for (const addr of judges) {
    const mine = jobs.filter((j) => j.evaluator === addr.toLowerCase());
    judgeStats[addr] = { jobs: mine.length, distinctClients: new Set(mine.map((j) => j.client)).size };
  }

  return {
    jobs: jobs.length,
    evaluator,
    selfEvaluatedRate: jobs.length ? (evaluator.client + evaluator.provider) / jobs.length : 0,
    statuses,
    funded: n,
    medianFundedUSDC: median === null ? null : usdc(median),
    withHook,
    distinctClients: clients.size,
    thirdParty: {
      distinctEvaluators: thirdPartyEvaluators.size,
      paidThrough: { jobs: paid.jobs, distinctEvaluators: paid.evaluators.size, totalUSDC: usdc(paid.total) },
    },
    independent,
    judges: judgeStats,
  };
}

/** keccak256 of each event signature the log scan reads (pinned against viem in the tests). */
export const EVENT_TOPICS = {
  jobCreated: "0xb0f0239bfdd96453e24733e18bfc24b70d8fadf123dd977473518dd577ee79b9",         // JobCreated(uint256,address,address,address,uint256,address)
  hookWhitelistUpdated: "0x7ee54953080e392a475a25b6acacb85417ca4e1953293c90934233ca13612510", // HookWhitelistUpdated(address,bool)
  evaluatorFeePaid: "0x253dd534010ac976fa263caa123bae79b9c50292adf7ce67bdc5ec309f784e61",   // EvaluatorFeePaid(uint256,address,uint256)
  evaluatorFeeUpdated: "0x24fe03678743d8fe5f3d39d760da9fc7a5f3feea46847d91688ba8ef9e400d14", // EvaluatorFeeUpdated(uint256)
};
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_TOPIC = /^0x0{24}[0-9a-fA-F]{40}$/;

/** { jobId, evaluator, amount, block } from an EvaluatorFeePaid log, or null for any other log. */
export function feePaymentFromLog(log) {
  if (log.topics?.[0] !== EVENT_TOPICS.evaluatorFeePaid) return null;
  const [, jobTopic, evaluatorTopic] = log.topics;
  if (log.topics.length !== 3 || !WORD.test(jobTopic) || !ADDRESS_TOPIC.test(evaluatorTopic) || !WORD.test(log.data ?? "")) {
    throw new Error(`malformed EvaluatorFeePaid log at block ${log.blockNumber}`);
  }
  const jobId = BigInt(jobTopic);
  if (jobId < 1n || jobId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`malformed EvaluatorFeePaid log: job ${jobId}`);
  return { jobId: Number(jobId), evaluator: "0x" + evaluatorTopic.slice(26).toLowerCase(), amount: BigInt(log.data), block: Number(BigInt(log.blockNumber)) };
}

/** { feeBP, block } from an EvaluatorFeeUpdated log, or null for any other log. */
export function feeUpdateFromLog(log) {
  if (log.topics?.[0] !== EVENT_TOPICS.evaluatorFeeUpdated) return null;
  if (log.topics.length !== 1 || !WORD.test(log.data ?? "")) throw new Error(`malformed EvaluatorFeeUpdated log at block ${log.blockNumber}`);
  return { feeBP: Number(BigInt(log.data)), block: Number(BigInt(log.blockNumber)) };
}

/**
 * The evaluator fees a contract actually paid, from its EvaluatorFeePaid events, by who received
 * them: the job's client, its provider, or a third party. A payment whose job is not in the records,
 * whose recipient is not that job's evaluator, or that went to the zero address is counted in
 * `unmatched`, never put in a class.
 */
export function tallyEvaluatorFees(payments, records) {
  const seen = new Set();
  const byId = new Map(records.map((r) => normalize(r, seen)).map((j) => [j.id, j]));
  const classes = { client: [0, 0n, new Set()], provider: [0, 0n, new Set()], thirdParty: [0, 0n, new Set()] };
  let unmatched = 0;
  for (const p of payments) {
    if (!Number.isSafeInteger(p.jobId) || p.jobId < 1) throw new Error(`fee payment: jobId must be a positive integer`);
    if (typeof p.evaluator !== "string" || !ADDR.test(p.evaluator)) throw new Error(`fee payment for job ${p.jobId}: evaluator is not an address`);
    if (typeof p.amount !== "bigint" || p.amount < 0n) throw new Error(`fee payment for job ${p.jobId}: amount must be a non-negative bigint`);
    const j = byId.get(p.jobId);
    const to = p.evaluator.toLowerCase();
    if (!j || to !== j.evaluator || to === ZERO) { unmatched++; continue; }
    const c = classes[to === j.client ? "client" : to === j.provider ? "provider" : "thirdParty"];
    c[0]++; c[1] += p.amount; c[2].add(p.jobId);
  }
  const byRecipient = Object.fromEntries(Object.entries(classes).map(([k, [n, units, jobs]]) =>
    [k, { payments: n, jobs: jobs.size, units: units.toString(), usdc: usdc(units) }]));
  return { payments: payments.length, unmatched, byRecipient };
}

/**
 * The log scan's result. The control: every range was read and the JobCreated events found equal the
 * job counter at the scan's last block. Only then are counts taken from the logs (hook whitelist
 * events, evaluator fees) whole; otherwise the fee tally is null and callers report hooks as unknown.
 */
export function summarizeLogScan({ fromBlock, toBlock, totals, failedRanges, jobCounter, records }) {
  const created = totals.created ?? 0;
  const controlPassed = failedRanges.length === 0 && created === jobCounter;
  const logScan = { fromBlock, toBlock, jobCreatedLogs: created, hookWhitelistLogs: totals.hooks ?? 0, failedRanges, controlPassed };
  if (!controlPassed) return { logScan, evaluatorFees: null };
  const payments = totals.feePayments ?? [];
  return { logScan, evaluatorFees: { ...tallyEvaluatorFees(payments, records),
    feeUpdates: [...(totals.feeUpdates ?? [])].sort((x, y) => x.block - y.block),
    firstPaymentBlock: payments.length ? Math.min(...payments.map((p) => p.block)) : null } };
}

/**
 * Read every id through readBatch(ids) -> records (in the same order), in
 * batches, a few at a time. A batch that fails, or answers with the wrong
 * jobs, is retried, then split in half down to single ids. An id that still
 * fails on its own is reported in `failed`, never dropped silently.
 * onRecords receives each batch's records as they arrive.
 */
export async function fetchAll(ids, readBatch, { batch = 100, concurrency = 2, retries = 2, retryDelayMs = 500, onRecords = () => {} } = {}) {
  const failed = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function read(chunk) {
    for (let attempt = 0; ; attempt++) {
      try {
        const recs = await readBatch(chunk);
        if (!Array.isArray(recs) || recs.length !== chunk.length || recs.some((r, i) => r?.id !== chunk[i])) {
          throw new Error("the batch answered with the wrong jobs");
        }
        return recs;
      } catch {
        if (attempt < retries) { await sleep(retryDelayMs * 2 ** attempt); continue; }
        if (chunk.length === 1) { failed.push(chunk[0]); return []; }
        const mid = Math.ceil(chunk.length / 2);
        return [...(await read(chunk.slice(0, mid))), ...(await read(chunk.slice(mid)))];
      }
    }
  }
  const chunks = [];
  for (let i = 0; i < ids.length; i += batch) chunks.push(ids.slice(i, i + batch));
  let next = 0;
  const worker = async () => { while (next < chunks.length) onRecords(await read(chunks[next++])); };
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return { failed: failed.sort((x, y) => x - y) };
}

/**
 * Scan blocks [from, to] through readRange(a, b) -> { counter: n, ... } in
 * spans, a few at a time. A range that fails is retried, then split in half
 * down to single blocks; one that still fails is reported in `failed`. The
 * counters of every successful range are summed into `totals`, and list
 * results are concatenated.
 */
export async function scanRanges(from, to, readRange, { span = 10_000, concurrency = 3, retries = 2, retryDelayMs = 500 } = {}) {
  const failed = [];
  const totals = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const add = (counts) => { for (const [k, v] of Object.entries(counts)) totals[k] = Array.isArray(v) ? (totals[k] ?? []).concat(v) : (totals[k] ?? 0) + v; };
  async function scan(a, b) {
    for (let attempt = 0; ; attempt++) {
      try { add(await readRange(a, b)); return; }
      catch {
        if (attempt < retries) { await sleep(retryDelayMs * 2 ** attempt); continue; }
        if (a === b) { failed.push([a, b]); return; }
        const mid = Math.floor((a + b) / 2);
        await scan(a, mid);
        await scan(mid + 1, b);
        return;
      }
    }
  }
  const ranges = [];
  for (let a = from; a <= to; a += span) ranges.push([a, Math.min(a + span - 1, to)]);
  let next = 0;
  const worker = async () => { while (next < ranges.length) { const [a, b] = ranges[next++]; await scan(a, b); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));
  return { totals, failed: failed.sort((x, y) => x[0] - y[0]) };
}
