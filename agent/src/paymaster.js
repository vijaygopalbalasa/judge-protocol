// The paymaster: runs a project brief milestone by milestone.
//
//   1. Draft checkable criteria from the plain-English acceptance text, or hand
//      the milestone back to a human with the sentences it cannot check.
//   2. Pick a contractor from Judge Protocol's verdicts on chain (one small
//      trial per run for a newcomer), then apply the owner's policy: hard caps,
//      a human-approval band, and the judge-fee budget, before any money moves.
//   3. Create an ERC-8183 job naming Judge Protocol, fund it only at the agreed
//      price, and pay the judge per ruling. The contractor is paid by the
//      escrow when the judge rules PASS; a REJECT refunds the escrow and the
//      milestone goes to the next contractor.
//   4. Read every verdict back from the chain. If the judge's reply ever
//      disagrees with the chain, stop.
// Every decision goes into the hash-chained log; its head is written into each
// job description, so the log is anchored on chain as it grows. Before money
// moves the log records the intent, and every run starts by settling any
// attempt a crash left open against the chain, so a rerun never pays twice.
import { formatUnits } from "viem";
import { draftCriteria } from "./drafter.js";
import { authorize, createSpendState, makePolicy, record, usdc } from "./policy.js";
import { chooseContractor, contractorRecords } from "./reputation.js";

const S = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 };
const NAMES = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]));
const TERMINAL = new Set(["paid", "refunded", "no-quote", "quote-refused", "no-delivery", "ruling-failed", "reconciled", "verdict-mismatch"]);
const fmt = (v) => formatUnits(v, 6);

/** Rebuild spend totals and finished milestones from an existing log, so a rerun never pays twice. */
function replay(ledger) {
  const state = createSpendState();
  const paid = new Set(), jobIds = [], approved = [];
  for (const e of ledger.entries) {
    const d = e.data || {};
    if (e.type === "funded") record(state, { type: "funded", milestoneId: d.milestoneId, amount: BigInt(d.amount) });
    if (e.type === "refunded") record(state, { type: "refunded", milestoneId: d.milestoneId, amount: BigInt(d.amount) });
    if (e.type === "paid") { record(state, { type: "paid", milestoneId: d.milestoneId, amount: BigInt(d.amount) }); paid.add(d.milestoneId); }
    if (e.type === "ruled") { jobIds.push(d.jobId); if (d.feeCharged) record(state, { type: "fee", amount: BigInt(d.fee) }); }
    if (e.type === "reconciled") {
      jobIds.push(d.jobId);
      if (d.fundedNow) record(state, { type: "funded", milestoneId: d.milestoneId, amount: BigInt(d.amount) });
      if (d.status === "Completed") { record(state, { type: "paid", milestoneId: d.milestoneId, amount: BigInt(d.amount) }); paid.add(d.milestoneId); }
      if (d.status === "Rejected" || d.refundClaimed) record(state, { type: "refunded", milestoneId: d.milestoneId, amount: BigInt(d.amount) });
    }
    if (e.type === "approved") approved.push(d.milestoneId); // a human's approval, in the same tamper-evident log
  }
  return { state, paid, jobIds, approved };
}

/** Attempts a crash may have left open: a job was created and nothing final was recorded for it. */
function openAttempts(ledger) {
  const byJob = new Map();
  for (const e of ledger.entries) {
    const d = e.data || {};
    if (e.type === "job-created") byJob.set(String(d.jobId), { ...d, jobId: String(d.jobId), funded: false, open: true });
    const a = d.jobId !== undefined ? byJob.get(String(d.jobId)) : null;
    if (!a) continue;
    if (e.type === "funded") a.funded = true;
    if (TERMINAL.has(e.type)) a.open = false;
  }
  return [...byJob.values()].filter((a) => a.open);
}

