// Judge Protocol explorer + in-browser verifier.
// No build step, no CDN, no backend. Everything here is either read live from an
// Arc RPC endpoint or recomputed locally, so a visitor can confirm a verdict
// without trusting this page or its author.

import { keccak_256 } from './vendor/noble/sha3.js';

// Deployed (Vercel) reads go through the same-origin /api/rpc proxy so a
// visitor's network or cross-origin rules can never make the page look broken.
// Local static hosting (localhost / file://, e.g. the README's python3 http
// server) has no such function, so it calls the Arc RPC directly.
const RPC_ENDPOINT = (() => {
  if (typeof location === 'undefined') return 'https://rpc.testnet.arc.io';
  const h = location.hostname;
  const local = h === 'localhost' || h === '127.0.0.1' || h === '' || location.protocol === 'file:';
  return local ? 'https://rpc.testnet.arc.io' : '/api/rpc';
})();

export const CFG = {
  rpc: RPC_ENDPOINT,
  chainId: 5042002,
  judge: '0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD',
  hook: '0xfe38bF336148eb3F2E1A5DEE8Ed89AC3B8bcF1c8',
  acp: '0x0747EEf0706327138c69792bF28Cd525089e4583',
  explorer: 'https://testnet.arcscan.app',
  // Jobs settled by this evaluator, newest first. Verified on-chain.
  knownJobs: [171925, 171507, 170857, 170856],
};

/* ------------------------------ hashing ---------------------------------- */
const enc = new TextEncoder();
export const toHex = (u8) => '0x' + [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
export const keccakUtf8 = (s) => toHex(keccak_256(enc.encode(s)));

/** Stable stringify with sorted keys — must match judge-service/src/criteria.js. */
export function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') {
    return Object.keys(x).sort().reduce((a, k) => { a[k] = sortKeys(x[k]); return a; }, {});
  }
  return x;
}
export const canonicalize = (o) => JSON.stringify(sortKeys(o));
export const criteriaHash = (criteria) => keccakUtf8(canonicalize(criteria));

/* ------------------------------ rpc / abi -------------------------------- */
let rpcId = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 4) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(CFG.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    const j = await res.json();
    if (!j.error) return j.result;
    // The public endpoint rate-limits; back off rather than failing the page.
    const rateLimited = j.error.code === -32005 || /rate limit/i.test(j.error.message || '');
    if (rateLimited && attempt < tries) { await sleep(600 * (attempt + 1)); continue; }
    throw new Error(j.error.message || 'rpc error');
  }
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const toInt = (w) => BigInt('0x' + w);
const toAddr = (w) => '0x' + w.slice(24);

// selectors (cast sig)
const SEL = {
  verdictCount: '0x64a8cbe7', completedCount: '0xb3c9e0fa', rejectedCount: '0x26a4565e',
  paused: '0x5c975abb', guardian: '0x452a9320',
  getVerdict: '0x33f3e74b', getJob: '0xbf22c457', jobCounter: '0x50355d76',
};
const arg = (n) => BigInt(n).toString(16).padStart(64, '0');

export async function judgeStats() {
  const [vc, cc, rc, p, g] = await Promise.all([
    call(CFG.judge, SEL.verdictCount), call(CFG.judge, SEL.completedCount),
    call(CFG.judge, SEL.rejectedCount), call(CFG.judge, SEL.paused),
    call(CFG.judge, SEL.guardian),
  ]);
  return {
    verdicts: Number(toInt(word(vc, 0))), completed: Number(toInt(word(cc, 0))),
    rejected: Number(toInt(word(rc, 0))), paused: toInt(word(p, 0)) === 1n,
    guardian: toAddr(word(g, 0)),
  };
}

/** Verdict struct: jobId, criteriaHash, deliverable, score, threshold, pass, evidenceHash, timestamp */
export async function getVerdict(jobId) {
  const d = await call(CFG.judge, SEL.getVerdict + arg(jobId));
  if (!d || d === '0x') return null;
  return {
    jobId: Number(toInt(word(d, 0))),
    criteriaHash: '0x' + word(d, 1),
    deliverable: '0x' + word(d, 2),
    score: Number(toInt(word(d, 3))),
    threshold: Number(toInt(word(d, 4))),
    pass: toInt(word(d, 5)) === 1n,
    evidenceHash: '0x' + word(d, 6),
    timestamp: Number(toInt(word(d, 7))),
  };
}

const STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'];

