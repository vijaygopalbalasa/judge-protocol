// What the page says about a verification result. Pure functions, no DOM, so
// every message is unit-tested (web/test/present.test.mjs).
import { outcome } from './app.js';

const STATES = {
  verified: ['VERIFIED', 'var(--ok)', 'recomputed independently'],
  mismatch: ['MISMATCH', 'var(--bad)', 'recomputation disagrees with the on-chain verdict'],
  incomplete: ['INCOMPLETE', 'var(--warn)', 'could not finish; see below'],
  awaiting: ['AWAITING RULING', 'var(--warn)', 'the provider has submitted; the judge has not ruled yet'],
  error: ['ERROR', 'var(--bad)', 'could not read this job'],
};

function incompleteText(r) {
  const i = r.incomplete || {};
  switch (i.reason) {
    case 'remote-uri':
      return (i.from === 'job description (client-authored)'
        ? `The job description (client-authored) points to ${i.uri}`
        : `The provider delivered via ${i.uri}`)
        + ', which this page does not fetch. Paste the deliverable text or choose the file to finish; it '
        + "only counts if it hashes to the provider's on-chain commitment.";
    case 'no-uri':
      return (r.submittedVia === 'contract wallet'
        ? "The provider submitted through a contract wallet, so the page cannot read a deliverable URI from the call, "
          + 'and the job description has none. '
        : "The provider's submission carries no deliverable URI and the job description has none. ")
        + 'Paste the deliverable text or choose the file to finish.';
    case 'rpc-error':
      return `Could not read the provider's submission from the chain (${i.note}). Try again in a minute.`;
    case 'not-found':
      return "No provider submission was found in the ~8 hours of chain before the verdict, so the provider's "
        + 'commitment cannot be confirmed here.';
    case 'tx-mismatch':
      return `The submission found on chain ${String(i.note || '').replace(/^the submission found on chain /, '')}. `
        + 'Treat this verdict with suspicion.';
    default:
      return 'The deliverable could not be loaded, so the recomputation could not finish.';
  }
}

export function present(r) {
  const state = outcome(r);
  let [headline, color, note] = STATES[state] || STATES.error;
  if (state === 'unsupported') {
    const kinds = [...new Set(r.unsupported)].join(', ');
    headline = 'NOT REPLAYABLE HERE';
    color = 'var(--warn)';
    note = r.probeRecorded
      ? `everything else was recomputed and matches; the judge recorded the live probe as ${r.probeRecorded.map((b) => (b ? 'pass' : 'fail')).join(', ')}. `
        + `A ${kinds} check is a live network probe that nobody can replay later, so that one result rests on the judge.`
      : `this job uses ${kinds}, a live network probe that cannot be replayed; the checks below still ran.`;
  }
  const src = r.deliverableSource;
  let sourceText = !src ? null
    : src === 'submit() calldata' ? "Deliverable read from the provider's submit() calldata"
      : src === 'pasted' ? 'Deliverable pasted by you'
        : src === 'file' ? 'Deliverable read from the file you chose'
          : `Deliverable read from the ${src}`;
  if (sourceText && r.pasteNormalized === 'crlf') sourceText += ' (matched after restoring Windows line endings)';
  if (sourceText && r.submittedVia === 'contract wallet') sourceText += '; the provider submitted through a contract wallet';
  return {
    state, headline, color, note,
    pill: !r.verdict ? null : r.verdict.pass ? 'PASS (escrow released)' : 'REJECT (client refunded)',
    sourceText,
    incompleteText: state === 'incomplete' ? incompleteText(r) : null,
    canPaste: state === 'incomplete' && !!r.needsDeliverable,
    canRequestRuling: state === 'awaiting',
  };
}

/** Headline for a re-run with pasted text or a chosen file: blame the input only if the input failed. */
export function pasteHeadline(r) {
  const state = outcome(r);
  const what = r.deliverableSource === 'file' ? 'file' : 'deliverable';
  if (state === 'verified') return { ok: true, tone: 'ok', text: `VERIFIED with the ${what === 'file' ? 'chosen file' : 'pasted deliverable'}` };
  const d = (r.checks || []).find((c) => c.id === 'deliverable');
  if (d && !d.ok) {
    return { ok: false, tone: 'bad', text: `The ${what === 'file' ? 'file' : 'pasted content'} does not match the provider's on-chain commitment`
      + (what === 'file' ? '' : ' (if the original had unusual line endings or binary bytes, choose the file instead)') };
  }
  if (state === 'mismatch') return { ok: false, tone: 'bad', text: `The ${what === 'file' ? 'file' : 'pasted content'} matches, but the recomputation disagrees with the on-chain verdict` };
  if (state === 'unsupported') return { ok: false, tone: 'warn', text: present(r).note };
  return { ok: false, tone: 'warn', text: incompleteText(r) };
}
