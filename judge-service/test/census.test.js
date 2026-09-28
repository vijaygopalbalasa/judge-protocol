// The census statistics are a pure function of the job records, so every
// number we publish can be reproduced by anyone from the same chain data.
// These tests pin the definitions, including the cases that must NOT count.
import test from "node:test";
import assert from "node:assert/strict";

const { analyzeCensus } = await import("../src/census-lib.js");

const Z = "0x0000000000000000000000000000000000000000";
const a = (n) => "0x" + n.toString(16).padStart(40, "0");
const USDC = (x) => String(Math.round(x * 1e6));
const S = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 };
let nextId = 1;
const job = (o) => ({ id: nextId++, client: a(1), provider: a(2), evaluator: a(1), budget: "0", status: S.Open, hook: Z, ...o });

test("who evaluates: the client, the provider, nobody, or a third party", () => {
  const r = analyzeCensus([
    job({ evaluator: a(1) }),                // client grades itself
    job({ evaluator: a(2) }),                // provider grades itself
    job({ evaluator: Z }),                   // no evaluator
    job({ evaluator: a(9) }),                // third party
    job({ evaluator: a(9).toUpperCase().replace("0X", "0x") }), // same third party, other case
  ]);
  assert.equal(r.jobs, 5);
  assert.deepEqual(r.evaluator, { client: 1, provider: 1, zero: 1, thirdParty: 2 });
  assert.equal(r.selfEvaluatedRate, 0.4, "client or provider as evaluator");
  assert.equal(r.thirdParty.distinctEvaluators, 1, "addresses compare case-insensitively");
});

test("an independent evaluator never acts as a party and has several distinct paying clients", () => {
  const E1 = a(0xe1), E2 = a(0xe2), E3 = a(0xe3), E4 = a(0xe4);
  const jobs = [];
  for (let c = 0; c < 4; c++) jobs.push(job({ client: a(100 + c), provider: a(200), evaluator: E1, budget: USDC(1), status: S.Completed }));
  for (let i = 0; i < 4; i++) jobs.push(job({ client: a(300), provider: a(200), evaluator: E2, budget: USDC(1), status: S.Completed })); // one client, 4 jobs
  for (let c = 0; c < 4; c++) jobs.push(job({ client: a(400 + c), provider: a(200), evaluator: E3, budget: USDC(1), status: S.Completed }));
  jobs.push(job({ client: E3, provider: a(200), evaluator: a(0xff) }));   // E3 also acts as a client: not independent
  for (let c = 0; c < 4; c++) jobs.push(job({ client: a(500 + c), provider: a(200), evaluator: E4, budget: "0" })); // nobody paid
  const r = analyzeCensus(jobs, { minPayingClients: 4 });
  assert.deepEqual(r.independent.map((x) => x.evaluator), [E1]);
  assert.equal(r.independent[0].payingClients, 4);
  assert.equal(r.independent[0].jobs, 4);
});

test("paid through means third-party evaluated, funded and completed", () => {
  const E = a(0xabc);
  const r = analyzeCensus([
    job({ evaluator: E, budget: USDC(1.5), status: S.Completed }),  // counts
    job({ evaluator: E, budget: USDC(2), status: S.Rejected }),     // refunded, not paid through
    job({ evaluator: E, budget: "0", status: S.Completed }),         // nothing was paid
    job({ evaluator: a(1), budget: USDC(9), status: S.Completed }),  // self-evaluated
  ]);
  assert.deepEqual(r.thirdParty.paidThrough, { jobs: 1, distinctEvaluators: 1, totalUSDC: "1.50" });
});

test("median funded budget ignores unfunded jobs; even counts take the middle two", () => {
  const odd = analyzeCensus([job({ budget: USDC(1) }), job({ budget: USDC(2) }), job({ budget: USDC(3) }), job({ budget: "0" })]);
  assert.equal(odd.funded, 3);
  assert.equal(odd.medianFundedUSDC, "2.00");
  const even = analyzeCensus([job({ budget: USDC(1) }), job({ budget: USDC(2) }), job({ budget: USDC(3) }), job({ budget: USDC(4) })]);
  assert.equal(even.medianFundedUSDC, "2.50");
  assert.equal(analyzeCensus([job({})]).medianFundedUSDC, null, "no funded jobs, no median");
});

test("statuses, hooks, clients, and the jobs that named a given judge", () => {
  const J = "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD";
  const r = analyzeCensus([
    job({ status: S.Completed, hook: a(0x77) }),
    job({ status: 9 }),
    job({ evaluator: J.toLowerCase(), client: a(700) }),
    job({ evaluator: J, client: a(700) }),
    job({ evaluator: J, client: a(701) }),
  ], { judges: [J] });
  assert.equal(r.statuses.Completed, 1);
  assert.equal(r.statuses["Unknown(9)"], 1);
  assert.equal(r.withHook, 1);
  assert.deepEqual(r.judges[J], { jobs: 3, distinctClients: 2 });
  assert.equal(r.distinctClients, 3);
});