/** Job struct has a dynamic string, so the return is an offset-wrapped tuple. */
export async function getJob(jobId) {
  const d = await call(CFG.acp, SEL.getJob + arg(jobId));
  if (!d || d === '0x') return null;
  const base = Number(toInt(word(d, 0))) / 32; // offset to the tuple head
  const at = (i) => word(d, base + i);
  const descOff = Number(toInt(at(4))) / 32;
  const dLen = Number(toInt(word(d, base + descOff)));
  let hexStr = '';
  for (let i = 0; i * 32 < dLen; i++) hexStr += word(d, base + descOff + 1 + i);
  const bytes = new Uint8Array(dLen);
  for (let i = 0; i < dLen; i++) bytes[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  return {
    id: Number(toInt(at(0))), client: toAddr(at(1)), provider: toAddr(at(2)),
    evaluator: toAddr(at(3)), description: new TextDecoder().decode(bytes),
    budget: toInt(at(5)), expiredAt: Number(toInt(at(6))),
    status: STATUS[Number(toInt(at(7)))] ?? 'unknown', hook: toAddr(at(8)),
  };
}

/* ---------------------------- criteria + checks -------------------------- */
export function extractCriteria(description) {
  const m = (description || '').match(/```judge-criteria\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
export function extractDeliverableURI(text) {
  const m = (text || '').match(/deliverableURI:\s*(\S+)/);
  return m ? m[1] : null;
}

/** The deterministic checkers, reimplemented for local recomputation. */
const CHECKERS = {
  length: (p, text) => {
    const n = p.unit === 'chars' ? text.length : text.trim().split(/\s+/).filter(Boolean).length;
    const min = p.min ?? 0, max = p.max ?? Infinity;
    return { pass: n >= min && n <= max, detail: `${p.unit === 'chars' ? 'chars' : 'words'}=${n} (need ${min}–${max === Infinity ? '∞' : max})` };
  },
  contains: (p, text) => {
    const missing = (p.all || []).filter((t) => !text.includes(t));
    return { pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : `all ${(p.all || []).length} terms present` };
  },
  checksum: () => ({ pass: false, detail: 'checksum needs sha256; verify with the CLI' }),
  schema: (p, text) => {
    let o; try { o = JSON.parse(text); } catch { return { pass: false, detail: 'not valid JSON' }; }
    const missing = (p.required || []).filter((f) => !(f in o));
    return { pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(',')}` : 'schema ok' };
  },
  'http-endpoint': () => ({ pass: false, detail: 'live probe not reproducible in-browser' }),
};

/** Recompute score/pass exactly as the service does. */
export function runChecks(criteria, text) {
  const results = [];
  let wSum = 0, wPass = 0;
  for (const c of criteria.checks || []) {
    const fn = CHECKERS[c.kind];
    const r = fn ? fn(c.params || {}, text) : { pass: false, detail: `unknown kind ${c.kind}` };
    const w = c.weight ?? 1;
    results.push({ ...r, kind: c.kind, weight: w });
    wSum += w; if (r.pass) wPass += w;
  }
  const score = wSum === 0 ? 0 : Math.round((wPass / wSum) * 100);
  const threshold = criteria.passThreshold ?? 100;
  return { results, score, threshold, pass: score >= threshold };
}

/** The evidence core — must mirror judge-service/src/evidence.js exactly. */
export function evidenceCore({ jobId, criteriaHash: ch, deliverable, criteria, results, score, threshold, pass }) {
  return {
    jobId: String(jobId), criteriaHash: ch, deliverable, criteria,
    checks: (results || []).map((r) => ({ kind: r.kind, pass: !!r.pass, weight: r.weight ?? 1 })),
    score, threshold, pass: !!pass,
  };
}
export const evidenceHashOf = (o) => keccakUtf8(canonicalize(evidenceCore(o)));

/**
 * Recover the PROVIDER-authored deliverable straight from chain data: find the
 * JobSubmitted log, load the provider's own submit() transaction, and decode the
 * optParams tail. This is what makes in-browser verification trustless: the page
 * never has to be handed the content by us.
 * The public RPC caps eth_getLogs at 20k blocks, so walk backwards in windows.
 */
const JOB_SUBMITTED_TOPIC = keccakUtf8('JobSubmitted(uint256,address,bytes32)');

