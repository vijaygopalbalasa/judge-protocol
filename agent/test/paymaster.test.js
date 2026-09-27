// The paymaster end to end on an in-memory chain: it drafts criteria, applies
// the owner's policy, picks contractors by their verified record, funds
// ERC-8183 escrow that only the judge can release, pays the judge per ruling,
// and writes every decision to a hash-chained log. Assertions check the chain
// (balances, calls), not only what the agent says about itself.
import test from "node:test";
import assert from "node:assert/strict";
import * as kit from "../../kit/judge-kit.js";
import { world } from "./helpers/world.js";
import { runProject } from "../src/paymaster.js";
import { guardWallet } from "../src/guard.js";
import { createLedger, verifyLedger } from "../src/ledger.js";
import { usdc } from "../src/policy.js";

const OWNER = "0xA3f1b2503838fc061af842eD2C719559E12ad973";
const A = "0x5e14c9E5278ee370D764d03d314e92B3d9fFC04F"; // proven
const B = "0x1111111111111111111111111111111111111111"; // newcomer
const C = "0x2222222222222222222222222222222222222222";
const POLICY = { budgetUSDC: "0.50", maxPerMilestoneUSDC: "0.25", approvalAboveUSDC: "0.10", maxJudgeFeesUSDC: "0.05", maxAttempts: 2, trialMaxUSDC: "0.05" };
const TEXT_MS = (id, pay) => ({ id, title: `Milestone ${id}`, payUSDC: pay, acceptance: "Between 5 and 60 words. Must mention ERC-8183, USDC and Arc.",
  demoWork: { good: "ERC-8183 escrow on Arc holds USDC until the evaluator rules on the delivered work.", bad: "ERC-8183 escrow on Arc holds dollars until someone decides." } });

async function setup({ behaviors = { [A]: "careful", [B]: "sloppy" }, contractors = [["alice", A], ["bob", B]], history = true, apiLies = false } = {}) {
  const w = world({ balances: { [OWNER]: usdc("5") } });
  // A verified history for A: three jobs judged on the (fake) chain before this run.
  const historyIds = [];
  if (history) {
    const hw = w.walletFor(OWNER), hpub = w.publicClient;
    for (let i = 0; i < 3; i++) {
      const job = await kit.createJudgedJob({ walletClient: hw, publicClient: hpub, provider: A, criteria: { checks: [{ kind: "length", params: { min: 1 } }] } });
      await kit.setBudget({ walletClient: w.walletFor(A), publicClient: hpub, jobId: job.jobId, amount: 1_000n });
      await kit.fundJob({ walletClient: hw, publicClient: hpub, jobId: job.jobId, amount: 1_000n });
      await kit.submitDeliverable({ walletClient: w.walletFor(A), publicClient: hpub, jobId: job.jobId, content: "done", mediaType: "text/plain" });
      await w.rule(job.jobId);
      historyIds.push(job.jobId);
    }
  }
  const guarded = guardWallet(w.walletFor(OWNER), { publicClient: w.publicClient, acp: kit.ARC_TESTNET.acp, usdc: kit.ARC_TESTNET.usdc, judge: kit.ARC_TESTNET.judge, abi: kit.ACP_ABI });
  const pending = new Map();
  const fees = [];
  const ports = {
    gate: guarded,
    chain: {
      createJob: ({ provider, criteria, title }) => kit.createJudgedJob({ walletClient: guarded, publicClient: w.publicClient, provider, criteria, title, expiresInSeconds: 3600 }),
      fund: ({ jobId, amount }) => kit.fundJob({ walletClient: guarded, publicClient: w.publicClient, jobId, amount }),
      readJob: (jobId) => w.publicClient.readContract({ functionName: "getJob", args: [BigInt(jobId)] }),
      readVerdict: (jobId) => w.publicClient.readContract({ functionName: "getVerdict", args: [BigInt(jobId)] }),
      waitForJob: async (jobId, until) => { const j = await w.publicClient.readContract({ functionName: "getJob", args: [BigInt(jobId)] }); return until(j) ? j : null; },
    },
    market: {
      offer: async (job, c) => { const next = await w.contractor(c.address, behaviors[c.address] ?? "careful")(job); if (next) pending.set(String(job.jobId), next); },
      funded: async (job) => { const next = pending.get(String(job.jobId)); if (next) await next(); },
    },
    judge: {
      price: usdc("0.01"),
      rule: async ({ jobId }) => {
        fees.push(jobId);
        const r = await w.rule(jobId);
        return apiLies ? { ...r, pass: !r.pass } : { ...r, payment: { charged: true, amount: "0.01" } };
      },
    },
  };
  let t = 0;
  const ledger = createLedger({ clock: () => `2026-09-28T10:00:${String(t++).padStart(2, "0")}Z` });
  const brief = (milestones, extra = {}) => ({ project: "Test project", policy: POLICY, contractors: contractors.map(([name, address]) => ({ name, address })), milestones, ...extra });
  return { w, ports, ledger, brief, historyIds, fees };
}
const types = (ledger) => ledger.entries.map((e) => e.type);