test("records are validated: a malformed record is an error, never silently counted", () => {
  assert.throws(() => analyzeCensus([{ id: 1, client: "nope", provider: Z, evaluator: Z, budget: "0", status: 0, hook: Z }]), /record 1/);
  assert.throws(() => analyzeCensus([job({ budget: "-5" })]), /budget/);
  const first = job({});
  assert.throws(() => analyzeCensus([first, { ...first }]), /duplicate job id/);
});

test("fetchAll gets every job exactly once, splitting batches that fail, and reports the ids it could not read", async () => {
  const { fetchAll } = await import("../src/census-lib.js");
  const calls = [];
  const readBatch = async (ids) => {
    calls.push(ids.length);
    if (ids.length > 4) throw new Error("response too large");
    if (ids.includes(7) && ids.length > 1) throw new Error("job 7 has a huge description");
    if (ids.includes(13)) throw new Error("always fails");
    return ids.map((id) => ({ id }));
  };
  const got = [];
  const { failed } = await fetchAll([...Array(20).keys()].map((i) => i + 1), readBatch,
    { batch: 8, concurrency: 2, retries: 1, retryDelayMs: 0, onRecords: (rs) => got.push(...rs) });
  const ids = got.map((r) => r.id).sort((x, y) => x - y);
  assert.deepEqual(ids, [...Array(20).keys()].map((i) => i + 1).filter((i) => i !== 13), "every readable id once");
  assert.deepEqual(failed, [13], "the unreadable id is reported, never silently skipped");
  assert.ok(calls.some((n) => n === 1), "it split down to single reads");
});

test("scanRanges covers every block exactly once, splits ranges that fail, and reports the ones it cannot read", async () => {
  const { scanRanges } = await import("../src/census-lib.js");
  const covered = [];
  const readRange = async (from, to) => {
    if (to - from + 1 > 7) throw new Error("range too large");       // a provider's result cap
    if (from <= 50 && 50 <= to && to > from) throw new Error("too many logs in this range");
    if (from <= 77 && 77 <= to) throw new Error("block 77 always fails");
    covered.push([from, to]);
    return { hooks: from <= 42 && 42 <= to ? 1 : 0, created: to - from + 1 };
  };
  const out = await scanRanges(10, 100, readRange, { span: 16, concurrency: 3, retries: 1, retryDelayMs: 0 });
  const blocks = covered.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)).sort((x, y) => x - y);
  const want = Array.from({ length: 91 }, (_, i) => 10 + i).filter((b) => b !== 77);
  assert.deepEqual(blocks, want, "every readable block exactly once");
  assert.deepEqual(out.failed, [[77, 77]], "the unreadable range is reported");
  assert.equal(out.totals.hooks, 1);
  assert.equal(out.totals.created, 90);
});

test("USDC amounts round to the nearest cent, so a rerun prints what a report quotes", () => {
  const Z0 = "0x0000000000000000000000000000000000000000";
  const mk = (id, budget) => ({ id, client: "0x" + "1".repeat(40), provider: "0x" + "2".repeat(40), evaluator: "0x" + "9".repeat(40), budget, status: 3, hook: Z0 });
  assert.equal(analyzeCensus([mk(1, "1005000")]).thirdParty.paidThrough.totalUSDC, "1.01", "half a cent rounds up");
  assert.equal(analyzeCensus([mk(1, "1004999")]).thirdParty.paidThrough.totalUSDC, "1.00");
  assert.equal(analyzeCensus([mk(1, "22671466192")]).thirdParty.paidThrough.totalUSDC, "22671.47");
  assert.equal(analyzeCensus([mk(1, "999999")]).thirdParty.paidThrough.totalUSDC, "1.00", "carries into the dollars");
});

