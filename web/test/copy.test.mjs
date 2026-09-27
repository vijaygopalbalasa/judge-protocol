// Public copy: the numbers shown must match the measurement they came from and
// be labeled as sample counts, the agent profile must not overclaim, and
// outward-facing text must not use em dashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const EM_DASH = String.fromCharCode(0x2014);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const M = JSON.parse(read('judge-service/acp-measurement.json'));

test('measurement table values match judge-service/acp-measurement.json exactly', async () => {
  const { MEASURED } = await import('../measurement.js');
  const byLabel = Object.fromEntries(MEASURED.map(([label, value, note]) => [label.replace(/ \(.*\)$/, ''), { value, note }]));
  const fmt = (n) => n.toLocaleString('en-US');
  const pp = (x) => `${x.toFixed(1)}pp`;
  assert.equal(byLabel['Sample'].value, `${fmt(M.sampled)} of ${fmt(M.jobCounter)} jobs`);
  assert.equal(byLabel['Self-evaluated jobs'].value, `${M.selfEvaluationRate}% ± ${pp(M.selfEvaluationRate_ci95pp)}`);
  assert.equal(byLabel['Delegate to a third party'].value, `${M.thirdPartyDelegationRate}% ± ${pp(M.thirdPartyDelegationRate_ci95pp)}`);
  assert.match(byLabel['Delegate to a third party'].note, new RegExp(`\\b${M.distinctThirdPartyEvaluators}\\b`));
  assert.match(byLabel['Third-party evaluators paid through'].value,
    new RegExp(`^${M.THIRD_PARTY_EVALUATORS_PAID_THROUGH} addresses, ${M.thirdPartyPaidThroughJobs} jobs`));
  assert.equal(byLabel['Rejection rate'].value, `${M.rejectionRate}% of decided jobs`);
  assert.equal(byLabel['Jobs using any hook'].value, `${M.jobsWithNonZeroHook} of ${fmt(M.sampled)}`);
  assert.equal(byLabel['Median funded budget'].value, `${M.medianFundedBudgetUSDC.toFixed(2)} USDC`);
});

test('every row that shows a sample count says it is a sample count', async () => {
  const { MEASURED } = await import('../measurement.js');
  const counts = [M.distinctThirdPartyEvaluators, M.THIRD_PARTY_EVALUATORS_PAID_THROUGH, M.thirdPartyPaidThroughJobs];
  for (const [label, value, note] of MEASURED) {
    const text = `${value} ${note}`;
    if (counts.some((n) => new RegExp(`\\b${n}\\b`).test(text))) {
      assert.match(text, /\bsample\b/i, `row "${label}" shows a sample count without saying so`);
    }
  }
  const sampleRow = MEASURED.find(([l]) => l.startsWith('Sample'));
  assert.match(sampleRow[0] + sampleRow[2], /2026/, 'the sample row must carry its date');
});

