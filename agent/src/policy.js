// The owner's spend rules, enforced in code. Two tiers: hard caps that nothing
// overrides (per milestone, total budget, judge fees, attempts), and a band
// above `approvalAbove` where a named human must approve first.
import { formatUnits, parseUnits } from "viem";

export const usdc = (amount) => parseUnits(String(amount), 6);
const fmt = (v) => formatUnits(v, 6);
const FEE_CEILING = usdc("0.01"); // the judge's published price per ruling

export function makePolicy(raw = {}) {
  const money = (k) => {
    const v = raw[k];
    if (typeof v !== "string" || !/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`policy: ${k} must be a USDC amount like "0.10"`);
    return usdc(v);
  };
  const p = {
    budget: money("budgetUSDC"),
    maxPerMilestone: money("maxPerMilestoneUSDC"),
    approvalAbove: money("approvalAboveUSDC"),
    maxJudgeFees: money("maxJudgeFeesUSDC"),
    trialMax: raw.trialMaxUSDC === undefined ? 0n : money("trialMaxUSDC"),
    maxAttempts: raw.maxAttempts,
  };
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1 || p.maxAttempts > 5) throw new Error("policy: maxAttempts must be an integer from 1 to 5");
  if (p.budget === 0n || p.maxPerMilestone === 0n) throw new Error("policy: budget and maxPerMilestone must be above zero");
  return Object.freeze(p);
}

export function createSpendState() {
  return { committed: 0n, paid: 0n, refunded: 0n, fees: 0n, attempts: {} };
}

/** Apply something that happened (on chain) to the running totals. */
export function record(state, e) {
  if (e.type === "funded") { state.committed += e.amount; state.attempts[e.milestoneId] = (state.attempts[e.milestoneId] ?? 0) + 1; }
  else if (e.type === "refunded") { state.committed -= e.amount; state.refunded += e.amount; }
  else if (e.type === "paid") state.paid += e.amount;
  else if (e.type === "fee") state.fees += e.amount;
  else throw new Error(`unknown spend event ${e.type}`);
  return state;
}

const allow = () => ({ decision: "allow", reason: "within policy" });
const deny = (reason) => ({ decision: "deny", reason });
const escalate = (reason) => ({ decision: "escalate", reason });

/** allow | deny | escalate for one proposed action. Unknown actions are denied. */
export function authorize(action, { policy, state, approvals = [], allowlist }) {
  if (action.type === "fund") {
    const { milestoneId, amount, contractor } = action;
    if (!allowlist.has(String(contractor).toLowerCase())) return deny("the contractor is not on the owner's list");
    if (!(typeof amount === "bigint" && amount > 0n)) return deny("the amount must be above zero");
    if (amount > policy.maxPerMilestone) return deny(`over the per-milestone limit of ${fmt(policy.maxPerMilestone)} USDC`);
    if (state.committed + amount > policy.budget) return deny(`over the project budget (${fmt(policy.budget - state.committed)} USDC left)`);
    if ((state.attempts[milestoneId] ?? 0) >= policy.maxAttempts) return deny(`already tried ${policy.maxAttempts} times`);
    if (amount > policy.approvalAbove && !approvals.includes(milestoneId)) {
      return escalate(`above ${fmt(policy.approvalAbove)} USDC: a human must approve milestone ${milestoneId}`);
    }
    return allow();
  }
  if (action.type === "judge-fee") {
    if (!(typeof action.amount === "bigint" && action.amount > 0n && action.amount <= FEE_CEILING)) return deny(`a judge fee must be at most ${fmt(FEE_CEILING)} USDC`);
    if (state.fees + action.amount > policy.maxJudgeFees) return deny(`the judge fee budget of ${fmt(policy.maxJudgeFees)} USDC is spent`);
    return allow();
  }
  return deny(`unknown action ${action.type}`);
}
