// A small, hermetic stand-in for the Arc testnet JSON-RPC, built from real
// recorded chain data (test/fixtures/arc-testnet-jobs.json). It reproduces the
// public endpoint's real constraints so the verifier is tested against them:
//   - eth_getLogs refuses ranges wider than 5,000 blocks
//   - eth_getTransactionByHash returns null for old transactions (pruned index)
//   - block timestamps follow the recorded chain (piecewise linear between
//     real recorded blocks)
// Mutation hooks let a test tamper with one input and assert the verifier
// refuses to call the result verified.
import { readFileSync } from 'node:fs';

export const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/arc-testnet-jobs.json', import.meta.url), 'utf8'),
);

export const ACP = '0x0747eef0706327138c69792bf28cd525089e4583';
export const JUDGE = '0x6eff7d4bb514d341abed90bf4c667d0a980173ad';
const SEL_GET_JOB = '0xbf22c457';
const SEL_GET_VERDICT = '0x33f3e74b';
export const MAX_LOG_SPAN = 5000;

const hex = (n) => '0x' + BigInt(n).toString(16);
const ZERO_VERDICT = '0x' + '0'.repeat(64 * 8);

const anchors = Object.entries(FIXTURE.anchors)
  .map(([b, t]) => [Number(b), Number(t)])
  .sort((a, b) => a[0] - b[0]);

export function timestampAt(n) {
  if (n <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [b1, t1] = anchors[i];
    if (n <= b1) {
      const [b0, t0] = anchors[i - 1];
      return Math.floor(t0 + ((t1 - t0) * (n - b0)) / (b1 - b0));
    }
  }
  return anchors[anchors.length - 1][1];
}

const jobIdOf = (data) => (data.length >= 74 ? BigInt('0x' + data.slice(10, 74)) : -1n);
const STATS = { // JudgeEvaluator view calls used by the stats cards
  '0x64a8cbe7': 5, '0xb3c9e0fa': 4, '0x26a4565e': 1, '0x5c975abb': 0,
  '0x452a9320': '0x427c62edcae20ddc8c5e875de39d4e4845491458',
};

/**
 * @param {object} [m] mutation hooks
 * @param {(jobId: string, hex: string) => string} [m.verdict]  rewrite getVerdict return
 * @param {(jobId: string, hex: string) => string} [m.job]      rewrite getJob return
 * @param {(jobId: string, input: string) => string} [m.txInput] rewrite submit calldata
 * @param {string} [m.fail]            method that always returns a hard RPC error
 * @param {number} [m.rateLimitFirst]  answer the first N calls with a rate-limit error
 * @param {number} [m.http429First]    answer the first N calls with HTTP 429 and a non-JSON body (Cloudflare style)
 * @param {number} [m.http502First]    answer the first N calls with HTTP 502 and the relay's JSON failure body
 * @param {number} [m.internalErrorFirst] answer the first N calls with JSON-RPC -32603 "internal error" (seen live under load)
 * @param {object} [m.extraJobs]       synthetic jobs (see synth.mjs), merged over the recorded ones
 */
