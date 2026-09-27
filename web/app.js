// Judge Protocol explorer + in-browser verifier.
// Plain ES modules: no build step, no CDN. Every value is read live from an Arc
// RPC endpoint or recomputed locally. On the deployed site, chain reads go
// through a read-only same-origin relay (/api/rpc, source in web/api/rpc.js).
// Add ?rpc=direct to read rpc.testnet.arc.io straight from the browser; to rely
// on neither the relay nor this host's copy of the code, serve this folder
// locally from a checkout of the repo.

import { keccak_256 } from './vendor/noble/sha3.js';

const DIRECT_RPC = 'https://rpc.testnet.arc.io';

// Deployed (Vercel) reads go through the same-origin /api/rpc relay so a
// visitor's network or cross-origin rules can never make the page look broken.
// Local static hosting (localhost / file://, e.g. the README's python3 http
// server) has no such function, so it calls the Arc RPC directly, and so does
// any visit with ?rpc=direct.
const RPC_ENDPOINT = (() => {
  if (typeof location === 'undefined') return DIRECT_RPC;
  const h = location.hostname;
  const local = h === 'localhost' || h === '127.0.0.1' || h === '' || location.protocol === 'file:';
  const direct = /(^|[?&])rpc=direct(&|$)/.test(location.search || '');
  return local || direct ? DIRECT_RPC : '/api/rpc';
})();

export const CFG = {
  rpc: RPC_ENDPOINT,
  directRpc: DIRECT_RPC,
  chainId: 5042002,
  judge: '0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD',
  hook: '0xfe38bF336148eb3F2E1A5DEE8Ed89AC3B8bcF1c8',
  acp: '0x0747EEf0706327138c69792bF28Cd525089e4583',
  explorer: 'https://testnet.arcscan.app',
  judgeApi: 'https://judge-protocol-api.vercel.app',
  // Every job this evaluator has settled, newest first. Verified on-chain.
  knownJobs: [186741, 186740, 171925, 171507, 170857, 170856, 170855],
};

/* ------------------------------ input ------------------------------------ */
/**
 * Strict job id parser: plain ASCII digits only (spaces around are fine).
 * Anything else returns null instead of being guessed at ("12abc" is not 12).
 */
export function parseJobId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!/^[0-9]{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

/* ------------------------------ outcome ---------------------------------- */
// Every one of these must be present AND ok before a result may be called
// verified. A missing check is never a pass.
export const REQUIRED_CHECKS = [
  'evaluator', 'criteriaValid', 'criteriaHash', 'providerCommitment', 'deliverable',
  'score', 'threshold', 'pass', 'evidenceHash',
];

/**
 * 'verified' | 'mismatch' | 'unsupported' | 'incomplete' | 'error'.
 * A failed check always wins (mismatch). Something the page could not do
 * (a live http probe, an unreachable deliverable) is never verified and never
 * mismatch: it is unsupported or incomplete, and says so.
 */
export function outcome(r) {
  if (!r || r.error) return 'error';
  if (r.awaiting) return 'awaiting'; // named the judge, submitted, not ruled yet: never verified
  const checks = r.checks || [];
  if (checks.some((c) => !c.ok && c.id !== 'deliverableAvailable')) return 'mismatch';
  if (r.unsupported && r.unsupported.length) return 'unsupported';
  if (r.incomplete || r.needsDeliverable) return 'incomplete';
  const ids = new Set(checks.map((c) => c.id));
  return REQUIRED_CHECKS.every((id) => ids.has(id)) ? 'verified' : 'incomplete';
}

/* ------------------------------ hashing ---------------------------------- */
const enc = new TextEncoder();
// Matches Buffer.toString('utf8') in the service: invalid bytes become U+FFFD
// and a leading byte-order mark is kept, not stripped.
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
export const toHex = (u8) => '0x' + [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
export const keccakBytes = (u8) => toHex(keccak_256(u8));
export const keccakUtf8 = (s) => keccakBytes(enc.encode(s));

/** Stable stringify with sorted keys. Must match judge-service/src/criteria.js. */
export function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') {
    return Object.keys(x).sort().reduce((a, k) => { a[k] = sortKeys(x[k]); return a; }, {});
  }
  return x;
}
export const canonicalize = (o) => JSON.stringify(sortKeys(o));
export const criteriaHash = (criteria) => keccakUtf8(canonicalize(criteria));

async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(d)).slice(2);
}