test("the best verified contractor is paid, through escrow, only after the judge rules PASS", async () => {
  const s = await setup();
  const before = { owner: s.w.balance(OWNER), a: s.w.balance(A) };
  const out = await runProject({ brief: s.brief([TEXT_MS("m1", "0.10")]), ports: s.ports, ledger: s.ledger, history: s.historyIds });
  assert.equal(out.milestones[0].outcome, "paid", JSON.stringify(out.milestones[0]));
  assert.equal(out.milestones[0].contractor, "alice");
  assert.equal(s.w.balance(A) - before.a, usdc("0.10"), "the contractor was paid by the escrow");
  assert.equal(before.owner - s.w.balance(OWNER), usdc("0.10"));
  const ownerCalls = s.w.calls.filter((c) => c.from === OWNER.toLowerCase()).map((c) => c.fn);
  assert.deepEqual(ownerCalls.slice(-3), ["createJob", "approve", "fund"], "the paymaster only creates, approves and funds");
  assert.ok(!s.w.calls.some((c) => c.fn === "transfer"), "nobody was paid directly");
  assert.deepEqual(types(s.ledger), ["project-started", "criteria-drafted", "contractor-chosen", "decided", "job-created", "quoted", "funded", "submitted", "ruled", "paid", "project-finished"]);
  assert.equal(verifyLedger(s.ledger.entries).ok, true);
});

test("a newcomer's small trial: rejected work is refunded and the milestone goes to the proven contractor", async () => {
  const s = await setup();
  const before = s.w.balance(OWNER);
  const out = await runProject({ brief: s.brief([TEXT_MS("m1", "0.05")]), ports: s.ports, ledger: s.ledger, history: s.historyIds });
  const m = out.milestones[0];
  assert.equal(m.outcome, "paid");
  assert.equal(m.contractor, "alice");
  assert.equal(m.attempts.length, 2);
  assert.deepEqual(m.attempts.map((a) => [a.contractor, a.pass]), [["bob", false], ["alice", true]]);
  assert.equal(before - s.w.balance(OWNER), usdc("0.05"), "the rejected attempt was refunded in full");
  assert.equal(s.w.balance(B), 0n, "the rejected contractor received nothing");
  assert.deepEqual(out.records[B.toLowerCase()], { passes: 0, rejects: 1, jobs: [String(m.attempts[0].jobId)] });
  assert.ok(types(s.ledger).includes("refunded") && types(s.ledger).includes("reassigned"));
});

test("above the approval line: escalated to a human, nothing created or funded; approved, it proceeds", async () => {
  const s = await setup();
  const ms = [TEXT_MS("m3", "0.20")];
  const creates = () => s.w.calls.filter((c) => c.fn === "createJob").length;
  const before = creates();
  const first = await runProject({ brief: s.brief(ms), ports: s.ports, ledger: s.ledger, history: s.historyIds });
  assert.equal(first.milestones[0].outcome, "needs-approval");
  assert.match(first.milestones[0].reason, /human must approve/);
  assert.equal(creates(), before, "no job was created");
  const second = await runProject({ brief: s.brief(ms), ports: s.ports, ledger: s.ledger, history: s.historyIds, approvals: ["m3"] });
  assert.equal(second.milestones[0].outcome, "paid");
});

test("acceptance a deterministic judge cannot check goes to a human, with the sentences", async () => {
  const s = await setup();
  const out = await runProject({ brief: s.brief([{ id: "m4", title: "Landing page", payUSDC: "0.05", acceptance: "Make the landing page look great." }]), ports: s.ports, ledger: s.ledger, history: s.historyIds });
  assert.equal(out.milestones[0].outcome, "needs-rewrite");
  assert.deepEqual(out.milestones[0].uncovered, ["Make the landing page look great"]);
  assert.ok(!types(s.ledger).includes("job-created"));
});

test("a contractor who raises the price is never funded; a silent one costs nothing", async () => {
  // Nobody has a record, so bob gets the trial; the tie after that breaks by address (carol, then alice).
  const s = await setup({ behaviors: { [A]: "careful", [B]: "greedy", [C]: "silent" }, contractors: [["bob", B], ["carol", C], ["alice", A]], history: false });
  const before = s.w.balance(OWNER);
  const out = await runProject({ brief: s.brief([TEXT_MS("m1", "0.05")], { policy: { ...POLICY, maxAttempts: 3 } }), ports: s.ports, ledger: s.ledger, history: [] });
  const m = out.milestones[0];
  assert.equal(m.outcome, "paid", JSON.stringify(m));
  const funded = s.w.calls.filter((c) => c.fn === "fund").map((c) => String(c.args[0]));
  assert.equal(funded.length, 1, "only the honest quote was funded");
  assert.ok(types(s.ledger).includes("quote-refused"));
  assert.ok(types(s.ledger).includes("no-quote"));
  assert.equal(before - s.w.balance(OWNER), usdc("0.05"));
});

