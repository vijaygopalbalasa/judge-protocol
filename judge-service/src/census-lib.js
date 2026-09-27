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
const ZERO = "0x0000000000000000000000000000000000000000";
const ADDR = /^0x[0-9a-fA-F]{40}$/;

const usdc = (units) => {
  const whole = units / 1_000_000n, frac = units % 1_000_000n;
  return `${whole}.${String(frac).padStart(6, "0").slice(0, 2)}`;
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
 * counters of every successful range are summed into `totals`.
 */
export async function scanRanges(from, to, readRange, { span = 10_000, concurrency = 3, retries = 2, retryDelayMs = 500 } = {}) {
  const failed = [];
  const totals = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const add = (counts) => { for (const [k, v] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + v; };
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
