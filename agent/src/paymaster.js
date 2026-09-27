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
// job description, so the log is anchored on chain as it grows.
import { formatUnits } from "viem";
import { draftCriteria } from "./drafter.js";
import { authorize, createSpendState, makePolicy, record, usdc } from "./policy.js";
import { chooseContractor, contractorRecords } from "./reputation.js";

const STATUS_SUBMITTED = 2;
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
    if (e.type === "approved") approved.push(d.milestoneId); // a human's approval, in the same tamper-evident log
  }
  return { state, paid, jobIds, approved };
}

export async function runProject({ brief, ports, ledger, history = [], approvals = [], log = () => {} }) {
  const policy = makePolicy(brief.policy);
  const contractors = brief.contractors.map((c) => ({ name: c.name, address: c.address }));
  const allowlist = new Set(contractors.map((c) => c.address.toLowerCase()));
  const { chain, gate, market, judge } = ports;
  const { state, paid: alreadyPaid, jobIds: loggedJobs, approved } = replay(ledger);
  const ctx = { policy, state, approvals: [...approvals, ...approved], allowlist };
  const note = (type, data) => { ledger.append(type, data); log(type, data); };

  const records = await contractorRecords({ jobIds: [...history.map(String), ...loggedJobs], readJob: chain.readJob, readVerdict: chain.readVerdict, judge: ports.judgeAddress ?? "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD" });
  note("project-started", { project: brief.project, milestones: brief.milestones.length, contractors: contractors.map((c) => c.name),
    budget: fmt(policy.budget), spentBefore: fmt(state.committed), approvals: ctx.approvals });

  const results = [];
  let trialUsed = false, halted = false, haltReason = null;
  for (const m of brief.milestones) {
    if (halted) break;
    const amount = usdc(m.payUSDC);
    const res = { id: m.id, title: m.title, amount: fmt(amount), attempts: [] };
    results.push(res);
    if (alreadyPaid.has(m.id)) { res.outcome = "already-paid"; continue; }

    const draft = draftCriteria(m.acceptance);
    note("criteria-drafted", { milestoneId: m.id, complete: draft.complete, criteria: draft.criteria, uncovered: draft.uncovered, reason: draft.reason });
    if (!draft.complete) { Object.assign(res, { outcome: "needs-rewrite", reason: draft.reason, uncovered: draft.uncovered }); continue; }

    const exclude = [];
    for (;;) {
      const choice = chooseContractor({ amount }, contractors, records, { trialMax: policy.trialMax, trialUsed, exclude });
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
      note("job-created", { milestoneId: m.id, jobId: job.jobId, txHash: job.txHash, contractor: who.name });
      const attempt = { contractor: who.name, jobId: String(job.jobId) };
      res.attempts.push(attempt);

      await market.offer({ jobId: job.jobId, amount, criteria: draft.criteria, milestone: m }, who);
      const quoted = await chain.waitForJob(job.jobId, (j) => BigInt(j.budget) > 0n);
      if (!quoted) { note("no-quote", { milestoneId: m.id, jobId: job.jobId, contractor: who.name }); exclude.push(who.address); continue; }
      if (BigInt(quoted.budget) !== amount) {
        note("quote-refused", { milestoneId: m.id, jobId: job.jobId, contractor: who.name, asked: fmt(BigInt(quoted.budget)), agreed: fmt(amount) });
        exclude.push(who.address);
        continue;
      }
      note("quoted", { milestoneId: m.id, jobId: job.jobId, budget: amount });

      gate.allowFund(job.jobId, amount);
      await chain.fund({ jobId: job.jobId, amount });
      record(state, { type: "funded", milestoneId: m.id, amount });
      note("funded", { milestoneId: m.id, jobId: job.jobId, amount });

      await market.funded({ jobId: job.jobId }, who);
      const submitted = await chain.waitForJob(job.jobId, (j) => Number(j.status) === STATUS_SUBMITTED);
      if (!submitted) {
        note("no-delivery", { milestoneId: m.id, jobId: job.jobId, contractor: who.name, note: "escrow stays locked until expiry, then claimRefund" });
        Object.assign(res, { outcome: "stuck", reason: `${who.name} did not deliver; the escrow returns after expiry` });
        exclude.push(who.address);
        break;
      }
      note("submitted", { milestoneId: m.id, jobId: job.jobId });

      let ruling;
      try { ruling = await judge.rule({ jobId: job.jobId }); } catch (e) {
        note("ruling-failed", { milestoneId: m.id, jobId: job.jobId, error: String(e.message || e).slice(0, 300) });
        Object.assign(res, { outcome: "stuck", reason: `the judge did not rule: ${e.message}` });
        break;
      }
      const feeCharged = !!ruling.payment?.charged;
      if (feeCharged) record(state, { type: "fee", amount: judge.price });
      const onChain = await chain.readVerdict(job.jobId);
      const chainPass = BigInt(onChain?.timestamp ?? 0) !== 0n ? !!onChain.pass : null;
      note("ruled", { milestoneId: m.id, jobId: job.jobId, pass: chainPass, score: onChain?.score, verdictTx: ruling.txHash,
        replyPass: ruling.pass, feeCharged, fee: judge.price, payment: ruling.payment ?? null });
      if (chainPass === null || chainPass !== !!ruling.pass) {
        halted = true;
        haltReason = `the judge's reply (pass=${ruling.pass}) does not match the verdict on chain (pass=${chainPass}) for job ${job.jobId}`;
        note("verdict-mismatch", { milestoneId: m.id, jobId: job.jobId, reason: haltReason });
      }
      attempt.pass = chainPass;
      const key = who.address.toLowerCase();
      const rec = records.get(key) ?? { passes: 0, rejects: 0, jobs: [] };
      if (chainPass) rec.passes++; else if (chainPass === false) rec.rejects++;
      rec.jobs.push(String(job.jobId));
      records.set(key, rec);

      if (chainPass) {
        record(state, { type: "paid", milestoneId: m.id, amount });
        note("paid", { milestoneId: m.id, jobId: job.jobId, contractor: who.name, amount });
        Object.assign(res, { outcome: "paid", contractor: who.name });
        break;
      }
      if (chainPass === false) {
        record(state, { type: "refunded", milestoneId: m.id, amount });
        note("refunded", { milestoneId: m.id, jobId: job.jobId, contractor: who.name, amount });
        exclude.push(who.address);
        if (halted) { Object.assign(res, { outcome: "stopped", reason: haltReason }); break; }
        note("reassigned", { milestoneId: m.id, from: who.name });
        continue;
      }
      Object.assign(res, { outcome: "stopped", reason: haltReason });
      break;
    }
  }

  const totals = { committed: fmt(state.committed), paid: fmt(state.paid), refunded: fmt(state.refunded), fees: fmt(state.fees) };
  note("project-finished", { totals, halted, haltReason, outcomes: results.map((r) => [r.id, r.outcome]) });
  return { milestones: results, records: Object.fromEntries(records), totals, halted, haltReason, ledgerHead: ledger.head() };
}