export async function fetchProviderDeliverable(jobId, maxWindows = 6) {
  const latest = BigInt(await rpc('eth_blockNumber', []));
  const topic1 = '0x' + BigInt(jobId).toString(16).padStart(64, '0');
  const SPAN = 20000n;
  let txHash = null;
  for (let w = 0; w < maxWindows && !txHash; w++) {
    const to = latest - SPAN * BigInt(w);
    if (to <= 0n) break;
    const from = to > SPAN ? to - SPAN : 0n;
    const logs = await rpc('eth_getLogs', [{
      address: CFG.acp, topics: [JOB_SUBMITTED_TOPIC, topic1],
      fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
    }]);
    if (logs.length) txHash = logs[0].transactionHash;
    if (from === 0n) break;
  }
  if (!txHash) return null;

  const tx = await rpc('eth_getTransactionByHash', [txHash]);
  // submit(uint256 jobId, bytes32 deliverable, bytes optParams)
  const d = (tx.input || '').slice(10);
  if (d.length < 192) return null;
  const off = parseInt(d.slice(128, 192), 16) * 2;
  const len = parseInt(d.slice(off, off + 64), 16);
  if (!Number.isFinite(len) || len === 0) return null;
  const body = d.slice(off + 64, off + 64 + len * 2);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(body.substr(i * 2, 2), 16);
  const s = new TextDecoder().decode(bytes);
  const uri = extractDeliverableURI(s) || (/^(data|https?|ipfs):/.test(s.trim()) ? s.trim() : null);
  return { txHash, optParams: s, uri, content: uri ? resolveDataUri(uri) : null };
}

/** Resolve a data: URI locally. Remote fetches are deliberately not attempted. */
export function resolveDataUri(uri) {
  if (!uri || !uri.startsWith('data:')) return null;
  const b64 = uri.split(',')[1] || '';
  try { return decodeURIComponent(escape(atob(b64))); } catch { return atob(b64); }
}

/**
 * Full independent verification of one job, using only public inputs.
 * Returns a list of named checks with pass/fail so the UI can show the audit.
 */
export async function verifyJob(jobId, pastedDeliverable) {
  const out = { jobId, checks: [], job: null, verdict: null };
  const [job, verdict] = await Promise.all([getJob(jobId), getVerdict(jobId)]);
  out.job = job; out.verdict = verdict;
  if (!verdict || verdict.timestamp === 0) { out.error = 'No on-chain verdict recorded for this job.'; return out; }
  if (!job) { out.error = 'Job not found on the canonical contract.'; return out; }

  const add = (label, ok, got, want) => out.checks.push({ label, ok, got, want });

  // Compare addresses case-insensitively; show one canonical form so a mere
  // checksum-casing difference does not read as a mismatch.
  const evalOk = job.evaluator.toLowerCase() === CFG.judge.toLowerCase();
  add('Job named this evaluator', evalOk, evalOk ? CFG.judge : job.evaluator, evalOk ? CFG.judge : CFG.judge);

  const criteria = extractCriteria(job.description);
  if (!criteria) { out.error = 'No judge-criteria block in the job description.'; return out; }
  const ch = criteriaHash(criteria);
  add('criteriaHash recomputed from the immutable job description', ch.toLowerCase() === verdict.criteriaHash.toLowerCase(), ch, verdict.criteriaHash);
  out.criteria = criteria;

  // Deliverable: the provider supplies it in their own submit() calldata. Pull it
  // from chain data so nothing has to be taken on trust; fall back to a data: URI
  // in the description, then to a pasted copy. Whatever the source, it only counts
  // if it hashes to the on-chain commitment.
  let text = pastedDeliverable ?? null;
  if (text == null) {
    try {
      const fetched = await fetchProviderDeliverable(jobId);
      if (fetched) {
        out.submitTx = fetched.txHash;
        out.deliverableSource = 'provider submit() calldata';
        text = fetched.content;
      }
    } catch (e) { out.fetchNote = 'could not read submit calldata: ' + e.message; }
  }
  if (text == null) text = resolveDataUri(extractDeliverableURI(job.description));
  if (text == null) {
    out.needsDeliverable = true;
    add('Deliverable content available', false, 'not provided', 'paste the deliverable text');
    return out;
  }
  const dh = keccakUtf8(text);
  const dOk = dh.toLowerCase() === verdict.deliverable.toLowerCase();
  add('Deliverable content hashes to the on-chain commitment', dOk, dh, verdict.deliverable);
  out.deliverable = text;
  if (!dOk) return out; // wrong content: stop, everything downstream is meaningless

  const { results, score, threshold, pass } = runChecks(criteria, text);
  add('Score recomputed', score === verdict.score, String(score), String(verdict.score));
  add('Threshold matches', threshold === verdict.threshold, String(threshold), String(verdict.threshold));
  add('Pass/reject decision matches', pass === verdict.pass, String(pass), String(verdict.pass));

  const eh = evidenceHashOf({ jobId, criteriaHash: ch, deliverable: verdict.deliverable, criteria, results, score, threshold, pass });
  add('evidenceHash recomputed from inputs', eh.toLowerCase() === verdict.evidenceHash.toLowerCase(), eh, verdict.evidenceHash);

  out.results = results;
  out.verified = out.checks.every((c) => c.ok);
  return out;
}

export async function acpJobCounter() {
  const d = await call(CFG.acp, SEL.jobCounter);
  return Number(toInt(word(d, 0)));
}
