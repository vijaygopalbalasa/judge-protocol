// After a ruling settles, the judge attests it on ERC-8412 if, and only if, the
// job's client preregistered the criteria document the profile defines for it,
// naming JudgeAttestor as the verifier. The attestation is signed by the judge's
// key and relayed; if the relay fails, the signed attestation is returned so
// anyone can submit it. Nothing is ever signed that the record could refute.
import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";

const E = await import("../src/erc8412.js");
const { attestRuling, ATTESTATION_TYPES } = await import("../src/erc8412-attest.js");

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const CHAIN = { chainId: 5042002, acp: "0x0747EEf0706327138c69792bF28Cd525089e4583",
  registry: "0x48c3a1812F2dFc762a80dbD5c65e9C7B0BB25ae4", attestor: "0x1111111111111111111111111111111111111111" };
const CLIENT = "0xA3f1b2503838fc061af842eD2C719559E12ad973";
const CRITERIA = { version: 1, passThreshold: 100, checks: [
  { kind: "length", params: { min: 3 } },
  { kind: "contains", params: { all: ["USDC"] } },
] };
const REGISTERED_AT = 1790000000, SUBMITTED_AT = 1790000100, JUDGED_AT = 1790000200, EXPIRY = 1790003600;
const result = (pass, kind) => ({ kind, weight: 1, pass, detail: pass ? "ok" : "missing" });

function ruling(passes = [true, true], over = {}) {
  return { jobId: 186800n, client: CLIENT, expiredAt: BigInt(EXPIRY), criteria: CRITERIA,
    results: passes.map((p, i) => result(p, CRITERIA.checks[i].kind)), pass: passes.every(Boolean),
    deliverable: { digest: "0x" + "ab".repeat(32), uri: "data:text/plain;base64,VVNEQw==", submitTx: "0x" + "cd".repeat(32) },
    judgedAt: JUDGED_AT, ...over };
}

/** The preregistration the client would make for `r`, as the registry stores it. */
function preregFor(r, over = {}) {
  const c = E.criteriaDocument(r.criteria, { chainId: CHAIN.chainId, acp: CHAIN.acp, jobId: r.jobId, verifier: CHAIN.attestor, expiry: r.expiredAt });
  const id = E.preregistrationIdOf({ chainId: CHAIN.chainId, registry: CHAIN.registry, author: r.client, criteriaDigest: c.criteriaDigest, taskRef: c.taskRef });
  return { id, doc: c, row: [r.client, c.criteriaDigest, c.taskRef, c.obligationCount, c.obligationFlags, BigInt(EXPIRY),
    BigInt(over.registeredAt ?? REGISTERED_AT), CHAIN.attestor, E.ZERO32, over.supersededBy ?? E.ZERO32] };
}

function fakes({ prereg = null, attestation = null, relayFails = false } = {}) {
  const reads = [], sent = [];
  const publicClient = {
    readContract: async ({ address, functionName, args }) => {
      reads.push(functionName);
      assert.equal(address, CHAIN.registry);
      if (functionName === "getPreregistration") {
        return prereg && args[0] === prereg.id ? prereg.row : [ZERO_ADDR, E.ZERO32, E.ZERO32, 0, "0x", 0n, 0n, ZERO_ADDR, E.ZERO32, E.ZERO32];
      }
      if (functionName === "getAttestation") return attestation ?? [ZERO_ADDR, E.ZERO32, E.ZERO32, 0, "0x", 0n];
      throw new Error(`unexpected read ${functionName}`);
    },
    getTransactionReceipt: async () => ({ blockNumber: 100n, status: "success" }),
    getBlock: async () => ({ timestamp: BigInt(SUBMITTED_AT) }),
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 101n }),
  };
  const relayerWallet = {
    writeContract: async (req) => {
      if (relayFails) throw new Error("rpc unavailable");
      sent.push(req);
      return "0x" + "ee".repeat(32);
    },
  };
  return { reads, sent, deps: { ...CHAIN, publicClient, relayerWallet, signerAccount: privateKeyToAccount(generatePrivateKey()), now: () => JUDGED_AT + 10 } };
}

const signerOf = (args, signature) => recoverTypedDataAddress({
  domain: { name: "JudgeAttestor", version: "1", chainId: CHAIN.chainId, verifyingContract: CHAIN.attestor },
  types: ATTESTATION_TYPES, primaryType: "Attestation",
  message: { preregistrationId: args[0], bundleDigest: args[1], attestationDigest: args[2], verdict: args[3], obligationOutcomes: args[4] },
  signature });

test("a job nobody preregistered is left alone: nothing is signed or sent", async () => {
  const f = fakes();
  const r = await attestRuling(ruling(), f.deps);
  assert.equal(r.status, "not-preregistered");
  assert.equal(r.preregistrationId, preregFor(ruling()).id, "tells the client which id it would have had");
  assert.deepEqual(f.sent, []);
});