export async function runProject({ brief, ports, ledger, history = [], approvals = [], log = () => {} }) {
  const policy = makePolicy(brief.policy);
  const contractors = brief.contractors.map((c) => ({ name: c.name, address: c.address }));
  const allowlist = new Set(contractors.map((c) => c.address.toLowerCase()));
  const { chain, gate, market, judge } = ports;
  for (const m of brief.milestones) {
    if (!/^\d+(\.\d{1,6})?$/.test(String(m.payUSDC))) throw new Error(`milestone ${m.id}: payUSDC must be a USDC amount with at most 6 decimals`);
  }
  const { state, paid: alreadyPaid, jobIds: loggedJobs, approved } = replay(ledger);
  const ctx = { policy, state, approvals: [...approvals, ...approved], allowlist };
  const note = (type, data) => {
    ledger.append(type, data);
    try { log(type, data); } catch { /* a display problem must never interrupt a payment flow */ }
  };
  const judgeAddress = ports.judgeAddress ?? "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD";
  const byId = new Map(brief.milestones.map((m) => [m.id, m]));

  const records = await contractorRecords({ jobIds: [...history.map(String), ...loggedJobs], readJob: chain.readJob, readVerdict: chain.readVerdict, judge: judgeAddress });
  note("project-started", { project: brief.project, milestones: brief.milestones.length, contractors: contractors.map((c) => c.name),
    budget: fmt(policy.budget), spentBefore: fmt(state.committed), approvals: ctx.approvals });

  let halted = false, haltReason = null;
  const excluded = new Map(); // milestone id -> contractor addresses already tried on it
  const exclude = (id, address) => excluded.set(id, [...(excluded.get(id) ?? []), address]);
  const results = new Map();  // milestone id -> result
  const resultFor = (m) => {
    if (!results.has(m.id)) results.set(m.id, { id: m.id, title: m.title, amount: fmt(usdc(m.payUSDC)), attempts: [] });
    return results.get(m.id);
  };

  /** From a submitted job to paid or refunded: pay the judge, read the verdict from chain, settle the books. */
  async function finish({ m, who, jobId, amount, res }) {
    const fee = authorize({ type: "judge-fee", amount: judge.price }, ctx);
    if (fee.decision !== "allow") { Object.assign(res, { outcome: "stopped", reason: fee.reason }); return "stopped"; }
    note("rule-intent", { milestoneId: m.id, jobId });
    let ruling;
    try { ruling = await judge.rule({ jobId }); } catch (e) {
      note("ruling-failed", { milestoneId: m.id, jobId, error: String(e.message || e).slice(0, 300) });
      Object.assign(res, { outcome: "stuck", reason: `the judge did not rule: ${e.message}` });
      return "stuck";
    }
    const feeCharged = ruling.payment?.charged === true;
    if (feeCharged) record(state, { type: "fee", amount: judge.price });
    const onChain = await chain.readVerdict(jobId);
    const chainPass = BigInt(onChain?.timestamp ?? 0) !== 0n ? !!onChain.pass : null;
    note("ruled", { milestoneId: m.id, jobId, pass: chainPass, score: onChain?.score, verdictTx: ruling.txHash,
      replyPass: ruling.pass, feeCharged, fee: judge.price, payment: ruling.payment ?? null });
    if (chainPass === null || chainPass !== !!ruling.pass) {
      halted = true;
      haltReason = `the judge's reply (pass=${ruling.pass}) does not match the verdict on chain (pass=${chainPass}) for job ${jobId}`;
      note("verdict-mismatch", { milestoneId: m.id, jobId, reason: haltReason });
    }
    res.attempts[res.attempts.length - 1].pass = chainPass;
    const key = who.address.toLowerCase();
    const rec = records.get(key) ?? { passes: 0, rejects: 0, jobs: [] };
    if (chainPass) rec.passes++; else if (chainPass === false) rec.rejects++;
    rec.jobs.push(String(jobId));
    records.set(key, rec);
    if (chainPass) {
      record(state, { type: "paid", milestoneId: m.id, amount });
      note("paid", { milestoneId: m.id, jobId, contractor: who.name, amount });
      Object.assign(res, { outcome: "paid", contractor: who.name });
      return "paid";
    }
    if (chainPass === false) {
      record(state, { type: "refunded", milestoneId: m.id, amount });
      note("refunded", { milestoneId: m.id, jobId, contractor: who.name, amount });
      exclude(m.id, who.address);
      if (halted) { Object.assign(res, { outcome: "stopped", reason: haltReason }); return "stopped"; }
      return "refunded";
    }
    Object.assign(res, { outcome: "stopped", reason: haltReason });
    return "stopped";
  }

  // Settle what a crash may have left open, from the chain, before anything new.
  const reconciledPaid = new Set(), inFlight = new Set();
  for (const a of openAttempts(ledger)) {
    const m = byId.get(a.milestoneId);
    if (!m || halted) continue;
    const who = contractors.find((c) => c.address.toLowerCase() === String(a.address).toLowerCase()) ?? { name: a.contractor, address: a.address };
    const amount = a.amount !== undefined ? BigInt(a.amount) : usdc(m.payUSDC);
    const res = resultFor(m);
    res.attempts.push({ contractor: who.name, jobId: a.jobId, reconciled: true });
    const status = Number((await chain.readJob(a.jobId)).status);
    const fundedNow = !a.funded && status !== S.Open;
    if (status === S.Open) { note("reconciled", { milestoneId: m.id, jobId: a.jobId, status: "Open", amount, action: "never funded; nothing moved" }); continue; }
    if (status === S.Completed || status === S.Rejected) {
      const done = status === S.Completed;
      note("reconciled", { milestoneId: m.id, jobId: a.jobId, status: NAMES[status], amount, fundedNow,
        action: done ? "the escrow was already released" : "the escrow was already refunded" });
      if (fundedNow) record(state, { type: "funded", milestoneId: m.id, amount });
      record(state, { type: done ? "paid" : "refunded", milestoneId: m.id, amount });
      if (done) { reconciledPaid.add(m.id); Object.assign(res, { outcome: "paid", contractor: who.name, reconciled: true }); } else exclude(m.id, who.address);
      continue;
    }
    if (status === S.Expired) {
      if (chain.claimRefund) await chain.claimRefund({ jobId: a.jobId });
      note("reconciled", { milestoneId: m.id, jobId: a.jobId, status: "Expired", amount, fundedNow, refundClaimed: true, action: "expired without a verdict; refund claimed" });
      if (fundedNow) record(state, { type: "funded", milestoneId: m.id, amount });
      record(state, { type: "refunded", milestoneId: m.id, amount });
      continue;
    }
    if (fundedNow) { record(state, { type: "funded", milestoneId: m.id, amount }); note("funded", { milestoneId: m.id, jobId: a.jobId, amount, reconciled: true }); }
    if (status === S.Submitted) {
      note("submitted", { milestoneId: m.id, jobId: a.jobId, reconciled: true });
      if ((await finish({ m, who, jobId: a.jobId, amount, res })) === "paid") reconciledPaid.add(m.id);
      continue;
    }
    // Funded and waiting for delivery: never fund this milestone again while it is in flight.
    note("in-flight", { milestoneId: m.id, jobId: a.jobId, status: NAMES[status] });
    inFlight.add(m.id);
    Object.assign(res, { outcome: "in-flight", reason: `job ${a.jobId} is funded and waiting for delivery` });
  }

  let trialUsed = false;
  for (const m of brief.milestones) {
    if (halted) break;
    const amount = usdc(m.payUSDC);
    const res = resultFor(m);
    if (alreadyPaid.has(m.id)) { res.outcome = "already-paid"; continue; }
    if (reconciledPaid.has(m.id) || inFlight.has(m.id)) continue;

    const draft = draftCriteria(m.acceptance);
    note("criteria-drafted", { milestoneId: m.id, complete: draft.complete, criteria: draft.criteria, uncovered: draft.uncovered, reason: draft.reason });
    if (!draft.complete) { Object.assign(res, { outcome: "needs-rewrite", reason: draft.reason, uncovered: draft.uncovered }); continue; }

    for (;;) {
      const choice = chooseContractor({ amount }, contractors, records, { trialMax: policy.trialMax, trialUsed, exclude: excluded.get(m.id) ?? [] });
      if (!choice.contractor) { Object.assign(res, { outcome: "unassigned", reason: choice.reason }); note("unassigned", { milestoneId: m.id, reason: choice.reason }); break; }
      const who = choice.contractor;
      if (choice.trial) trialUsed = true;
      note("contractor-chosen", { milestoneId: m.id, contractor: who.name, address: who.address, reason: choice.reason, trial: !!choice.trial });

      const fund = authorize({ type: "fund", milestoneId: m.id, amount, contractor: who.address }, ctx);
      const fee = fund.decision === "allow" ? authorize({ type: "judge-fee", amount: judge.price }, ctx) : null;
      const decision = fund.decision !== "allow" ? fund : fee;
      note("decided", { milestoneId: m.id, amount, decision: decision.decision, reason: decision.reason });
      if (decision.decision === "escalate") { Object.assign(res, { outcome: "needs-approval", reason: decision.reason }); break; }
      if (decision.decision !== "allow") { Object.assign(res, { outcome: "stopped", reason: decision.reason }); break; }

      // Money moves only from here, and only into escrow the judge controls.
      gate.allowCreate();
      const title = `${m.title} (paymaster log ${ledger.head()})`;
      const job = await chain.createJob({ provider: who.address, criteria: draft.criteria, title });
      note("job-created", { milestoneId: m.id, jobId: job.jobId, txHash: job.txHash, contractor: who.name, address: who.address, amount });
      res.attempts.push({ contractor: who.name, jobId: String(job.jobId) });

      await market.offer({ jobId: job.jobId, amount, criteria: draft.criteria, milestone: m }, who);
      const quoted = await chain.waitForJob(job.jobId, (j) => BigInt(j.budget) > 0n);
      if (!quoted) { note("no-quote", { milestoneId: m.id, jobId: job.jobId, contractor: who.name }); exclude(m.id, who.address); continue; }
      if (BigInt(quoted.budget) !== amount) {
        note("quote-refused", { milestoneId: m.id, jobId: job.jobId, contractor: who.name, asked: fmt(BigInt(quoted.budget)), agreed: fmt(amount) });
        exclude(m.id, who.address);
        continue;
      }
      note("quoted", { milestoneId: m.id, jobId: job.jobId, budget: amount });

      note("fund-intent", { milestoneId: m.id, jobId: job.jobId, amount });
      gate.allowFund(job.jobId, amount);
      await chain.fund({ jobId: job.jobId, amount });
      record(state, { type: "funded", milestoneId: m.id, amount });
      note("funded", { milestoneId: m.id, jobId: job.jobId, amount });

      await market.funded({ jobId: job.jobId }, who);
      const submitted = await chain.waitForJob(job.jobId, (j) => Number(j.status) === S.Submitted);
      if (!submitted) {
        note("no-delivery", { milestoneId: m.id, jobId: job.jobId, contractor: who.name, note: "escrow stays locked until expiry, then claimRefund" });
        Object.assign(res, { outcome: "stuck", reason: `${who.name} did not deliver; the escrow returns after expiry` });
        exclude(m.id, who.address);
        break;
      }
      note("submitted", { milestoneId: m.id, jobId: job.jobId });

      const r = await finish({ m, who, jobId: job.jobId, amount, res });
      if (r === "refunded") { note("reassigned", { milestoneId: m.id, from: who.name }); continue; }
      break;
    }
  }

  const totals = { committed: fmt(state.committed), paid: fmt(state.paid), refunded: fmt(state.refunded), fees: fmt(state.fees) };
  const milestones = brief.milestones.map((m) => results.get(m.id)).filter(Boolean);
  note("project-finished", { totals, halted, haltReason, outcomes: milestones.map((r) => [r.id, r.outcome]) });
  return { milestones, records: Object.fromEntries(records), totals, halted, haltReason, ledgerHead: ledger.head() };
}
