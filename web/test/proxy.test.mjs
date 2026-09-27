// The same-origin /api/rpc proxy: it must forward exactly the read-only calls
// the verifier makes, and refuse everything else before it reaches upstream.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { default: handler, ALLOWED_METHODS } = await import('../api/rpc.js');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockUpstream(reply = { jsonrpc: '2.0', id: 1, result: '0x4cef52' }, status = 200) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: init.body });
    return { status, text: async () => JSON.stringify(reply) };
  };
  return sent;
}

function call(method, body, headers = {}) {
  const res = { code: 0, headers: {}, payload: undefined };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.payload = o; return res; };
  res.send = (s) => { res.payload = s; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  return Promise.resolve(handler({ method, body, headers }, res)).then(() => res);
}
const rpcBody = (method, params = []) => ({ jsonrpc: '2.0', id: 1, method, params });

test('GET is refused with 405', async () => {
  const sent = mockUpstream();
  const r = await call('GET');
  assert.equal(r.code, 405);
  assert.equal(sent.length, 0);
});

test('a read-only call is forwarded and the upstream answer returned verbatim', async () => {
  const sent = mockUpstream();
  const r = await call('POST', rpcBody('eth_chainId'));
  assert.equal(r.code, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://rpc.testnet.arc.io');
  assert.deepEqual(JSON.parse(r.payload), { jsonrpc: '2.0', id: 1, result: '0x4cef52' });
  assert.equal(r.headers['content-type'], 'application/json');
});

test('a string body (raw JSON) is accepted the same way', async () => {
  const sent = mockUpstream();
  const r = await call('POST', JSON.stringify(rpcBody('eth_blockNumber')));
  assert.equal(r.code, 200);
  assert.equal(sent.length, 1);
});

test('write and account methods are refused and never reach upstream', async () => {
  for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign',
    'debug_traceTransaction', 'admin_peers', 'eth_accounts']) {
    const sent = mockUpstream();
    const r = await call('POST', rpcBody(m));
    assert.equal(r.code, 400, m);
    assert.equal(sent.length, 0, `${m} was forwarded`);
  }
});

test('batch requests, malformed JSON and oversized bodies are refused', async () => {
  let sent = mockUpstream();
  let r = await call('POST', [rpcBody('eth_chainId')]);
  assert.equal(r.code, 400); assert.equal(sent.length, 0);

  sent = mockUpstream();
  r = await call('POST', '{"jsonrpc": "2.0", "method": ');
  assert.equal(r.code, 400); assert.equal(sent.length, 0);

  sent = mockUpstream();
  r = await call('POST', rpcBody('eth_call', [{ to: '0x' + '1'.repeat(40), data: '0x' + 'ab'.repeat(20000) }, 'latest']));
  assert.equal(r.code, 413); assert.equal(sent.length, 0);

  sent = mockUpstream();
  r = await call('POST', { jsonrpc: '2.0', id: 1 });
  assert.equal(r.code, 400); assert.equal(sent.length, 0);
});

test('an upstream network failure becomes a JSON-RPC shaped 502', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const r = await call('POST', rpcBody('eth_chainId'));
  assert.equal(r.code, 502);
  assert.equal(r.payload.error.code, -32000);
});

test('the allowlist covers every RPC method the verifier page uses (no self-inflicted breakage)', () => {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/rpc\('([a-zA-Z_]+)'/g)].map((m) => m[1]));
  used.add('eth_call'); // via call()
  assert.ok(used.size >= 3, 'expected to find the page RPC methods');
  for (const m of used) assert.ok(ALLOWED_METHODS.has(m), `proxy would block ${m}`);
});

/* ------------------- parameter shapes (critique round) -------------------- */
const ACP = '0x0747EEf0706327138c69792bF28Cd525089e4583';
const JUDGE = '0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD';
const TOPIC = '0x80c17db79857f338a6a6df68a6883ecc0ce78e2202fe61ed979733573f40538e';
const W = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

