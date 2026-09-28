// ?network=arc-mainnet points the page at the Arc mainnet deployment; the default stays Arc testnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function cfgFor(search, hostname = 'judge-protocol-verifier.vercel.app') {
  globalThis.location = { hostname, protocol: 'https:', search };
  try {
    return (await import(`../app.js?net=${encodeURIComponent(search)}&host=${hostname}`)).CFG;
  } finally {
    delete globalThis.location;
  }
}

test('the default is Arc testnet, read through the site relay', async () => {
  const c = await cfgFor('');
  assert.equal(c.network, 'arc-testnet');
  assert.equal(c.unknownNetwork, null);
  assert.equal(c.chainId, 5042002);
  assert.equal(c.rpc, '/api/rpc');
  assert.equal(c.judge, '0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD');
  assert.equal(c.judgeApi, 'https://judge-protocol-api.vercel.app');
});

test('?network=arc-mainnet reads the Arc mainnet judge straight from Arc\'s public RPC, with no hosted judge', async () => {
  const c = await cfgFor('?network=arc-mainnet');
  assert.equal(c.network, 'arc-mainnet');
  assert.equal(c.chainId, 5042);
  assert.equal(c.rpc, 'https://rpc.mainnet.arc.io', 'the site relay only forwards testnet calls');
  assert.equal(c.judge, '0xC9de51A6b440D834D05e22d0D500F41Df1B56321');
  assert.equal(c.acp, '0x64cA39Fc57315D0D488acCaC07c37C6E841CD058');
  assert.equal(c.judgeApi, null, 'the hosted judge rules on testnet only');
  assert.equal(c.hook, null);
  assert.deepEqual(c.knownJobs, [17, 16]);
  assert.equal((await cfgFor('?rpc=direct&network=arc-mainnet')).network, 'arc-mainnet', 'any position in the query');
});

test('an unknown network is reported, never guessed into another one', async () => {
  const c = await cfgFor('?network=arc-mainet');
  assert.equal(c.network, 'arc-testnet');
  assert.equal(c.unknownNetwork, 'arc-mainet');
});

test('the CSP lets the page read Arc mainnet', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /connect-src[^;"]*https:\/\/rpc\.mainnet\.arc\.io/);
});

test('the page offers the hosted judge only where there is one, and names each network\'s escrow', () => {
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /if \(CFG\.judgeApi\)/, 'the ask-the-judge button needs a hosted judge');
  assert.match(main, /CFG\.acpLabel/);
  assert.match(main, /CFG\.unknownNetwork/, 'an unknown ?network= is shown to the visitor');
});
