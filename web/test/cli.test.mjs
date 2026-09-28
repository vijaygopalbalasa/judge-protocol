// The CLI verifier must reach the same answer as the page (it now shares the
// page's verification code) and must work for anyone, with no env or secrets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeChain } from './helpers/fake-chain.mjs';
import { synthJob, dataUri, keccak256 } from './helpers/synth.mjs';

const CLI = fileURLToPath(new URL('../../judge-service/src/verify.js', import.meta.url));
const TEXT = 'This report covers ERC-8183 escrow on Arc testnet with USDC settlement in detail.';
let server, url, jobs = {};

before(async () => {
  const LEN = { version: 1, checks: [{ kind: 'length', params: { min: 3 } }] };
  Object.assign(jobs,
    await synthJob({ id: 930001, criteria: LEN, content: TEXT, providerURI: 'https://provider.example/r.txt',
      descriptionURI: dataUri(Buffer.from('client substitute')), verdict: { deliverable: keccak256(Buffer.from('client substitute')) } }),
    await synthJob({ id: 930002, criteria: { version: 1, checks: [{ kind: 'length', params: { min: 3 } }, { kind: 'http-endpoint', params: { url: 'https://e.example' } }] }, content: TEXT, assumePass: [true, true] }),
    await synthJob({ id: 930003, criteria: LEN, content: TEXT, providerURI: 'https://provider.example/r.txt' }),
  );
  const chain = fakeChain({ extraJobs: jobs });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const r = await chain.fetch('fake', { body });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(await r.text());
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const cli = (...args) => new Promise((resolve) => {
  // spawnSync would block the in-process fake RPC server, so run async.
  import('node:child_process').then(({ spawn }) => {
    const p = spawn(process.execPath, [CLI, ...args, '--rpc', url], { env: { PATH: process.env.PATH } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
});
void spawnSync;

test('CLI: a genuine recorded verdict verifies with no env and no evidence file (exit 0)', async () => {
  const r = await cli('171925');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /VERIFIED/);
});

test('CLI: a verdict that graded client content is a mismatch, same as the page (exit 1)', async () => {
  const r = await cli('930001', '--deliverable', writeTmp('client substitute'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /MISMATCH/);
});

test('CLI: a live-probe job is reported as not replayable, with the recorded probe result (exit 3)', async () => {
  const r = await cli('930002');
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /NOT REPLAYABLE/);
  assert.match(r.out, /recorded the live probe as pass/);
});

test('CLI: a remote deliverable verifies from a local file of its bytes (exit 0); without it, incomplete (exit 3)', async () => {
  assert.equal((await cli('930003')).code, 3);
  const r = await cli('930003', '--deliverable', writeTmp(TEXT));
  assert.equal(r.code, 0, r.out);
});

test('CLI: bad usage exits 2', async () => {
  assert.equal((await cli('12abc')).code, 2);
});

function writeTmp(text) {
  const f = join(mkdtempSync(join(tmpdir(), 'judge-cli-')), 'deliverable.bin');
  writeFileSync(f, text);
  return f;
}

test('CLI: --judge and --acp point it at another deployment, and the job must name that judge', async () => {
  const other = '0x000000000000000000000000000000000000dEaD';
  const r = await cli('171925', '--judge', other);
  assert.match(r.out, new RegExp(`judge ${other}`), 'the header shows the judge it checks against');
  assert.notEqual(r.code, 0, 'a job naming a different evaluator never verifies against this one');
  const bad = await cli('171925', '--acp', '0x1234');
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /--acp must be an address/);
});

test('CLI: --network arc-mainnet checks against the Arc mainnet deployment; an unknown network is a usage error', async () => {
  const r = await cli('171925', '--network', 'arc-mainnet');
  assert.match(r.out, /judge 0xC9de51A6b440D834D05e22d0D500F41Df1B56321/);
  assert.match(r.out, /acp {3}0x64cA39Fc57315D0D488acCaC07c37C6E841CD058/);
  assert.notEqual(r.code, 0, 'a testnet job never verifies against the mainnet judge');
  const bad = await cli('171925', '--network', 'mainnet-typo');
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /unknown --network/);
});
