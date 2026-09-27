// Contractor records come only from Judge Protocol's verdicts on chain:
// anyone can recompute them, and nobody can self-report a better history.
export async function contractorRecords({ jobIds, readJob, readVerdict, judge }) {
  const records = new Map();
  for (const id of jobIds) {
    const job = await readJob(id);
    if (!job || String(job.evaluator).toLowerCase() !== judge.toLowerCase()) continue;
    const v = await readVerdict(id);
    if (!v || BigInt(v.timestamp ?? 0) === 0n) continue;
    const key = String(job.provider).toLowerCase();
    const r = records.get(key) ?? { passes: 0, rejects: 0, jobs: [] };
    if (v.pass) r.passes++; else r.rejects++;
    r.jobs.push(String(id));
    records.set(key, r);
  }
  return records;
}

/** Laplace-smoothed pass rate: a newcomer starts at 0.5, and one lucky job does not beat a long record. */
export function score(r) {
  if (!r) return 0.5;
  return (r.passes + 1) / (r.passes + r.rejects + 2);
}

/**
 * Pick who gets a milestone: the best verified record, except that one small
 * milestone (at most `trialMax`) per run goes to a contractor with no record,
 * so newcomers can earn one. Ties break by address, so the choice is repeatable.
 */
export function chooseContractor(milestone, contractors, records, { trialMax = 0n, trialUsed = false, exclude = [] } = {}) {
  const out = new Set(exclude.map((a) => String(a).toLowerCase()));
  const open = contractors.filter((c) => !out.has(c.address.toLowerCase()));
  if (!open.length) return { contractor: null, reason: "every allowed contractor was already tried on this milestone" };
  const rec = (c) => records.get(c.address.toLowerCase());
  const newcomer = open.find((c) => !rec(c));
  if (!trialUsed && newcomer && milestone.amount <= trialMax) {
    return { contractor: newcomer, reason: `trial: ${newcomer.name} has no verified record yet and this milestone is small`, trial: true };
  }
  const ranked = [...open].sort((a, b) => score(rec(b)) - score(rec(a)) || a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  const best = ranked[0], r = rec(best);
  return { contractor: best, reason: r ? `best verified record: ${r.passes} passed, ${r.rejects} rejected` : "no contractor has a verified record yet" };
}