test("the judge fee budget is checked before any money moves", async () => {
  const s = await setup();
  const brief = s.brief([TEXT_MS("m1", "0.10"), TEXT_MS("m2", "0.10")], { policy: { ...POLICY, maxJudgeFeesUSDC: "0.01" } });
  const out = await runProject({ brief, ports: s.ports, ledger: s.ledger, history: s.historyIds });
  assert.equal(out.milestones[0].outcome, "paid");
  assert.equal(out.milestones[1].outcome, "stopped");
  assert.match(out.milestones[1].reason, /fee budget/);
  assert.equal(s.w.calls.filter((c) => c.fn === "createJob").length, 3 + 1, "no second job was created");
  assert.equal(s.fees.length, 1);
});

test("the verdict is read from the chain, not taken from the judge's reply: a lying reply halts the run", async () => {
  const s = await setup({ apiLies: true });
  const out = await runProject({ brief: s.brief([TEXT_MS("m1", "0.10"), TEXT_MS("m2", "0.10")]), ports: s.ports, ledger: s.ledger, history: s.historyIds });
  assert.equal(out.halted, true);
  assert.match(out.haltReason, /does not match the verdict on chain/);
  assert.equal(out.milestones[0].outcome, "paid", "the chain says PASS, so it was paid, whatever the reply said");
  assert.equal(out.milestones.length, 1, "no further milestone was attempted");
});

test("the log head is written into every job description, anchoring the decisions on chain", async () => {
  const s = await setup();
  await runProject({ brief: s.brief([TEXT_MS("m1", "0.05")]), ports: s.ports, ledger: s.ledger, history: s.historyIds });
  const created = s.ledger.entries.filter((e) => e.type === "job-created");
  assert.equal(created.length, 2);
  for (const e of created) {
    const job = s.w.jobs.get(BigInt(e.data.jobId));
    const anchored = job.description.match(/paymaster log (0x[0-9a-f]{64})/)[1];
    const idx = s.ledger.entries.findIndex((x) => x.hash === anchored);
    assert.ok(idx >= 0 && idx < e.seq, "the anchored head is an earlier entry of this log");
    assert.ok(kit.extractCriteria(job.description), "the criteria block is intact");
  }
});

test("a second run resumes from the log: a paid milestone is never paid twice, and spend carries over", async () => {
  const s = await setup();
  const brief = s.brief([TEXT_MS("m1", "0.10"), TEXT_MS("m2", "0.20")]);
  await runProject({ brief, ports: s.ports, ledger: s.ledger, history: s.historyIds });
  const paidBefore = s.w.balance(A);
  const again = await runProject({ brief, ports: s.ports, ledger: s.ledger, history: s.historyIds, approvals: ["m2"] });
  assert.equal(again.milestones[0].outcome, "already-paid");
  assert.equal(again.milestones[1].outcome, "paid");
  assert.equal(s.w.balance(A) - paidBefore, usdc("0.20"), "only m2 was paid in the second run");
  assert.equal(again.totals.paid, "0.3", "spend state was rebuilt from the log");
  assert.equal(verifyLedger(s.ledger.entries).ok, true);
});

test("only one newcomer trial per run: the next small milestone goes to the best verified record", async () => {
  const s = await setup({ behaviors: { [A]: "careful", [B]: "sloppy", [C]: "careful" }, contractors: [["alice", A], ["bob", B], ["carol", C]] });
  const out = await runProject({ brief: s.brief([TEXT_MS("m1", "0.05"), TEXT_MS("m2", "0.05")]), ports: s.ports, ledger: s.ledger, history: s.historyIds });
  assert.deepEqual(out.milestones[0].attempts.map((a) => a.contractor), ["bob", "alice"], "bob got the one trial; carol did not get a second one");
  assert.equal(out.milestones[1].attempts[0].contractor, "alice", "nor on the next milestone");
});

test("a contractor rejected on a milestone never gets that milestone again, even with the best record", async () => {
  // alice has the best record but does sloppy work this time; bob is new and careful.
  const s = await setup({ behaviors: { [A]: "sloppy", [B]: "careful" } });
  const out = await runProject({ brief: s.brief([TEXT_MS("m1", "0.10")]), ports: s.ports, ledger: s.ledger, history: s.historyIds });
  assert.deepEqual(out.milestones[0].attempts.map((a) => [a.contractor, a.pass]), [["alice", false], ["bob", true]]);
  assert.equal(out.milestones[0].outcome, "paid");
});

test("a human approval is an entry in the same hash-chained log, and unlocks exactly that milestone", async () => {
  const s = await setup();
  const ms = [TEXT_MS("m3", "0.20"), TEXT_MS("m5", "0.20")];
  s.ledger.append("approved", { milestoneId: "m3", by: "owner", note: "reviewed the scope" });
  const out = await runProject({ brief: s.brief(ms), ports: s.ports, ledger: s.ledger, history: s.historyIds });
  assert.equal(out.milestones[0].outcome, "paid");
  assert.equal(out.milestones[1].outcome, "needs-approval");
  assert.equal(verifyLedger(s.ledger.entries).ok, true);
});
