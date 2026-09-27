// One readable line per decision-log entry, for the CLI. Never throws: amounts
// are BigInt, and an unknown entry type falls back to BigInt-safe JSON.
import { formatUnits } from "viem";

const VERIFIER = "https://judge-protocol-verifier.vercel.app";
const safe = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const usd = (v) => { try { return `${formatUnits(BigInt(v), 6)} USDC`; } catch { return String(v); } };

const LINES = {
  "project-started": (d) => `project "${d.project}": ${d.milestones} milestones, budget ${d.budget} USDC, contractors ${(d.contractors || []).join(", ")}`,
  "criteria-drafted": (d) => d.complete ? `[${d.milestoneId}] criteria drafted: ${(d.criteria?.checks || []).map((c) => c.kind).join(", ")}` : `[${d.milestoneId}] cannot check: ${safe(d.uncovered)}`,
  "contractor-chosen": (d) => `[${d.milestoneId}] chose ${d.contractor}: ${d.reason}`,
  "decided": (d) => `[${d.milestoneId}] policy: ${d.decision} (${d.reason})`,
  "job-created": (d) => `[${d.milestoneId}] job ${d.jobId} created for ${d.contractor} (tx ${d.txHash})`,
  "quoted": (d) => `[${d.milestoneId}] job ${d.jobId} quoted at the agreed price`,
  "quote-refused": (d) => `[${d.milestoneId}] job ${d.jobId}: ${d.contractor} asked ${d.asked} USDC, agreed ${d.agreed}: not funded`,
  "no-quote": (d) => `[${d.milestoneId}] job ${d.jobId}: ${d.contractor} never quoted: nothing funded`,
  "fund-intent": (d) => `[${d.milestoneId}] job ${d.jobId}: about to fund ${usd(d.amount)} into escrow`,
  "funded": (d) => `[${d.milestoneId}] job ${d.jobId} escrow funded${d.reconciled ? " (found on chain)" : ""}`,
  "submitted": (d) => `[${d.milestoneId}] job ${d.jobId} work submitted${d.reconciled ? " (found on chain)" : ""}`,
  "no-delivery": (d) => `[${d.milestoneId}] job ${d.jobId}: ${d.contractor} did not deliver; the escrow returns after expiry`,
  "rule-intent": (d) => `[${d.milestoneId}] job ${d.jobId}: asking the judge to rule (paid over x402)`,
  "ruling-failed": (d) => `[${d.milestoneId}] job ${d.jobId}: the judge did not rule: ${d.error}`,
  "ruled": (d) => `[${d.milestoneId}] job ${d.jobId} judge ruled ${d.pass ? "PASS" : "REJECT"} (score ${d.score}); fee ${d.feeCharged ? "paid over x402" : "not charged"}; verify: ${VERIFIER}`,
  "verdict-mismatch": (d) => `STOP: ${d.reason}`,
  "paid": (d) => `[${d.milestoneId}] job ${d.jobId} escrow released to ${d.contractor}`,
  "refunded": (d) => `[${d.milestoneId}] job ${d.jobId} escrow refunded to the owner`,
  "reassigned": (d) => `[${d.milestoneId}] reassigning away from ${d.from}`,
  "unassigned": (d) => `[${d.milestoneId}] no contractor left: ${d.reason}`,
  "reconciled": (d) => `[${d.milestoneId}] job ${d.jobId} found ${d.status} on chain: ${d.action}`,
  "in-flight": (d) => `[${d.milestoneId}] job ${d.jobId} is funded and waiting for delivery; not funding it again`,
  "approved": (d) => `[${d.milestoneId}] approved by ${d.by}${d.note ? `: ${d.note}` : ""}`,
  "project-finished": (d) => `done: ${safe(d.outcomes)}; paid ${d.totals?.paid}, refunded ${d.totals?.refunded}, judge fees ${d.totals?.fees} USDC`,
};

export function formatEntry(type, data = {}) {
  try { return (LINES[type] || ((d) => `${type} ${safe(d)}`))(data); } catch { return `${type} ${safe(data)}`; }
}
