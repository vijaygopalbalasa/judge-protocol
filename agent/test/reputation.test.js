// A contractor's record is what Judge Protocol ruled on chain, nothing else:
// no self-reported history, no verdicts from other evaluators.
import test from "node:test";
import assert from "node:assert/strict";
import { contractorRecords, score, chooseContractor } from "../src/reputation.js";

const JUDGE = "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD";
const A = "0x5e14c9E5278ee370D764d03d314e92B3d9fFC04F", B = "0x1111111111111111111111111111111111111111", C = "0x2222222222222222222222222222222222222222";
const jobs = {
  1: { provider: A, evaluator: JUDGE }, 2: { provider: A, evaluator: JUDGE }, 3: { provider: A, evaluator: JUDGE },
  4: { provider: B, evaluator: "0x000000000000000000000000000000000000dEaD" }, // another evaluator: ignored
  5: { provider: B, evaluator: JUDGE },                                        // no verdict yet: ignored
  6: { provider: C, evaluator: JUDGE },
};
const verdicts = { 1: { pass: true, timestamp: 5n }, 2: { pass: true, timestamp: 6n }, 3: { pass: false, timestamp: 7n }, 4: { pass: true, timestamp: 8n }, 6: { pass: false, timestamp: 9n } };
const readJob = async (id) => jobs[id];
const readVerdict = async (id) => verdicts[id] ?? { pass: false, timestamp: 0n };

test("only Judge Protocol's on-chain verdicts count", async () => {
  const r = await contractorRecords({ jobIds: [1, 2, 3, 4, 5, 6], readJob, readVerdict, judge: JUDGE });
  assert.deepEqual(r.get(A.toLowerCase()), { passes: 2, rejects: 1, jobs: ["1", "2", "3"] });
  assert.equal(r.get(B.toLowerCase()), undefined, "B has no verdict from this judge");
  assert.deepEqual(r.get(C.toLowerCase()), { passes: 0, rejects: 1, jobs: ["6"] });
});

test("a contractor paying for its own jobs does not build a record", async () => {
  const selfJobs = { 7: { client: C, provider: C, evaluator: JUDGE }, 8: { client: A, provider: C, evaluator: JUDGE } };
  const r = await contractorRecords({ jobIds: [7, 8], readJob: async (id) => selfJobs[id], readVerdict: async () => ({ pass: true, timestamp: 1n }), judge: JUDGE });
  assert.deepEqual(r.get(C.toLowerCase()), { passes: 1, rejects: 0, jobs: ["8"] }, "job 7 had the same client and provider");
});

test("scores are smoothed so one lucky job does not beat a long record", () => {
  assert.equal(score(undefined), 0.5);
  assert.equal(score({ passes: 1, rejects: 0 }), 2 / 3);
  assert.ok(score({ passes: 10, rejects: 1 }) > score({ passes: 1, rejects: 0 }));
});

test("the best verified record gets the work; a newcomer gets one small trial; exclusions are respected", async () => {
  const records = await contractorRecords({ jobIds: [1, 2, 3, 6], readJob, readVerdict, judge: JUDGE });
  const list = [{ name: "a", address: A }, { name: "b", address: B }, { name: "c", address: C }];
  const big = chooseContractor({ amount: 100_000n }, list, records, { trialMax: 50_000n, trialUsed: false });
  assert.equal(big.contractor.name, "a");
  const small = chooseContractor({ amount: 50_000n }, list, records, { trialMax: 50_000n, trialUsed: false });
  assert.equal(small.contractor.name, "b");
  assert.match(small.reason, /trial/);
  const noTrial = chooseContractor({ amount: 50_000n }, list, records, { trialMax: 50_000n, trialUsed: true });
  assert.equal(noTrial.contractor.name, "a");
  const excluded = chooseContractor({ amount: 100_000n }, list, records, { trialMax: 50_000n, trialUsed: true, exclude: [A] });
  assert.equal(excluded.contractor.name, "b", "B (no record, 0.5) ranks above C (0 of 1)");
  assert.equal(chooseContractor({ amount: 1n }, list, records, { exclude: [A, B, C] }).contractor, null);
});
