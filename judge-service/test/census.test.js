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