test("a Virtuals AgenticCommerceV3 job and a Circle job decode to the same record", async () => {
  // Virtuals' getJob returns (client, status, provider, expiredAt, evaluator, hook, budget,
  // description) and no id; Circle's returns (id, client, provider, evaluator, description,
  // budget, expiredAt, status, hook). The census must read both into one record shape.
  const { JOB_LAYOUTS, recordFromJob } = await import("../src/census-lib.js");
  const circle = { id: 7n, client: a(1), provider: a(2), evaluator: a(3), description: "d", budget: 1_500_000n, expiredAt: 99n, status: 3, hook: Z };
  const virtuals = { client: a(1), status: 3, provider: a(2), expiredAt: 99, evaluator: a(3), hook: Z, budget: 1_500_000n, description: "d" };
  const want = { id: 7, client: a(1), provider: a(2), evaluator: a(3), budget: "1500000", status: 3, hook: Z };
  assert.deepEqual(recordFromJob(circle, 7), want);
  assert.deepEqual(recordFromJob(virtuals, 7), want);
  assert.deepEqual(JOB_LAYOUTS["virtuals-v3"].map(([name]) => name), ["client", "status", "provider", "expiredAt", "evaluator", "hook", "budget", "description"]);
  assert.deepEqual(JOB_LAYOUTS.circle.map(([name]) => name), ["id", "client", "provider", "evaluator", "description", "budget", "expiredAt", "status", "hook"]);
  // A contract that answers for another job is an error, never a silently wrong record.
  assert.throws(() => recordFromJob({ ...circle, id: 8n }, 7), /answered for job 8/);
});

test("scanRanges keeps list results from every range exactly once, even after splitting", async () => {
  const { scanRanges } = await import("../src/census-lib.js");
  const readRange = async (from, to) => {
    if (to - from + 1 > 4) throw new Error("range too large");
    const found = [];
    for (let b = from; b <= to; b++) if (b % 5 === 0) found.push(b);
    return { created: to - from + 1, feePayments: found };
  };
  const out = await scanRanges(1, 30, readRange, { span: 10, concurrency: 2, retries: 0, retryDelayMs: 0 });
  assert.deepEqual([...out.totals.feePayments].sort((x, y) => x - y), [5, 10, 15, 20, 25, 30]);
  assert.equal(out.totals.created, 30, "numbers still add up");
  assert.deepEqual(out.failed, []);
});

test("an EvaluatorFeePaid log decodes to its job, recipient and amount; any other log is not a fee", async () => {
  const { EVENT_TOPICS, feePaymentFromLog, feeUpdateFromLog } = await import("../src/census-lib.js");
  const { keccak256, stringToBytes } = await import("viem");
  assert.equal(EVENT_TOPICS.evaluatorFeePaid, keccak256(stringToBytes("EvaluatorFeePaid(uint256,address,uint256)")));
  assert.equal(EVENT_TOPICS.evaluatorFeeUpdated, keccak256(stringToBytes("EvaluatorFeeUpdated(uint256)")));
  // A real log: Base tx 0xda628cb4..., block 44,430,237, job 4, a third-party evaluator paid 5% of 0.1 USDC.
  const log = { address: "0x238e541bfefd82238730d00a2208e5497f1832e0", blockNumber: "0x2a5f39d", logIndex: "0x191",
    data: "0x0000000000000000000000000000000000000000000000000000000000001388",
    topics: ["0x253dd534010ac976fa263caa123bae79b9c50292adf7ce67bdc5ec309f784e61",
      "0x0000000000000000000000000000000000000000000000000000000000000004",
      "0x0000000000000000000000001bd5fa478270bb6f03840fe515bc710b2bc4bbc9"] };
  assert.deepEqual(feePaymentFromLog(log), { jobId: 4, evaluator: "0x1bd5fa478270bb6f03840fe515bc710b2bc4bbc9", amount: 5000n, block: 44430237 });
  assert.equal(feePaymentFromLog({ ...log, topics: [EVENT_TOPICS.jobCreated, ...log.topics.slice(1)] }), null, "not a fee event");
  assert.throws(() => feePaymentFromLog({ ...log, topics: log.topics.slice(0, 2) }), /malformed EvaluatorFeePaid/);
  // The topic hash ignores which fields are indexed, so another contract's EvaluatorFeePaid can carry a
  // fourth topic; decoding it with this layout would be a guess.
  assert.throws(() => feePaymentFromLog({ ...log, topics: [...log.topics, log.data] }), /malformed EvaluatorFeePaid/);
  assert.throws(() => feePaymentFromLog({ ...log, data: "0x" }), /malformed EvaluatorFeePaid/);
  assert.throws(() => feePaymentFromLog({ ...log, topics: [log.topics[0], log.topics[1], "0x" + "f".repeat(24) + "1bd5fa478270bb6f03840fe515bc710b2bc4bbc9"] }),
    /malformed EvaluatorFeePaid/, "an address topic is zero-padded");
  // EvaluatorFeeUpdated(uint256 feeBP): the rate the contract pays evaluators from that block on.
  const update = { blockNumber: "0x2a5f000", logIndex: "0x1", topics: [EVENT_TOPICS.evaluatorFeeUpdated],
    data: "0x00000000000000000000000000000000000000000000000000000000000001f4" };
  assert.deepEqual(feeUpdateFromLog(update), { feeBP: 500, block: 44429312 });
  assert.equal(feeUpdateFromLog(log), null, "a payment is not a rate change");
  assert.throws(() => feeUpdateFromLog({ ...update, data: "0x01" }), /malformed EvaluatorFeeUpdated/);
});