/**
 * Base64 decoding that behaves exactly like Node's Buffer.from(s, 'base64'),
 * which is what the service uses: Node reads each UTF-16 code unit's low byte,
 * accepts the standard and URL-safe alphabets, skips anything else, and stops
 * at the first '='. So a non-ASCII character is not simply ignored: U+0141
 * reads as 'A', and an emoji's high surrogate reads as '=' and ends decoding.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function decodeBase64(input) {
  const s = String(input);
  const out = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = String.fromCharCode(s.charCodeAt(i) & 0xff);
    if (ch === '=') break;
    let v = B64.indexOf(ch);
    if (ch === '-') v = 62;
    if (ch === '_') v = 63;
    if (v < 0) continue;
    buf = ((buf << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

/** Resolve a data: URI to raw bytes, exactly as the service does. No network. */
export function resolveDataUri(uri) {
  if (!uri || !uri.startsWith('data:')) return null;
  return decodeBase64(uri.split(',')[1] || '');
}

/* ------------------------------ rpc / abi -------------------------------- */
let rpcId = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 4) {
  for (let attempt = 0; ; attempt++) {
    let j = null, transient = false, why = 'rpc error';
    try {
      const res = await fetch(CFG.rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      const text = await res.text();
      try { j = JSON.parse(text); } catch { j = null; }
      const busy = res.status === 429 || res.status >= 500; // rate limit, relay or upstream failure
      if (j && j.error) {
        // -32005 / "rate limit": throttled. -32603 "internal error": the public
        // endpoint's answer under load, which succeeds on retry.
        transient = busy || j.error.code === -32005 || j.error.code === -32603
          || /rate limit|internal error/i.test(j.error.message || '');
        why = j.error.message || 'rpc error';
      } else if (!j || busy) {
        transient = busy; why = `HTTP ${res.status}`;
        j = null;
      }
    } catch (e) {
      transient = true; why = e.message; // network failure
    }
    if (j && !j.error) return j.result;
    // The public endpoint rate-limits (as JSON-RPC errors, and at its edge as
    // plain HTTP 429s); back off rather than failing the page.
    if (transient && attempt < tries) { await sleep(600 * (attempt + 1)); continue; }
    throw new Error(why);
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
const isUri = (s) => /^(data:|ipfs:\/\/|https?:\/\/)/.test(s);

export const KNOWN_KINDS = ['checksum', 'schema', 'contains', 'length', 'http-endpoint'];

/** Bounds the judge enforces (judge-service/src/checkers/index.js LIMITS; a parity test holds them equal). */
export const LIMITS = { checks: 64, probes: 4, depth: 12, terms: 256, termChars: 1024, urlChars: 2048, probeTimeoutMs: 10_000 };
const TYPE_NAMES = ['string', 'number', 'boolean', 'object'];
const has = (v) => v !== undefined && v !== null; // null params are treated as absent
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringList = (v) => Array.isArray(v) && v.length <= LIMITS.terms
  && v.every((s) => typeof s === 'string' && s.length <= LIMITS.termChars);
const isNumberIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** True if any object or array nests deeper than `limit` (the root is level 1), without recursion. */
function nestsDeeperThan(value, limit) {
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (d > limit) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return false;
}

/** What is wrong with one check's params, or null (the judge's own rules). */
function paramsProblem(kind, p) {
  switch (kind) {
    case 'length':
      for (const k of ['min', 'max']) if (has(p[k]) && !isNumberIn(p[k], 0, Infinity)) return `${k} must be a number >= 0`;
      if (has(p.min) && has(p.max) && p.min > p.max) return 'min must not be above max';
      if (has(p.unit) && p.unit !== 'chars' && p.unit !== 'words') return 'unit must be "chars" or "words"';
      return null;
    case 'contains':
      if (has(p.all) && !isStringList(p.all)) return `all must be a list of at most ${LIMITS.terms} strings of at most ${LIMITS.termChars} characters`;
      return null;
    case 'schema':
      if (has(p.required) && !isStringList(p.required)) return `required must be a list of at most ${LIMITS.terms} field names`;
      if (has(p.types)) {
        if (!isPlainObject(p.types)) return 'types must be an object of field: type';
        const entries = Object.entries(p.types);
        if (entries.length > LIMITS.terms) return `types may name at most ${LIMITS.terms} fields`;
        for (const [field, type] of entries) if (!TYPE_NAMES.includes(type)) return `types.${field} must be one of ${TYPE_NAMES.join(', ')}`;
      }
      return null;
    case 'checksum':
      if (typeof p.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(p.sha256)) return 'sha256 must be 64 hex characters (no 0x)';
      return null;
    case 'http-endpoint':
      if (has(p.url) && (typeof p.url !== 'string' || p.url.length > LIMITS.urlChars)) return `url must be a string of at most ${LIMITS.urlChars} characters`;
      if (has(p.expectStatus) && !(Number.isInteger(p.expectStatus) && p.expectStatus >= 100 && p.expectStatus <= 599)) return 'expectStatus must be an integer from 100 to 599';
      if (has(p.bodyIncludes) && !isStringList(p.bodyIncludes)) return `bodyIncludes must be a list of at most ${LIMITS.terms} strings`;
      if (has(p.timeoutMs) && !isNumberIn(p.timeoutMs, 1, LIMITS.probeTimeoutMs)) return `timeoutMs must be a number from 1 to ${LIMITS.probeTimeoutMs}`;
      return null;
    default:
      return null;
  }
}

/** Mirror of judge-service validateCriteria: criteria the service refuses to score. */
export function validateCriteria(criteria) {
  if (!criteria || typeof criteria !== 'object') return { valid: false, reason: 'criteria is not an object' };
  if (nestsDeeperThan(criteria, LIMITS.depth)) return { valid: false, reason: `criteria nest deeper than ${LIMITS.depth} levels` };
  if (!Array.isArray(criteria.checks) || criteria.checks.length === 0) {
    return { valid: false, reason: 'criteria.checks must be a non-empty array' };
  }
  if (criteria.checks.length > LIMITS.checks) return { valid: false, reason: `at most ${LIMITS.checks} checks` };
  if (criteria.passThreshold !== undefined) {
    const t = criteria.passThreshold;
    if (!Number.isInteger(t) || t < 0 || t > 100) return { valid: false, reason: `passThreshold must be an integer in [0,100], got ${t}` };
  }
  for (let i = 0; i < criteria.checks.length; i++) {
    const c = criteria.checks[i];
    if (!c || typeof c !== 'object') return { valid: false, reason: `checks[${i}] is not an object` };
    if (!KNOWN_KINDS.includes(c.kind)) return { valid: false, reason: `checks[${i}] unknown kind "${c.kind}"` };
    if (c.weight !== undefined && (typeof c.weight !== 'number' || !Number.isFinite(c.weight) || c.weight <= 0)) {
      return { valid: false, reason: `checks[${i}] weight must be a finite number > 0, got ${c.weight}` };
    }
    if (has(c.params) && !isPlainObject(c.params)) return { valid: false, reason: `checks[${i}].params must be an object` };
    const problem = paramsProblem(c.kind, c.params ?? {});
    if (problem) return { valid: false, reason: `checks[${i}] (${c.kind}): ${problem}` };
  }
  if (criteria.checks.filter((c) => c.kind === 'http-endpoint').length > LIMITS.probes) {
    return { valid: false, reason: `at most ${LIMITS.probes} http-endpoint checks` };
  }
  return { valid: true, reason: 'ok' };
}

/**
 * The deterministic checkers, mirroring judge-service/src/checkers/index.js.
 * web/test/verify-parity.test.mjs runs both on the same inputs so they cannot
 * drift. http-endpoint is a live network probe: it cannot be replayed here, so
 * it is marked unsupported instead of being scored.
 */
const CHECKERS = {
  checksum: async (p, d) => {
    const actual = await sha256Hex(d.bytes);
    const pass = actual.toLowerCase() === String(p.sha256 || '').toLowerCase();
    return { pass, detail: `sha256 ${actual.slice(0, 16)}… ${pass ? '==' : '!='} expected ${String(p.sha256).slice(0, 16)}…` };
  },
  schema: (p, d) => {
    let obj;
    try { obj = JSON.parse(d.text); } catch { return { pass: false, detail: 'deliverable is not valid JSON' }; }
    if (obj === null || typeof obj !== 'object') return { pass: false, detail: 'deliverable is not a JSON object' };
    const required = p.required || [];
    const missing = required.filter((f) => !(f in obj));
    const typeErrors = [];
    for (const [field, type] of Object.entries(p.types || {})) {
      if (field in obj && typeof obj[field] !== type) typeErrors.push(`${field}: expected ${type}, got ${typeof obj[field]}`);
    }
    const pass = missing.length === 0 && typeErrors.length === 0;
    return { pass, detail: pass ? `schema ok (${required.length} required fields present)` : `missing=[${missing.join(',')}] typeErrors=[${typeErrors.join(',')}]` };
  },
  contains: (p, d) => {
    const terms = p.all || [];
    const missing = terms.filter((t) => !d.text.includes(t));
    return { pass: missing.length === 0, detail: missing.length ? `missing terms: ${missing.join(', ')}` : `all ${terms.length} terms present` };
  },
  length: (p, d) => {
    const n = p.unit === 'chars' ? d.text.length : d.text.trim().split(/\s+/).filter(Boolean).length;
    const min = p.min ?? 0, max = p.max ?? Infinity;
    return { pass: n >= min && n <= max, detail: `${p.unit === 'chars' ? 'chars' : 'words'}=${n} (need ${min} to ${max === Infinity ? 'any' : max})` };
  },
  'http-endpoint': () => ({ pass: false, unsupported: true, detail: 'live network probe, recorded once by the judge' }),
};

/** Recompute score/pass exactly as the service does, over the raw deliverable bytes. */
export async function runChecks(criteria, bytes) {
  const d = { bytes, text: utf8.decode(bytes) };
  const results = [], unsupported = [];
  let wSum = 0, wPass = 0;
  for (const c of criteria.checks || []) {
    const fn = CHECKERS[c.kind];
    const r = fn ? await fn(c.params || {}, d) : { pass: false, detail: `unknown checker kind: ${c.kind}` };
    if (r.unsupported) unsupported.push(c.kind);
    const w = c.weight ?? 1;
    results.push({ ...r, kind: c.kind, weight: w });
    wSum += w; if (r.pass) wPass += w;
  }
  const score = wSum === 0 ? 0 : Math.round((wPass / wSum) * 100);
  const threshold = criteria.passThreshold ?? 100;
  return { results, score, threshold, pass: score >= threshold, unsupported };
}

/** The evidence core. Must mirror judge-service/src/evidence.js exactly. */
export function evidenceCore({ jobId, criteriaHash: ch, deliverable, criteria, results, score, threshold, pass }) {
  return {
    jobId: String(jobId), criteriaHash: ch, deliverable, criteria,
    checks: (results || []).map((r) => ({ kind: r.kind, pass: !!r.pass, weight: r.weight ?? 1 })),
    score, threshold, pass: !!pass,
  };
}
export const evidenceHashOf = (o) => keccakUtf8(canonicalize(evidenceCore(o)));

/* --------------------------- provider submission ------------------------- */
/**
 * Recover the PROVIDER's own submission from chain data: the JobSubmitted log
 * (whose data is the provider's bytes32 commitment) and the provider's
 * submit() transaction (whose optParams carry the deliverable URI).
 *
 * The public endpoint refuses eth_getLogs ranges wider than 10,000 blocks and
 * no longer indexes older transactions by hash. So the page jumps to the block
 * near the verdict's own timestamp, searches backwards from a little past it in
 * 5,000-block windows, and loads the transaction by block number and index.
 * None of this is a trust assumption: the transaction must be submit() to the
 * ACP for this exact job, and its commitment must match the log.
 */
const JOB_SUBMITTED_TOPIC = keccakUtf8('JobSubmitted(uint256,address,bytes32)');
const SUBMIT_SELECTOR = '0x9e63798d'; // submit(uint256,bytes32,bytes)
export const LOG_SPAN = 5000n;
const LOG_WINDOWS = 13; // one window of slack past the verdict, then about 8 hours before it

async function blockTs(n) {
  const b = await rpc('eth_getBlockByNumber', ['0x' + n.toString(16), false]);
  if (!b) throw new Error(`block ${n} not available`);
  return BigInt(b.timestamp);
}

/**
 * A block a little after unix time `ts`, found by secant search on block
 * timestamps (a handful of calls on a chain with steady block times), with a
 * bisection fallback. The verdict timestamp comes from the judge's own clock,
 * so the result is padded by one log window to absorb clock lag.
 */
export async function blockNear(ts) {
  const target = BigInt(ts);
  const latest = BigInt(await rpc('eth_blockNumber', []));
  const pad = (b) => (b + LOG_SPAN > latest ? latest : b + LOG_SPAN);
  let x0 = latest, t0 = await blockTs(x0);
  if (target >= t0) return latest;
  let x1 = x0 > 1000000n ? x0 - 1000000n : 1n, t1 = await blockTs(x1);
  for (let i = 0; i < 8; i++) {
    const err = t1 - target;
    if (err >= -30n && err <= 30n) return pad(x1);
    const dt = t1 - t0;
    const step = dt === 0n ? err * 2n : (err * (x1 - x0)) / dt;
    let x2 = x1 - step;
    if (x2 < 1n) x2 = 1n;
    if (x2 > latest) x2 = latest;
    if (x2 === x1) break;
    x0 = x1; t0 = t1; x1 = x2; t1 = await blockTs(x1);
  }
  let lo = 1n, hi = latest;
  for (let i = 0; i < 64 && hi - lo > LOG_SPAN / 4n; i++) {
    const mid = (lo + hi) / 2n;
    if ((await blockTs(mid)) < target) lo = mid; else hi = mid;
  }
  return pad(hi);
}

class TxMismatch extends Error {}

export async function fetchProviderSubmission(jobId, verdictTimestamp) {
  const top = await blockNear(verdictTimestamp);
  const topic1 = '0x' + BigInt(jobId).toString(16).padStart(64, '0');
  let log = null;
  for (let w = 0n; w < BigInt(LOG_WINDOWS) && !log; w++) {
    const to = top - LOG_SPAN * w;
    if (to < 1n) break;
    const from = to >= LOG_SPAN ? to - LOG_SPAN + 1n : 1n;
    const logs = await rpc('eth_getLogs', [{
      address: CFG.acp, topics: [JOB_SUBMITTED_TOPIC, topic1],
      fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
    }]);
    if (logs.length) log = logs[logs.length - 1];
  }
  if (!log) return null;
  // The commitment is what the ACP itself emitted for this job. That is the
  // binding; the transaction below is only a source for the deliverable URI.
  const committed = (log.data || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(committed)) throw new TxMismatch('the JobSubmitted log carries no 32-byte commitment');

  let tx = await rpc('eth_getTransactionByBlockNumberAndIndex', [log.blockNumber, log.transactionIndex]);
  if (!tx) tx = await rpc('eth_getTransactionByHash', [log.transactionHash]);
  if (tx && tx.hash && tx.hash.toLowerCase() !== log.transactionHash.toLowerCase()) {
    throw new TxMismatch('the node returned a different transaction than the one that emitted the log');
  }
  const input = ((tx && tx.input) || '').toLowerCase();
  const d = input.slice(10);
  const direct = !!tx && (tx.to || '').toLowerCase() === CFG.acp.toLowerCase()
    && input.startsWith(SUBMIT_SELECTOR) && d.length >= 192 && BigInt('0x' + d.slice(0, 64)) === BigInt(jobId);
  if (!direct) {
    // Submitted through a contract wallet (or the tx is unavailable). The
    // service cannot decode the provider's URI from such a call either, and
    // falls back to the job description; so does this page.
    return { txHash: log.transactionHash, committed, optParams: '', uri: null, via: tx ? 'contract wallet' : 'unknown' };
  }
  if ('0x' + d.slice(64, 128) !== committed) {
    throw new TxMismatch('the submit() calldata commits to a different deliverable than the log');
  }
  // submit(uint256 jobId, bytes32 deliverable, bytes optParams)
  const off = parseInt(d.slice(128, 192), 16) * 2;
  const len = parseInt(d.slice(off, off + 64), 16);
  let optParams = '';
  if (Number.isFinite(len) && len > 0) {
    const body = d.slice(off + 64, off + 64 + len * 2);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = parseInt(body.substr(i * 2, 2), 16);
    optParams = utf8.decode(bytes);
  }
  // Same precedence as judge-service engine.js resolveDeliverableSource.
  const uri = optParams ? (extractDeliverableURI(optParams) || (isUri(optParams.trim()) ? optParams.trim() : null)) : null;
  return { txHash: log.transactionHash, committed, optParams, uri, via: 'direct submit()' };
}

/* ------------------------------- verification ---------------------------- */
/**
 * Full independent verification of one job, using only public inputs.
 * Returns a list of named checks with pass/fail so the UI can show the audit.
 */
export async function verifyJob(jobId, pastedDeliverable) {
  const out = { jobId, checks: [], job: null, verdict: null };
  // The verdict decides whether there is anything to verify; a missing or
  // unreadable job only matters once a verdict exists.
  const [jobRes, verdictRes] = await Promise.allSettled([getJob(jobId), getVerdict(jobId)]);
  if (verdictRes.status === 'rejected') throw verdictRes.reason;
  const verdict = verdictRes.value;
  out.verdict = verdict;
  if (!verdict || verdict.timestamp === 0) {
    // No ruling yet. Say exactly why, and whether asking the judge could help.
    out.verdict = null;
    const job = jobRes.status === 'fulfilled' ? jobRes.value : null;
    if (!job || /^0x0{40}$/i.test(job.evaluator || '')) { out.error = 'No such job on the ERC-8183 contract.'; return out; }
    out.job = job;
    if (job.evaluator.toLowerCase() !== CFG.judge.toLowerCase()) {
      out.error = `This job names a different evaluator (${job.evaluator}), so Judge Protocol does not rule on it.`;
      return out;
    }
    if (job.status === 'Submitted') { out.awaiting = { status: job.status }; return out; }
    if (job.status === 'Open' || job.status === 'Funded') { out.error = 'This job has not been submitted yet, so there is nothing to rule on.'; return out; }
    if (job.status === 'Expired') { out.error = 'This job expired without a ruling; the client can claim a refund.'; return out; }
    out.error = 'No on-chain verdict recorded for this job.';
    return out;
  }
  if (jobRes.status === 'rejected') throw jobRes.reason;
  const job = jobRes.value;
  out.job = job;
  if (!job) { out.error = 'Job not found on the canonical contract.'; return out; }

  const add = (id, label, ok, got, want) => out.checks.push({ id, label, ok, got, want });

  // Compare addresses case-insensitively; show one canonical form so a mere
  // checksum-casing difference does not read as a mismatch.
  const evalOk = job.evaluator.toLowerCase() === CFG.judge.toLowerCase();
  add('evaluator', 'Job named this evaluator', evalOk, evalOk ? CFG.judge : job.evaluator, CFG.judge);

  const criteria = extractCriteria(job.description);
  if (!criteria) { out.error = 'No judge-criteria block in the job description.'; return out; }
  out.criteria = criteria;
  const valid = validateCriteria(criteria);
  add('criteriaValid', 'Criteria are well-formed (the service never scores invalid criteria)', valid.valid,
    valid.valid ? 'valid' : valid.reason, 'valid');
  const ch = criteriaHash(criteria);
  add('criteriaHash', 'criteriaHash recomputed from the immutable job description', ch.toLowerCase() === verdict.criteriaHash.toLowerCase(), ch, verdict.criteriaHash);

  // The provider's own on-chain submission: its commitment binds the verdict to
  // what the provider actually delivered, whatever the content source below.
  let sub = null;
  try {
    sub = await fetchProviderSubmission(jobId, verdict.timestamp);
    if (!sub) out.incomplete = { reason: 'not-found' };
  } catch (e) {
    out.incomplete = e instanceof TxMismatch
      ? { reason: 'tx-mismatch', note: e.message }
      : { reason: 'rpc-error', note: e.message };
  }
  if (sub) {
    out.submitTx = sub.txHash;
    out.committed = sub.committed;
    out.submittedVia = sub.via;
    add('providerCommitment', "Verdict grades the provider's own on-chain commitment",
      sub.committed.toLowerCase() === verdict.deliverable.toLowerCase(), sub.committed, verdict.deliverable);
  }

  // Content: pasted, else the provider's URI, else (only when the provider gave
  // none) the client-authored description. Remote URIs are not fetched.
  let bytes = null;
  if (pastedDeliverable instanceof Uint8Array) {
    bytes = pastedDeliverable;
    out.deliverableSource = 'file';
  } else if (pastedDeliverable != null) {
    // Browsers normalize line endings in text areas (CRLF becomes LF). If the
    // CRLF form is what the provider committed to, it is the committed content.
    const text = String(pastedDeliverable);
    bytes = enc.encode(text);
    if (sub && text.includes('\n') && !text.includes('\r')) {
      const crlf = enc.encode(text.replace(/\n/g, '\r\n'));
      if (keccakBytes(bytes) !== sub.committed && keccakBytes(crlf) === sub.committed) {
        bytes = crlf;
        out.pasteNormalized = 'crlf';
      }
    }
    out.deliverableSource = 'pasted';
  } else if (sub) {
    const descUri = extractDeliverableURI(job.description);
    const src = sub.uri ? { uri: sub.uri, from: 'submit() calldata' }
      : descUri ? { uri: descUri, from: 'job description (client-authored)' } : null;
    if (!src) out.incomplete = { reason: 'no-uri' };
    else if (src.uri.startsWith('data:')) { bytes = resolveDataUri(src.uri); out.deliverableSource = src.from; }
    else out.incomplete = { reason: 'remote-uri', uri: src.uri, from: src.from };
  }
  if (bytes == null) {
    out.needsDeliverable = !!sub; // pasting only helps when the commitment is known
    add('deliverableAvailable', 'Deliverable content available', false, null, null);
    return out;
  }
  const dh = keccakBytes(bytes);
  const dOk = dh.toLowerCase() === verdict.deliverable.toLowerCase();
  add('deliverable', 'Deliverable content hashes to the on-chain commitment', dOk, dh, verdict.deliverable);
  out.deliverable = utf8.decode(bytes);
  if (!dOk || !valid.valid) return out; // everything downstream would be meaningless

  const { results, score, threshold, pass, unsupported } = await runChecks(criteria, bytes);
  out.results = results;
  if (unsupported.length) {
    // A live probe cannot be replayed, but its pass bit is inside the signed
    // evidence. Try every outcome of the probes: if one reproduces the on-chain
    // score, decision and evidenceHash, everything else is verified and we know
    // what the judge recorded; if none does, the deterministic part is a lie.
    out.unsupported = unsupported;
    const probes = results.map((x, i) => (x.unsupported ? i : -1)).filter((i) => i >= 0);
    if (probes.length > 8) return out; // too many to enumerate; stays not-replayable
    let match = null, scoreSeen = false, passSeen = false;
    for (let mask = 0; mask < (1 << probes.length) && !match; mask++) {
      const trial = results.map((x) => ({ ...x }));
      probes.forEach((ri, b) => { trial[ri].pass = !!(mask & (1 << b)); });
      let w = 0, wp = 0;
      for (const x of trial) { w += x.weight; if (x.pass) wp += x.weight; }
      const sc = w === 0 ? 0 : Math.round((wp / w) * 100), ps = sc >= threshold;
      if (sc === verdict.score) scoreSeen = true;
      if (ps === verdict.pass) passSeen = true;
      const eh = evidenceHashOf({ jobId, criteriaHash: ch, deliverable: verdict.deliverable, criteria, results: trial, score: sc, threshold, pass: ps });
      if (eh.toLowerCase() === verdict.evidenceHash.toLowerCase() && sc === verdict.score && ps === verdict.pass) {
        match = { mask, sc, ps, eh };
      }
    }
    const note = 'for some outcome of the live probe';
    add('score', `Score recomputed (${note})`, scoreSeen, match ? String(match.sc) : 'no probe outcome gives it', String(verdict.score));
    add('threshold', 'Threshold matches', threshold === verdict.threshold, String(threshold), String(verdict.threshold));
    add('pass', `Pass/reject decision matches (${note})`, passSeen, match ? String(match.ps) : 'no probe outcome gives it', String(verdict.pass));
    add('evidenceHash', `evidenceHash recomputed (${note})`, !!match, match ? match.eh : 'no probe outcome reproduces it', verdict.evidenceHash);
    if (match) out.probeRecorded = probes.map((_, b) => !!(match.mask & (1 << b)));
    return out;
  }
  add('score', 'Score recomputed', score === verdict.score, String(score), String(verdict.score));
  add('threshold', 'Threshold matches', threshold === verdict.threshold, String(threshold), String(verdict.threshold));
  add('pass', 'Pass/reject decision matches', pass === verdict.pass, String(pass), String(verdict.pass));

  const eh = evidenceHashOf({ jobId, criteriaHash: ch, deliverable: verdict.deliverable, criteria, results, score, threshold, pass });
  add('evidenceHash', 'evidenceHash recomputed from inputs', eh.toLowerCase() === verdict.evidenceHash.toLowerCase(), eh, verdict.evidenceHash);

  if (!sub) out.incomplete = out.incomplete || { reason: 'not-found' };
  out.verified = outcome(out) === 'verified';
  return out;
}

export async function acpJobCounter() {
  const d = await call(CFG.acp, SEL.jobCounter);
  return Number(toInt(word(d, 0)));
}
