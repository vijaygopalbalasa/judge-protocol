// The page's Content-Security-Policy must allow every endpoint the verifier
// actually calls (in both deployed and local mode), and must stay strict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);

function directives() {
  assert.ok(meta, 'index.html must carry a CSP meta tag');
  const out = {};
  for (const part of meta[1].split(';').map((s) => s.trim()).filter(Boolean)) {
    const [name, ...vals] = part.split(/\s+/);
    out[name] = vals;
  }
  return out;
}

/** Minimal connect-src matcher: 'self' covers same-origin (relative) URLs; otherwise exact origin. */
function allowedByConnectSrc(url, pageOrigin) {
  const src = directives()['connect-src'] || directives()['default-src'] || [];
  const u = new URL(url, pageOrigin);
  if (u.origin === pageOrigin) return src.includes("'self'");
  return src.includes(u.origin) || src.includes(u.origin + '/');
}

async function endpointFor(hostname, protocol = 'https:') {
  globalThis.location = { hostname, protocol };
  try {
    const mod = await import(`../app.js?host=${hostname || 'file'}`);
    return mod.CFG.rpc;
  } finally {
    delete globalThis.location;
  }
}

test('deployed page: the RPC endpoint the app calls is allowed by connect-src', async () => {
  const origin = 'https://judge-protocol-verifier.vercel.app';
  const ep = await endpointFor('judge-protocol-verifier.vercel.app');
  assert.ok(allowedByConnectSrc(ep, origin), `connect-src blocks ${ep}: ${meta[1]}`);
});

test('local static hosting: the RPC endpoint the app calls is allowed by connect-src', async () => {
  const origin = 'http://localhost:8787';
  const ep = await endpointFor('localhost', 'http:');
  assert.ok(allowedByConnectSrc(ep, origin), `connect-src blocks ${ep}`);
});

test('CSP stays strict: nothing is loosened to make the fix pass', () => {
  const d = directives();
  assert.deepEqual(d['default-src'], ["'none'"]);
  assert.deepEqual(d['script-src'], ["'self'"]);
  assert.deepEqual(d['base-uri'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'none'"]);
  const all = meta[1];
  for (const loose of ['*', "'unsafe-eval'", 'http:', 'https:', 'data:', 'blob:']) {
    assert.ok(!all.split(/[\s;]+/).includes(loose), `CSP must not contain ${loose}`);
  }
  assert.deepEqual([...d['connect-src']].sort(), ["'self'", 'https://rpc.testnet.arc.io'].sort());
});
