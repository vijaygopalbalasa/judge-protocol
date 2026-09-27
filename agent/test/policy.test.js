// Spend rules the agent cannot talk its way around: hard caps no approval can
// override, and a band where a human must approve before any money moves.
import test from "node:test";
import assert from "node:assert/strict";
import { makePolicy, authorize, createSpendState, record, usdc } from "../src/policy.js";

const P = makePolicy({ budgetUSDC: "0.50", maxPerMilestoneUSDC: "0.25", approvalAboveUSDC: "0.10", maxJudgeFeesUSDC: "0.03", maxAttempts: 2, trialMaxUSDC: "0.05" });
const A = "0x5e14c9E5278ee370D764d03d314e92B3d9fFC04F";
const allowlist = new Set([A.toLowerCase()]);
const ctx = (state = createSpendState(), approvals = []) => ({ policy: P, state, approvals, allowlist });
const fund = (amount, milestoneId = "m1", contractor = A) => ({ type: "fund", milestoneId, amount: usdc(amount), contractor });

test("money is parsed exactly (6 decimals) and bad policies are refused", () => {
  assert.equal(usdc("0.10"), 100_000n);
  assert.equal(P.budget, 500_000n);
  for (const bad of [{}, { budgetUSDC: "-1", maxPerMilestoneUSDC: "1", approvalAboveUSDC: "1", maxJudgeFeesUSDC: "1", maxAttempts: 1 },
    { budgetUSDC: "abc", maxPerMilestoneUSDC: "1", approvalAboveUSDC: "1", maxJudgeFeesUSDC: "1", maxAttempts: 1 },
    { budgetUSDC: "1", maxPerMilestoneUSDC: "1", approvalAboveUSDC: "1", maxJudgeFeesUSDC: "1", maxAttempts: 0 }]) {
    assert.throws(() => makePolicy(bad), /policy/);
  }
});

test("a normal milestone is allowed", () => {
  assert.equal(authorize(fund("0.05"), ctx()).decision, "allow");
});

test("hard caps are hard: no approval unlocks them", () => {
  const over = authorize(fund("0.26"), ctx(createSpendState(), ["m1"]));
  assert.equal(over.decision, "deny");
  assert.match(over.reason, /per-milestone limit/);
  const s = createSpendState();
  record(s, { type: "funded", milestoneId: "m0", amount: usdc("0.45") });
  const budget = authorize(fund("0.10", "m1"), ctx(s, ["m1"]));
  assert.equal(budget.decision, "deny");
  assert.match(budget.reason, /budget/);
});

test("above the approval threshold a human must approve; with approval it proceeds", () => {
  const e = authorize(fund("0.20", "m3"), ctx());
  assert.equal(e.decision, "escalate");
  assert.match(e.reason, /human/);
  assert.equal(authorize(fund("0.20", "m3"), ctx(createSpendState(), ["m3"])).decision, "allow");
  assert.equal(authorize(fund("0.20", "m4"), ctx(createSpendState(), ["m3"])).decision, "escalate", "approval is per milestone");
});

test("only contractors on the owner's list, never zero, and a limited number of attempts", () => {
  assert.equal(authorize(fund("0.05", "m1", "0x000000000000000000000000000000000000bEEF"), ctx()).decision, "deny");
  assert.equal(authorize({ ...fund("0.05"), amount: 0n }, ctx()).decision, "deny");
  const s = createSpendState();
  record(s, { type: "funded", milestoneId: "m1", amount: usdc("0.05") });
  record(s, { type: "refunded", milestoneId: "m1", amount: usdc("0.05") });
  record(s, { type: "funded", milestoneId: "m1", amount: usdc("0.05") });
  record(s, { type: "refunded", milestoneId: "m1", amount: usdc("0.05") });
  const third = authorize(fund("0.05", "m1"), ctx(s));
  assert.equal(third.decision, "deny");
  assert.match(third.reason, /tried 2 times/);
});

test("a refund frees budget; a payment does not", () => {
  const s = createSpendState();
  record(s, { type: "funded", milestoneId: "a", amount: usdc("0.25") });
  record(s, { type: "funded", milestoneId: "b", amount: usdc("0.25") });
  assert.equal(authorize(fund("0.05", "c"), ctx(s)).decision, "deny");
  record(s, { type: "refunded", milestoneId: "b", amount: usdc("0.25") });
  assert.equal(authorize(fund("0.05", "c"), ctx(s)).decision, "allow");
  record(s, { type: "paid", milestoneId: "a", amount: usdc("0.25") });
  assert.equal(s.committed, usdc("0.25"), "paid money stays spent");
});

test("judge fees have their own cap", () => {
  const s = createSpendState();
  const fee = { type: "judge-fee", amount: usdc("0.01") };
  for (let i = 0; i < 3; i++) { assert.equal(authorize(fee, ctx(s)).decision, "allow"); record(s, { type: "fee", amount: usdc("0.01") }); }
  const d = authorize(fee, ctx(s));
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /fee/);
  assert.equal(authorize({ type: "judge-fee", amount: usdc("0.02") }, ctx()).decision, "deny", "a single fee above the expected price is refused");
  assert.equal(authorize({ type: "transfer", amount: 1n }, ctx()).decision, "deny", "unknown actions are refused");
});