test('ERC-8004 agent profile is well-formed and does not claim mainnet readiness', () => {
  const reg = JSON.parse(read('docs/agent-registration.json'));
  assert.equal(reg.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  for (const k of ['name', 'description', 'image']) assert.ok(reg[k], `missing ${k}`);
  for (const s of reg.services) assert.match(s.endpoint, /^https:\/\//);
  assert.doesNotMatch(reg.description, /day-one|mainnet[- ]ready|ready for (arc )?mainnet|live on (arc )?mainnet/i);
  assert.match(reg.description, /testnet/i);
});

test('no em dashes in outward-facing web text, the agent profile, or top-level docs', () => {
  const web = readdirSync(new URL('web/', root)).filter((f) => /\.(html|js|md|json)$/.test(f)).map((f) => 'web/' + f);
  const files = [...web, 'web/api/rpc.js', 'docs/agent-registration.json', 'README.md', 'ARCHITECTURE.md'];
  const hits = files.flatMap((f) => read(f).split('\n').map((line, i) => [f, i + 1, line]))
    .filter(([, , line]) => line.includes(EM_DASH))
    .map(([f, n, line]) => `${f}:${n}: ${line.trim().slice(0, 80)}`);
  assert.deepEqual(hits, []);
});

/* ------------------------- critique round additions ------------------------ */
import { execSync } from 'node:child_process';

test('no em dashes in ANY tracked text file (except verified contract sources and vendored code)', () => {
  // contracts/src is excluded on purpose: those files are source-verified on-chain, and editing
  // even a comment would make the repo stop matching the verified source.
  const files = execSync('git ls-files', { cwd: new URL('.', root) }).toString().split('\n')
    .filter((f) => f && !/^contracts\/(src|lib)\/|\/vendor\/|\.(png|jpg|mp4|ico|gz)$/.test(f));
  const hits = [];
  for (const f of files) {
    let text; try { text = read(f); } catch { continue; }
    text.split('\n').forEach((line, i) => { if (line.includes(EM_DASH)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});

test('no stale "nobody else ships this" claim anywhere in the repo', () => {
  const out = execSync('git grep -n -i "nobody else" -- . ":!web/test/copy.test.mjs" || true', { cwd: new URL('.', root) }).toString();
  assert.equal(out.trim(), '');
});

test('the page states how its reads work instead of claiming "no backend" or "trust nothing"', () => {
  const html = read('web/index.html');
  assert.doesNotMatch(html, /no backend|trust nothing/i);
  assert.match(html, /api\/rpc/);
  assert.match(html, /rpc=direct/);
  assert.doesNotMatch(read('web/README.md'), /no backend/i);
  assert.doesNotMatch(read('web/app.js').split('\n').slice(0, 8).join('\n'), /no backend/i);
});

test('measurement copy says testnet, and does not call faucet USDC "real money"', async () => {
  const html = read('web/index.html');
  assert.match(html, /What we measured on Arc testnet/);
  assert.doesNotMatch(read('web/measurement.js'), /real money/i);
});

test('honest limits describe the hosted judge truthfully: on demand, daily sweep, best effort', () => {
  const main = read('web/main.js');
  assert.match(main, /on demand/i);
  assert.match(main, /daily/i);
  assert.match(main, /best effort/i);
  assert.match(main, /no uptime guarantee/i);
  assert.doesNotMatch(main, /not running|offline/i);
});

test('agent profile states the real liveness, lists the hosted API and its own registration', () => {
  const reg = JSON.parse(read('docs/agent-registration.json'));
  assert.equal(reg.active, true);
  assert.match(reg.description, /on demand/i);
  assert.match(reg.description, /best effort/i);
  assert.doesNotMatch(reg.description, /offline|not running/i);
  assert.ok(reg.services.some((x) => x.endpoint === 'https://judge-protocol-api.vercel.app'), 'hosted API listed');
  assert.ok(reg.registrations.some((x) => x.agentId === 870004 && /eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e/i.test(x.agentRegistry)));
  assert.doesNotMatch(reg.description, /json-schema/);
});

/* ---------------------------- round two copy fixes -------------------------- */
test('the page names both things a visitor relies on, and scopes "every verdict" honestly', () => {
  const html = read('web/index.html');
  assert.doesNotMatch(html, /The one thing you rely on/);
  assert.match(html, /page's code/i);
  assert.match(html, /http\.server/);
  assert.doesNotMatch(html, /every verdict can be recomputed/i);
  assert.match(html, /<title>[^<]*Arc testnet[^<]*<\/title>/);
  assert.match(html, /name="description" content="[^"]*Arc testnet/);
  assert.match(html, /id="rpcmode"/);
  assert.doesNotMatch(read('web/app.js').split('\n').slice(0, 8).join('\n'), /nothing but the Arc RPC/);
});

test('the demo recording is not called unedited, and says what was edited', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /Unedited capture|Raw terminal recording/);
  assert.match(readme, /edited on Sep 27, 2026/);
});

test('determinism claims are scoped: http-endpoint is a live probe that cannot be re-verified', () => {
  const readme = read('README.md');
  assert.match(readme, /http-endpoint[^.]*live (network )?probe/i);
  assert.match(read('ARCHITECTURE.md'), /http-endpoint[^.]*live (network )?probe/i);
  const reg = JSON.parse(read('docs/agent-registration.json'));
  assert.match(reg.description, /http-endpoint[^.]*live (network )?probe/i);
});

test('the independent-verification command works for anyone: no .env, no evidence file, judge address defaulted', async () => {
  const readme = read('README.md');
  const line = readme.split('\n').find((l) => l.includes('Every verdict') || l.includes('independently checkable')) || '';
  assert.doesNotMatch(line, /--env-file/);
  assert.doesNotMatch(readme, /--env-file=\.env src\/verify\.js/);
  assert.match(read('judge-service/src/config.js'), /judgeAddress: process\.env\.JUDGE_ADDRESS \|\| "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD"/);
  assert.match(read('.env.example'), /^JUDGE_ADDRESS=0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD$/m);
});

test('docs match the code: nine checks, present.js listed, full evidence core, real CLI command', () => {
  const web = read('web/README.md');
  assert.doesNotMatch(web, /Seven checks/i);
  assert.match(web, /Nine checks/);
  assert.match(web, /`present\.js`/);
  const arch = read('ARCHITECTURE.md');
  assert.doesNotMatch(arch, /`judge verify/);
  assert.match(arch, /jobId[^.]*criteriaHash[^.]*deliverable[^.]*criteria[^.]*checks[^.]*score[^.]*threshold[^.]*pass/);
});

test('hook-whitelist wording is hedged the same way everywhere', () => {
  for (const f of ['web/measurement.js', 'README.md']) {
    assert.doesNotMatch(read(f), /only address\(0\) is whitelisted'|are not whitelisted there yet/, f);
  }
  assert.match(read('web/measurement.js'), /no sampled job used a hook/);
});

test('the README tagline states the real liveness: on demand, best effort', () => {
  const head = read('README.md').split('\n').slice(0, 12).join('\n');
  assert.match(head, /on demand/i);
  assert.match(head, /best effort/i);
  assert.doesNotMatch(head, /offline|not running/i);
});

test('the hosted API is documented where integrators look', () => {
  for (const f of ['README.md', 'ARCHITECTURE.md']) {
    const t = read(f);
    assert.match(t, /https:\/\/judge-protocol-api\.vercel\.app/, f);
    assert.match(t, /\/api\/judge/, f);
  }
});

test('test counts quoted in the README match the suites that actually exist', () => {
  const count = (dir, ext) => readdirSync(new URL(dir, root)).filter((f) => f.endsWith(ext))
    .reduce((n, f) => n + (read(dir + f).match(/^\s*test\(/gm) || []).length, 0);
  const svc = count('judge-service/test/', '.test.js');
  const web = count('web/test/', '.test.mjs');
  const readme = read('README.md');
  assert.match(readme, new RegExp(`\\*\\*${svc}/${svc} service unit tests\\*\\*`));
  assert.match(readme, new RegExp(`\\*\\*${web}/${web} web verifier tests\\*\\*`));
  assert.match(readme, new RegExp(`${svc} unit tests \\(`));
  assert.match(readme, new RegExp(`# ${svc}/${svc}`));
  for (const m of readme.matchAll(/(\d+)\/\1 (service unit|web verifier) tests/g)) {
    assert.equal(Number(m[1]), m[2] === 'service unit' ? svc : web, m[0]);
  }
});