export function fakeChain(m = {}) {
  const calls = [];
  let rateLimited = 0, http429 = 0, http502 = 0, internal = 0;
  const JOBS = { ...FIXTURE.jobs, ...(m.extraJobs || {}) };
  const answer = (method, params) => {
    if (m.fail === method) return { error: { code: -32000, message: `${method} unavailable` } };
    switch (method) {
      case 'eth_blockNumber':
        return { result: hex(FIXTURE.latest) };
      case 'eth_getBlockByNumber': {
        const n = Number(BigInt(params[0]));
        if (n < 0 || n > FIXTURE.latest) return { result: null };
        return { result: { number: hex(n), timestamp: hex(timestampAt(n)) } };
      }
      case 'eth_call': {
        const { to, data } = params[0];
        const id = String(jobIdOf(data));
        const j = JOBS[id];
        if (to.toLowerCase() === JUDGE && STATS[data] !== undefined) {
          const v = STATS[data];
          return { result: '0x' + (typeof v === 'string' ? v.slice(2).padStart(64, '0') : BigInt(v).toString(16).padStart(64, '0')) };
        }
        if (to.toLowerCase() === ACP && data === '0x50355d76') {
          return { result: '0x' + BigInt(FIXTURE.latestJobCounter || 186739).toString(16).padStart(64, '0') };
        }
        if (to.toLowerCase() === JUDGE && data.startsWith(SEL_GET_VERDICT)) {
          const v = j ? j.getVerdict : ZERO_VERDICT;
          return { result: m.verdict ? m.verdict(id, v) : v };
        }
        if (to.toLowerCase() === ACP && data.startsWith(SEL_GET_JOB)) {
          if (!j) return { error: { code: 3, message: 'execution reverted' } };
          return { result: m.job ? m.job(id, j.getJob) : j.getJob };
        }
        return { error: { code: -32601, message: 'fake chain: unknown eth_call ' + data.slice(0, 10) } };
      }
      case 'eth_getLogs': {
        const q = params[0];
        const from = Number(BigInt(q.fromBlock)), to = Number(BigInt(q.toBlock));
        if (to - from + 1 > MAX_LOG_SPAN) return { error: { code: -32012, message: 'requested range too large' } };
        const out = [];
        for (const [, j] of Object.entries(JOBS)) {
          const l = j.log;
          if (q.address.toLowerCase() !== l.address.toLowerCase()) continue;
          if (q.topics && q.topics.some((t, i) => t && t.toLowerCase() !== l.topics[i].toLowerCase())) continue;
          const b = Number(BigInt(l.blockNumber));
          if (b >= from && b <= to) out.push(l);
        }
        return { result: out };
      }
      case 'eth_getTransactionByHash':
        return { result: null }; // pruned, exactly like the real endpoint
      case 'eth_getTransactionByBlockNumberAndIndex': {
        for (const [id, j] of Object.entries(JOBS)) {
          if (BigInt(j.log.blockNumber) === BigInt(params[0]) && BigInt(j.log.transactionIndex) === BigInt(params[1])) {
            const input = m.txInput ? m.txInput(id, j.tx.input) : j.tx.input;
            return { result: { ...j.tx, input } };
          }
        }
        return { result: null };
      }
      default:
        return { error: { code: -32601, message: 'fake chain: method not supported ' + method } };
    }
  };

  const fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push({ url, method: req.method, params: req.params });
    if (m.internalErrorFirst && internal < m.internalErrorFirst) {
      internal++;
      const b = { jsonrpc: '2.0', id: JSON.parse(init.body).id, error: { code: -32603, message: 'internal error' } };
      return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) };
    }
    if (m.http502First && http502 < m.http502First) {
      http502++;
      const b = { error: { code: -32000, message: 'rpc proxy failed' } };
      return { ok: false, status: 502, json: async () => b, text: async () => JSON.stringify(b) };
    }
    if (m.http429First && http429 < m.http429First) {
      http429++;
      return {
        ok: false, status: 429,
        json: async () => { throw new SyntaxError('Unexpected token \'e\', "error code: 1015" is not valid JSON'); },
        text: async () => 'error code: 1015',
      };
    }
    let body;
    if (m.rateLimitFirst && rateLimited < m.rateLimitFirst) {
      rateLimited++;
      body = { jsonrpc: '2.0', id: req.id, error: { code: -32005, message: 'rate limit exceeded' } };
    } else {
      body = { jsonrpc: '2.0', id: req.id, ...answer(req.method, req.params) };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

/** Flip one base64 character inside the provider's optParams payload. */
export function tamperDeliverable(input) {
  const d = input.slice(10);
  const off = parseInt(d.slice(128, 192), 16) * 2;
  const len = parseInt(d.slice(off, off + 64), 16);
  const bodyStart = 10 + off + 64;
  const body = Buffer.from(input.slice(bodyStart, bodyStart + len * 2), 'hex').toString('latin1');
  const comma = body.indexOf('base64,');
  const at = comma >= 0 ? comma + 7 + 4 : Math.floor(body.length / 2);
  const ch = body[at];
  const swapped = ch === 'A' ? 'B' : 'A';
  const newBody = body.slice(0, at) + swapped + body.slice(at + 1);
  return input.slice(0, bodyStart) + Buffer.from(newBody, 'latin1').toString('hex') + input.slice(bodyStart + len * 2);
}

/** Rewrite the jobId argument of submit(jobId, deliverable, optParams). */
export function retargetJobId(input, newId) {
  return input.slice(0, 10) + BigInt(newId).toString(16).padStart(64, '0') + input.slice(74);
}

/** Replace word `i` (0-based, 32 bytes) of an ABI return value. */
export function replaceWord(hexStr, i, wordHex) {
  const s = 2 + i * 64;
  return hexStr.slice(0, s) + wordHex.padStart(64, '0') + hexStr.slice(s + 64);
}
