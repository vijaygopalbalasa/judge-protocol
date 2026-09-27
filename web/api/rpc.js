// Same-origin JSON-RPC relay to the Arc testnet RPC.
//
// The in-browser verifier reads the chain directly. Some networks and the Arc
// RPC's own edge rules can block a cross-origin browser fetch, which would make
// the page look broken to a visitor whose only fault is their network. Routing
// the read through this function keeps the request same-origin: the browser
// calls /api/rpc, and the upstream JSON-RPC call happens server-side from
// Vercel. Visitors who prefer not to rely on it can open the page with
// ?rpc=direct, which reads the Arc RPC straight from the browser.
//
// It forwards ONLY the exact request shapes the verifier page sends: single
// read-only calls, against the Judge and ACP contracts, with bounded ranges.
// Everything else is refused before it reaches upstream, so the relay cannot be
// used as a general-purpose (or amplifying) RPC endpoint.
// web/test/proxy.test.mjs checks both directions.
const UPSTREAM = 'https://rpc.testnet.arc.io';
const MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

const ACP = '0x0747eef0706327138c69792bf28cd525089e4583';
const JUDGE = '0x6eff7d4bb514d341abed90bf4c667d0a980173ad';
const JOB_SUBMITTED = '0x80c17db79857f338a6a6df68a6883ecc0ce78e2202fe61ed979733573f40538e';
const MAX_LOG_SPAN = 10_000n; // blocks, inclusive; the page uses 5,000

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const isQty = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(s);
const isH32 = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
const onlyKeys = (o, keys) =>
  !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));

const SHAPES = {
  eth_chainId: (p) => p.length === 0,
  eth_blockNumber: (p) => p.length === 0,
  // Judge/ACP view calls: a 4-byte selector, optionally one 32-byte argument.
  eth_call: (p) => p.length === 2 && p[1] === 'latest' && onlyKeys(p[0], ['to', 'data'])
    && [ACP, JUDGE].includes(lower(p[0].to))
    && typeof p[0].data === 'string' && /^0x[0-9a-fA-F]{8}([0-9a-fA-F]{64})?$/.test(p[0].data),
  // JobSubmitted logs for one job id, on the ACP only, over a bounded range.
  eth_getLogs: (p) => {
    if (p.length !== 1 || !onlyKeys(p[0], ['address', 'topics', 'fromBlock', 'toBlock'])) return false;
    const q = p[0];
    if (lower(q.address) !== ACP || !Array.isArray(q.topics) || q.topics.length !== 2) return false;
    if (lower(q.topics[0]) !== JOB_SUBMITTED || !isH32(q.topics[1])) return false;
    if (!isQty(q.fromBlock) || !isQty(q.toBlock)) return false;
    const span = BigInt(q.toBlock) - BigInt(q.fromBlock);
    return span >= 0n && span < MAX_LOG_SPAN;
  },
  eth_getBlockByNumber: (p) => p.length === 2 && isQty(p[0]) && p[1] === false,
  eth_getTransactionByHash: (p) => p.length === 1 && isH32(p[0]),
  eth_getTransactionByBlockNumberAndIndex: (p) => p.length === 2 && isQty(p[0]) && isQty(p[1]),
};
export const ALLOWED_METHODS = new Set(Object.keys(SHAPES));

const refuse = (res, status, message) =>
  res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message } });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  // Refuse oversized requests before touching the body (Vercel parses lazily).
  const declared = Number((req.headers || {})['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    refuse(res, 413, 'request too large');
    return;
  }

  let raw;
  try {
    // Vercel parses JSON bodies lazily and throws on malformed input.
    const b = req.body;
    raw = typeof b === 'string' ? b : JSON.stringify(b ?? null);
  } catch {
    refuse(res, 400, 'malformed JSON');
    return;
  }
  if (Buffer.byteLength(raw ?? '', 'utf8') > MAX_BODY_BYTES) {
    refuse(res, 413, 'request too large');
    return;
  }

  let msg;
  try { msg = JSON.parse(raw); } catch { refuse(res, 400, 'malformed JSON'); return; }
  if (Array.isArray(msg)) { refuse(res, 400, 'batch requests are not supported'); return; }
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    refuse(res, 400, 'expected a single JSON-RPC request');
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(SHAPES, msg.method)) {
    refuse(res, 400, `method not allowed by this read-only relay: ${msg.method.slice(0, 64)}`);
    return;
  }
  const params = msg.params === undefined ? [] : msg.params;
  if (!Array.isArray(params) || !SHAPES[msg.method](params)) {
    refuse(res, 400, `request shape not allowed by this read-only relay: ${msg.method}`);
    return;
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Number.isSafeInteger(msg.id) ? msg.id : 1, method: msg.method, params }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(502).json({ error: { code: -32000, message: 'rpc proxy failed' } });
  }
}