test('only the exact request shapes the page sends are forwarded', async () => {
  const refused = [
    ['eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x100' }]], // no address: the 12 MB amplification
    ['eth_getLogs', [{ address: JUDGE, topics: [TOPIC, W(1)], fromBlock: '0x1', toBlock: '0x2' }]],
    ['eth_getLogs', [{ address: ACP, topics: [TOPIC], fromBlock: '0x1', toBlock: '0x2' }]],
    ['eth_getLogs', [{ address: ACP, topics: [TOPIC, W(1)], fromBlock: '0x1', toBlock: '0x2712' }]], // 10,002 blocks
    ['eth_getLogs', [{ address: ACP, topics: [TOPIC, W(1)], fromBlock: '0x10', toBlock: '0x1' }]],
    ['eth_call', [{ to: '0x0000000000000000000000000000000000000004', data: '0x68656c6c6f' }, 'latest']],
    ['eth_call', [{ to: JUDGE, data: '0x33f3e74b' + W(1).slice(2) }, 'latest', { [JUDGE]: { code: '0x00' } }]],
    ['eth_call', [{ to: JUDGE, data: '0x33f3e74b' + W(1).slice(2), from: JUDGE }, 'latest']],
    ['eth_call', [{ to: ACP, data: '0x' + 'ab'.repeat(200) }, 'latest']],
    ['eth_getBlockByNumber', ['0x10', true]],
    ['eth_getBlockByNumber', ['latest', false]],
    ['eth_getTransactionByHash', ['0x1234']],
    ['eth_getTransactionByBlockNumberAndIndex', ['0x10']],
    ['eth_chainId', ['extra']],
  ];
  for (const [m, p] of refused) {
    const sent = mockUpstream();
    const r = await call('POST', rpcBody(m, p));
    assert.equal(r.code, 400, `${m} ${JSON.stringify(p)} should be refused`);
    assert.equal(sent.length, 0);
  }
});

test('the upstream call carries a timeout signal', async () => {
  let signal;
  globalThis.fetch = async (url, init) => { signal = init.signal; return { status: 200, text: async () => '{}' }; };
  await call('POST', rpcBody('eth_blockNumber'));
  assert.ok(signal && typeof signal.aborted === 'boolean', 'fetch must receive an AbortSignal');
});

test('end to end: the real verifier and stats, routed through the real proxy, still work (no self-inflicted breakage)', async () => {
  const { fakeChain } = await import('./helpers/fake-chain.mjs');
  const chain = fakeChain();
  globalThis.location = { hostname: 'judge-protocol-verifier.vercel.app', protocol: 'https:' };
  const app = await import('../app.js?via-proxy');
  delete globalThis.location;
  assert.equal(app.CFG.rpc, '/api/rpc');
  const refusals = [];
  globalThis.fetch = async (url, init) => {
    if (url !== '/api/rpc') return chain.fetch(url, init); // the proxy's own upstream call
    const res = await call('POST', init.body);
    if (res.code !== 200) refusals.push(init.body);
    const text = typeof res.payload === 'string' ? res.payload : JSON.stringify(res.payload);
    return { ok: res.code === 200, status: res.code, json: async () => JSON.parse(text), text: async () => text };
  };
  const r = await app.verifyJob(171925);
  assert.deepEqual(refusals, []);
  assert.equal(app.outcome(r), 'verified');
  const s = await app.judgeStats();
  assert.equal(s.verdicts, 5);
  assert.ok((await app.acpJobCounter()) > 0);
  assert.deepEqual(refusals, []);
});

/* ------------------------------ round two nits ----------------------------- */
test('an oversized request is refused from content-length, before the body is parsed', async () => {
  const sent = mockUpstream();
  const res = { code: 0, payload: undefined, headers: {} };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.payload = o; return res; };
  res.send = (s) => { res.payload = s; return res; };
  res.setHeader = () => {};
  const req = { method: 'POST', headers: { 'content-length': '200000' } };
  Object.defineProperty(req, 'body', { get() { throw new Error('body must not be touched'); } });
  await handler(req, res);
  assert.equal(res.code, 413);
  assert.equal(sent.length, 0);
});

test('only an integer id is forwarded; anything else is replaced', async () => {
  for (const [id, want] of [[7, 7], ['x'.repeat(15000), 1], [{ a: 1 }, 1], [1.5, 1]]) {
    const sent = mockUpstream();
    await call('POST', { jsonrpc: '2.0', id, method: 'eth_chainId', params: [] });
    assert.equal(JSON.parse(sent[0].body).id, want);
  }
});