test("evaluator fees are tallied from what the contract paid, by who received them; nothing is guessed", async () => {
  const { tallyEvaluatorFees } = await import("../src/census-lib.js");
  const records = [
    job({ id: 101, client: a(1), provider: a(2), evaluator: a(1) }),   // the client grades itself
    job({ id: 102, client: a(1), provider: a(2), evaluator: a(9) }),   // a third party
    job({ id: 103, client: a(3), provider: a(2), evaluator: a(2) }),   // the provider
    job({ id: 104, client: a(1), provider: a(2), evaluator: Z }),      // no evaluator
  ];
  const pay = (jobId, evaluator, amount) => ({ jobId, evaluator, amount: BigInt(amount), block: 1 });
  const t = tallyEvaluatorFees([
    pay(101, a(1), 50_000), pay(101, a(1), 5_000),
    pay(102, a(9).toUpperCase().replace("0X", "0x"), 2_500),
    pay(103, a(2), 1),
    pay(104, Z, 7),        // a fee to nobody cannot be joined to a recipient class
    pay(102, a(8), 9),     // the recipient is not the job's evaluator
    pay(999, a(1), 11),    // the job is not in the census
  ], records);
  assert.equal(t.payments, 7);
  assert.equal(t.unmatched, 3, "payments that do not join are counted, never classed");
  assert.deepEqual(t.byRecipient.client, { payments: 2, jobs: 1, units: "55000", usdc: "0.06" });
  assert.deepEqual(t.byRecipient.thirdParty, { payments: 1, jobs: 1, units: "2500", usdc: "0.00" });
  assert.deepEqual(t.byRecipient.provider, { payments: 1, jobs: 1, units: "1", usdc: "0.00" });
  const none = tallyEvaluatorFees([], records);
  assert.deepEqual(none, { payments: 0, unmatched: 0, byRecipient: {
    client: { payments: 0, jobs: 0, units: "0", usdc: "0.00" }, provider: { payments: 0, jobs: 0, units: "0", usdc: "0.00" },
    thirdParty: { payments: 0, jobs: 0, units: "0", usdc: "0.00" } } }, "every class is reported, even when empty");
  assert.throws(() => tallyEvaluatorFees([{ jobId: 101, evaluator: a(1), amount: 5 }], records), /amount/, "amounts are exact integers");
  assert.throws(() => tallyEvaluatorFees([{ jobId: 101, evaluator: "0x12", amount: 5n }], records), /evaluator/);
});

test("fees and hook counts are reported only when the log scan's JobCreated control passes", async () => {
  const { summarizeLogScan } = await import("../src/census-lib.js");
  const records = [job({ id: 201, client: a(1), provider: a(2), evaluator: a(9) })];
  const totals = { created: 1, hooks: 2, feePayments: [{ jobId: 201, evaluator: a(9), amount: 5n, block: 30 }],
    feeUpdates: [{ feeBP: 500, block: 20 }, { feeBP: 100, block: 10 }] };
  const ok = summarizeLogScan({ fromBlock: 1, toBlock: 40, totals, failedRanges: [], jobCounter: 1, records });
  assert.equal(ok.logScan.controlPassed, true);
  assert.equal(ok.logScan.hookWhitelistLogs, 2);
  assert.equal(ok.evaluatorFees.byRecipient.thirdParty.units, "5");
  assert.deepEqual(ok.evaluatorFees.feeUpdates.map((u) => u.block), [10, 20], "rate changes in block order");
  assert.equal(ok.evaluatorFees.firstPaymentBlock, 30);
  // Every range read, but fewer JobCreated events than the counter: the logs are incomplete, so nothing
  // counted from them may be reported as if it were whole.
  const short = summarizeLogScan({ fromBlock: 1, toBlock: 40, totals, failedRanges: [], jobCounter: 2, records });
  assert.equal(short.logScan.controlPassed, false);
  assert.equal(short.evaluatorFees, null, "no fee tally from an incomplete log set");
  const failed = summarizeLogScan({ fromBlock: 1, toBlock: 40, totals, failedRanges: [[7, 7]], jobCounter: 1, records });
  assert.equal(failed.logScan.controlPassed, false);
  assert.equal(failed.evaluatorFees, null, "no fee tally when a range could not be read");
  const quiet = summarizeLogScan({ fromBlock: 1, toBlock: 40, totals: { created: 1 }, failedRanges: [], jobCounter: 1, records });
  assert.deepEqual([quiet.evaluatorFees.payments, quiet.evaluatorFees.firstPaymentBlock, quiet.evaluatorFees.feeUpdates], [0, null, []]);
});
