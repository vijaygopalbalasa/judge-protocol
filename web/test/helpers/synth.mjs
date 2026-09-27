// Synthetic Arc jobs for the verifier tests. "Genuine" verdicts are produced by
// the judge-service's OWN code (criteria hash, checkers, evidence hash), so a
// test that expects `verified` is asserting that the browser agrees with the
// real service, and a test that expects `mismatch` uses a verdict the service
// would never sign.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { FIXTURE, ACP, timestampAt } from './fake-chain.mjs';

const svc = new URL('../../../judge-service/', import.meta.url);
const req = createRequire(new URL('package.json', svc));
const viem = await import(pathToFileURL(req.resolve('viem')).href);
const { encodeAbiParameters, keccak256, toHex } = viem;
export { keccak256 };
export const service = {
  criteria: await import(new URL('src/criteria.js', svc).href),
  checkers: await import(new URL('src/checkers/index.js', svc).href),
  evidence: await import(new URL('src/evidence.js', svc).href),
};

const TOPIC0 = '0x80c17db79857f338a6a6df68a6883ecc0ce78e2202fe61ed979733573f40538e';
export const JUDGE = '0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD';
const CLIENT = '0xa3f1b25000000000000000000000000000000001';
const PROVIDER = '0x5e14c9e5278ee370d764d03d314e92b3d9ffc04f';
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

export const dataUri = (bytes, { url = false } = {}) => {
  let s = b64(bytes);
  if (url) s = s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `data:application/octet-stream;base64,${s}`;
};

let slot = 0;

/**
 * @param {object} o
 * @param {number} o.id
 * @param {object} o.criteria
 * @param {Uint8Array|string} o.content         what the provider delivered
 * @param {string|null} [o.providerURI]         URI in the provider's optParams (default: data: URI of content; null = none)
 * @param {string} [o.descriptionURI]           client-authored deliverableURI line in the description
 * @param {object} [o.verdict]                  override fields of the signed verdict ({results, score, pass, threshold, deliverable})
 * @param {boolean[]} [o.assumePass]            per-check pass flags to use instead of running the service checkers (for http-endpoint)
 * @param {number} [o.clockSkewSec]             service clock lag: verdict timestamp minus this many seconds
 * @param {boolean} [o.viaWallet]               provider submits through a contract wallet (execute(ACP, 0, submit(...)))
 * @param {boolean} [o.noVerdict]               no verdict on chain yet (getVerdict returns the empty struct)
 * @param {string} [o.status]                   job status name override (Open, Funded, Submitted, Completed, Rejected, Expired)
 */
export async function synthJob(o) {
  const content = typeof o.content === 'string' ? Buffer.from(o.content, 'utf8') : Buffer.from(o.content);
  const committed = keccak256(content);
  const providerURI = o.providerURI === undefined ? dataUri(content) : o.providerURI;
  const optParams = providerURI ? `deliverableURI: ${providerURI}` : '';
  const description = ['Synthetic job for verifier tests.', '```judge-criteria', JSON.stringify(o.criteria), '```']
    .concat(o.descriptionURI ? [`deliverableURI: ${o.descriptionURI}`] : []).join('\n');

  let results, score, threshold, pass;
  if (o.assumePass) {
    results = o.criteria.checks.map((c, i) => ({ kind: c.kind, weight: c.weight ?? 1, pass: o.assumePass[i] }));
    const wSum = results.reduce((a, r) => a + r.weight, 0);
    score = Math.round((results.filter((r) => r.pass).reduce((a, r) => a + r.weight, 0) / wSum) * 100);
    threshold = o.criteria.passThreshold ?? 100; pass = score >= threshold;
  } else if (service.checkers.validateCriteria(o.criteria).valid) {
    ({ results, score, threshold, pass } = await service.checkers.runAllChecks(o.criteria, { content }));
  } else {
    results = []; score = 0; threshold = o.criteria.passThreshold ?? 100; pass = false;
  }
  const v = { results, score, threshold, pass, deliverable: committed, ...(o.verdict || {}) };
  const ch = service.criteria.criteriaHash(o.criteria);
  const evidenceHash = service.evidence.evidenceHashOf({
    jobId: o.id, criteriaHash: ch, deliverable: v.deliverable, criteria: o.criteria,
    results: v.results, score: v.score, threshold: v.threshold, pass: v.pass,
  });

  slot++;
  const submitBlock = FIXTURE.latest - 400000 - slot * 1000;
  const verdictTs = timestampAt(submitBlock + 5) - (o.clockSkewSec || 0);
  const getVerdict = o.noVerdict ? '0x' + '0'.repeat(64 * 8)
    : '0x' + [o.id, ch, v.deliverable, v.score, v.threshold, v.pass ? 1 : 0, evidenceHash, verdictTs].map(word).join('');
  const STATUS_INDEX = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 };
  const statusIndex = o.status ? STATUS_INDEX[o.status] : o.noVerdict ? 2 : v.pass ? 3 : 4;
  const getJob = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'string' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'address' }] }],
    [[BigInt(o.id), CLIENT, PROVIDER, o.evaluator || JUDGE, description, 1000000n, 0n, statusIndex, '0x' + '0'.repeat(40)]],
  );
  const input = '0x9e63798d' + encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes' }],
    [BigInt(o.id), committed, optParams ? toHex(optParams) : '0x'],
  ).slice(2);
  const WALLET = '0x7a11e7000000000000000000000000000000beef';
  const txInput = o.viaWallet
    ? '0xb61d27f6' + encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], [ACP, 0n, input]).slice(2)
    : input;
  const txHash = keccak256(toHex(`synthetic-${o.id}-${slot}`));
  const log = {
    address: ACP, topics: [TOPIC0, '0x' + word(o.id), '0x' + word(PROVIDER)], data: committed,
    blockNumber: '0x' + submitBlock.toString(16), transactionIndex: '0x1', transactionHash: txHash,
  };
  return {
    [String(o.id)]: {
      getJob, getVerdict, verdictTs, submitBlock, log,
      tx: { hash: txHash, from: PROVIDER, to: o.viaWallet ? WALLET : ACP, input: txInput, blockNumber: log.blockNumber },
      content, committed,
    },
  };
}