test("a preregistered job is attested: signed by the judge's key, relayed, and the package verifies", async () => {
  for (const [passes, verdict, outcomes] of [[[true, true], 1, "0x50"], [[true, false], 2, "0x40"]]) {
    const r0 = ruling(passes);
    const p = preregFor(r0);
    const f = fakes({ prereg: p });
    const r = await attestRuling(r0, f.deps);
    assert.equal(r.status, "attested", JSON.stringify(r));
    assert.equal(f.sent.length, 1);
    const call = f.sent[0];
    assert.equal(call.address, CHAIN.attestor);
    assert.equal(call.functionName, "attest");
    const [id, bundleDigest, attestationDigest, v, outs, signature] = call.args;
    assert.equal(id, p.id);
    assert.equal(v, verdict);
    assert.equal(outs, outcomes);
    assert.equal(bundleDigest, E.docDigest(r.documents.bundle));
    assert.equal(attestationDigest, E.docDigest(r.documents.attestation));
    assert.equal((await signerOf(call.args, signature)).toLowerCase(), f.deps.signerAccount.address.toLowerCase());
    assert.deepEqual(r.documents.criteria, p.doc.doc, "the same criteria document the client registered");
    const pkg = { chain: { chainId: CHAIN.chainId, registry: CHAIN.registry, preregistrationId: id, author: CLIENT,
      criteriaDigest: p.doc.criteriaDigest, taskRef: p.doc.taskRef, obligationCount: p.doc.obligationCount,
      obligationFlags: p.doc.obligationFlags, expiry: EXPIRY, registeredAt: REGISTERED_AT, verifier: CHAIN.attestor, supersedes: E.ZERO32,
      attestation: { verifier: CHAIN.attestor, bundleDigest, attestationDigest, verdict: ["None", "Satisfied", "NotSatisfied"][v],
        obligationOutcomes: outs, attestedAt: JUDGED_AT + 20 } }, ...r.documents };
    const check = await E.checkPackage(pkg);
    assert.deepEqual([check.violations, check.unchecked], [[], []]);
  }
});

test("never attests twice, a superseded record, or after the expiry", async () => {
  const r0 = ruling();
  const cases = [
    ["already-attested", fakes({ prereg: preregFor(r0), attestation: [CHAIN.attestor, E.ZERO32, E.ZERO32, 1, "0x50", 1n] })],
    ["already-attested", fakes({ prereg: preregFor(r0), attestation: [ZERO_ADDR, E.ZERO32, E.ZERO32, 4, "0x", 1n] })], // ExpiredUnresolved
    ["superseded", fakes({ prereg: preregFor(r0, { supersededBy: "0x" + "12".repeat(32) }) })],
  ];
  const late = fakes({ prereg: preregFor(r0) });
  late.deps.now = () => EXPIRY + 1;
  cases.push(["expired", late]);
  for (const [status, f] of cases) {
    const r = await attestRuling(r0, f.deps);
    assert.equal(r.status, status);
    assert.deepEqual(f.sent, [], status);
  }
});

test("evidence older than the preregistration is never attested: O1 would refute it", async () => {
  const r0 = ruling();
  const f = fakes({ prereg: preregFor(r0, { registeredAt: SUBMITTED_AT + 1 }) });
  const r = await attestRuling(r0, f.deps);
  assert.equal(r.status, "evidence-predates-criteria");
  assert.deepEqual(f.sent, []);
});

test("a relay failure keeps the signed attestation, so anyone can submit it later", async () => {
  const r0 = ruling();
  const f = fakes({ prereg: preregFor(r0), relayFails: true });
  const r = await attestRuling(r0, f.deps);
  assert.equal(r.status, "signed-not-relayed");
  assert.match(r.reason, /rpc unavailable/);
  assert.equal((await signerOf(r.relay.args, r.relay.args[5])).toLowerCase(), f.deps.signerAccount.address.toLowerCase());
});

test("criteria the profile cannot express are skipped with a reason, before any chain read", async () => {
  const f = fakes();
  const r = await attestRuling(ruling([true, true], { criteria: { version: 1, checks: [{ kind: "length", params: { min: 3 }, weight: 0.5 }, { kind: "contains", params: { all: ["USDC"] } }] } }), f.deps);
  assert.equal(r.status, "unsupported");
  assert.match(r.reason, /integer/);
  assert.deepEqual([f.reads, f.sent], [[], []]);
});

test("a verdict its own documents contradict is refused, never signed", async () => {
  const r0 = ruling([true, false], { pass: true });
  const f = fakes({ prereg: preregFor(r0) });
  const r = await attestRuling(r0, f.deps);
  assert.equal(r.status, "refused");
  assert.match(r.reason, /contradicts/);
  assert.deepEqual(f.sent, []);
});

test("a preregistration whose chain fields disagree with the document is not attested: O5 would refute it", async () => {
  const r0 = ruling();
  for (const [label, patch] of [
    ["another verifier", (row) => { row[7] = "0x2222222222222222222222222222222222222222"; }],
    ["other flags", (row) => { row[4] = "0x40"; }],
    ["another expiry", (row) => { row[5] = BigInt(EXPIRY + 60); }],
    ["a supersedes link", (row) => { row[8] = "0x" + "34".repeat(32); }],
  ]) {
    const p = preregFor(r0);
    patch(p.row);
    const f = fakes({ prereg: p });
    const r = await attestRuling(r0, f.deps);
    assert.equal(r.status, "mismatch", label);
    assert.deepEqual(f.sent, [], label);
  }
});
