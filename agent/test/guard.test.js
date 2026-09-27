// The paymaster's wallet can do exactly four things, each only when policy
// authorized it: create a job that names Judge Protocol, approve USDC to the
// escrow, fund that job at the agreed budget, and reclaim an expired escrow.
// It cannot pay anyone directly, so it cannot pay for unverified work.
import test from "node:test";
import assert from "node:assert/strict";
import { guardWallet } from "../src/guard.js";

const ACP = "0x0747EEf0706327138c69792bF28Cd525089e4583", USDC = "0x3600000000000000000000000000000000000000";
const JUDGE = "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD", ME = "0xA3f1b2503838fc061af842eD2C719559E12ad973";
const OTHER = "0x000000000000000000000000000000000000bEEF";

function setup(jobOverrides = {}) {
  const sent = [];
  const inner = { account: { address: ME }, writeContract: async (req) => { sent.push(req.functionName); return "0x" + String(sent.length).padStart(64, "0"); } };
  const job = { client: ME, evaluator: JUDGE, budget: 50_000n, status: 0, ...jobOverrides };
  const publicClient = { readContract: async ({ functionName }) => { assert.equal(functionName, "getJob"); return job; } };
  const g = guardWallet(inner, { publicClient, acp: ACP, usdc: USDC, judge: JUDGE });
  return { g, sent };
}
const create = (evaluator = JUDGE) => ({ address: ACP, functionName: "createJob", args: [OTHER, evaluator, 1n, "d", "0x0000000000000000000000000000000000000000"] });

test("create is allowed once per authorization, and only naming Judge Protocol", async () => {
  const { g, sent } = setup();
  await assert.rejects(g.writeContract(create()), /not authorized/);
  g.allowCreate();
  await assert.rejects(g.writeContract(create(OTHER)), /Judge Protocol/);
  g.allowCreate();
  await g.writeContract(create());
  await assert.rejects(g.writeContract(create()), /not authorized/);
  assert.deepEqual(sent, ["createJob"]);
});

test("approve and fund only the authorized job, at the authorized amount, once", async () => {
  const { g, sent } = setup();
  await assert.rejects(g.writeContract({ address: USDC, functionName: "approve", args: [ACP, 50_000n] }), /not authorized/);
  g.allowFund(7n, 50_000n);
  await assert.rejects(g.writeContract({ address: USDC, functionName: "approve", args: [OTHER, 50_000n] }), /escrow/);
  await assert.rejects(g.writeContract({ address: USDC, functionName: "approve", args: [ACP, 60_000n] }), /not authorized/);
  await g.writeContract({ address: USDC, functionName: "approve", args: [ACP, 50_000n] });
  await assert.rejects(g.writeContract({ address: ACP, functionName: "fund", args: [8n, "0x"] }), /not authorized/);
  await g.writeContract({ address: ACP, functionName: "fund", args: [7n, "0x"] });
  await assert.rejects(g.writeContract({ address: ACP, functionName: "fund", args: [7n, "0x"] }), /not authorized/, "once");
  assert.deepEqual(sent, ["approve", "fund"]);
});

test("fund re-checks the job on chain: it must name the judge, be ours, and cost what was agreed", async () => {
  for (const [what, over, why] of [["another evaluator", { evaluator: OTHER }, /does not name Judge Protocol/],
    ["another client", { client: OTHER }, /not the paymaster's own/], ["a raised budget", { budget: 60_000n }, /budget changed/]]) {
    const { g, sent } = setup(over);
    g.allowFund(7n, 50_000n);
    await g.writeContract({ address: USDC, functionName: "approve", args: [ACP, 50_000n] });
    await assert.rejects(g.writeContract({ address: ACP, functionName: "fund", args: [7n, "0x"] }), why, what);
    assert.deepEqual(sent, ["approve"], `${what}: approved, but never funded`);
  }
});

test("everything else is refused: no direct payments, no completing or rejecting, no other contracts", async () => {
  const { g, sent } = setup();
  g.allowCreate(); g.allowFund(7n, 50_000n);
  for (const req of [
    { address: USDC, functionName: "transfer", args: [OTHER, 50_000n] },
    { address: USDC, functionName: "transferFrom", args: [ME, OTHER, 1n] },
    { address: ACP, functionName: "complete", args: [7n, "0x" + "0".repeat(64), "0x"] },
    { address: ACP, functionName: "reject", args: [7n, "0x" + "0".repeat(64), "0x"] },
    { address: ACP, functionName: "setBudget", args: [7n, 1n, "0x"] },
    { address: OTHER, functionName: "fund", args: [7n, "0x"] },
  ]) {
    await assert.rejects(g.writeContract(req), /refused/, `${req.functionName} on ${req.address}`);
  }
  assert.deepEqual(sent, []);
  await assert.rejects(g.sendTransaction?.({ to: OTHER, value: 1n }) ?? Promise.reject(new Error("refused: no sendTransaction")), /refused/);
});

test("reclaiming an expired escrow is always allowed for the paymaster's own jobs", async () => {
  const { g, sent } = setup({ status: 5 });
  await g.writeContract({ address: ACP, functionName: "claimRefund", args: [7n] });
  assert.deepEqual(sent, ["claimRefund"]);
  const other = setup({ client: OTHER });
  await assert.rejects(other.g.writeContract({ address: ACP, functionName: "claimRefund", args: [7n] }), /refused/);
});
