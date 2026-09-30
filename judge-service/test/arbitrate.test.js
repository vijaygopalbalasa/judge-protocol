// JudgeArbitrator rulings: a signature only for a fresh Judge ruling on a bounty in dispute, bound to the pinned record,
// and only when the deployed contract computes the same digest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToBytes, toBytes, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cidV0, ARCBOUNTY_NETWORKS, escrowCommitmentOf } from "../src/arcbounty.js";
import { prepareRuling, signRuling, localDigest, rulingDomain, RULING_TYPES, runArbitrateCli } from "../src/arbitrate.js";

const NET = "arc-testnet";
const net = ARCBOUNTY_NETWORKS[NET];
const ARBITRATOR = "0xb810FEFDDE482f908e01F84c5c3645A7036816F2";
const signer = privateKeyToAccount("0x" + "11".repeat(32));

const criteria = { version: 1, passThreshold: 100, checks: [
  { kind: "length", params: { min: 5, max: 60, unit: "words" } },
  { kind: "contains", params: { all: ["escrow", "USDC"] } },
] };
const describe = (c) => Buffer.from("# Explain escrow in one line\n\n```judge-criteria\n" + JSON.stringify(c) + "\n```\n");
const description = describe(criteria);
const good = Buffer.from("The escrow holds USDC until the judge rules on the work.");
const bad = Buffer.from("A note that never names either of the two required terms.");
const link = (b) => `ipfs://${cidV0(b)}`;

const HEAD_TS = 5_000_000n;

/** A fake Arc testnet: one bounty (job 7) in dispute, the adapter, and our JudgeArbitrator. */
function fakeChain({ sub = good, desc = description, over = {}, arb = {} } = {}) {
  const meta = { poster: "0x" + "ab".repeat(20), ipfsDescHash: link(desc), submittedResultHash: link(sub), submittedAt: 1052n,
    rejectedAt: 0n, inDispute: true, resolved: false, disputeRaisedAt: 1100n, ...over };
  const roles = { adapterOfArb: net.adapter, arbitratorOfAdapter: ARBITRATOR, active: true, paused: false, handingBack: false,
    digestFor: (r) => localDigest(net.chainId, ARBITRATOR, net.adapter, r), ...arb };
  return {
    getChainId: async () => net.chainId,
    getBlockNumber: async () => 100n,
    getBlock: async (q = {}) => (q.blockNumber === undefined
      ? { number: 100n, timestamp: HEAD_TS }
      : { number: q.blockNumber, timestamp: 1000n + 2n * q.blockNumber }),
    getLogs: async () => [{ address: net.escrow, args: { jobId: 7n, deliverable: escrowCommitmentOf(meta.submittedResultHash) }, blockNumber: 26n }],
    readContract: async ({ address, functionName, args }) => {
      const a = String(address).toLowerCase();
      if (a === net.adapter.toLowerCase()) {
        if (functionName === "bounties") return meta;
        if (functionName === "arbitrator") return roles.arbitratorOfAdapter;
      }
      if (a === ARBITRATOR.toLowerCase()) {
        if (functionName === "adapter") return roles.adapterOfArb;
        if (functionName === "isActiveSigner") return roles.active && String(args[0]).toLowerCase() === signer.address.toLowerCase();
        if (functionName === "paused") return roles.paused;
        if (functionName === "handingBack") return roles.handingBack;
        if (functionName === "rulingDigest") return roles.digestFor(args[0]);
      }
      throw new Error(`unexpected call ${functionName} on ${address}`);
    },
  };
}

/** The ruling record Judge pins: what arcbounty.js prints for the same bounty. */
async function pinnedRecordFor(chain) {
  const { runCli } = await import("../src/arcbounty.js");
  const r = await runCli(["7", "--network", NET], { makeClient: () => chain, fetchImpl: serve({}), now: () => 2000n });
  return Buffer.from(JSON.stringify(r.result, null, 2) + "\n");
}

const files = {};
const serve = (extra) => async (url) => {
  const cid = url.split("/").pop();
  const all = { [cidV0(description)]: description, [cidV0(good)]: good, [cidV0(bad)]: bad, ...files, ...extra };
  if (all[cid]) return { status: 200, content: all[cid] };
  throw new Error("404");
};

async function setup(opts = {}) {
  const chain = fakeChain(opts);
  const record = opts.record ?? (await pinnedRecordFor(fakeChain({ sub: opts.sub, desc: opts.desc })));
  const cid = cidV0(record);
  const deps = { client: chain, fetchImpl: serve({ [cid]: record }), now: () => 2000n };
  return { chain, record, cid, deps };
}

test("a fresh PASS ruling on a disputed bounty becomes a signed ruling that pays the worker, bound to the chain's strings", async () => {
  const { cid, deps } = await setup();
  const p = await prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid, signerAddress: signer.address, ...deps });
  assert.equal(p.ruling.jobId, 7n);
  assert.equal(p.ruling.payProvider, true);
  assert.equal(p.ruling.reputationPenalty, 0, "penalty is always 0 (ArcBounty's call, 2026-09-30)");
  assert.equal(p.ruling.rulingCid, `ipfs://${cid}`);
  assert.equal(p.ruling.issuedAt, HEAD_TS, "dated by the chain's head, never the wall clock");
  assert.equal(p.ruling.submissionHash, keccak256(stringToBytes(link(good))));
  assert.equal(p.ruling.descriptionHash, keccak256(stringToBytes(link(description))));

  const s = await signRuling(p, signer);
  const recovered = await recoverTypedDataAddress({ domain: rulingDomain(net.chainId, ARBITRATOR), types: RULING_TYPES,
    primaryType: "Ruling", message: { adapter: net.adapter, ...p.ruling }, signature: s.signature });
  assert.equal(recovered, signer.address);
  assert.equal(s.digest, p.digest);
});

test("a fresh REJECT ruling refunds the poster", async () => {
  const { cid, deps } = await setup({ sub: bad });
  const p = await prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid, signerAddress: signer.address, ...deps });
  assert.equal(p.ruling.payProvider, false);
});

test("no signature when Judge abstains (a description without a criteria block)", async () => {
  const plain = Buffer.from("# A bounty with no criteria\n\nJust vibes.\n");
  const chain = fakeChain({ desc: plain });
  const record = Buffer.from("{}\n");
  const deps = { client: chain, fetchImpl: serve({ [cidV0(plain)]: plain, [cidV0(record)]: record }), now: () => 2000n };
  await assert.rejects(prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid: cidV0(record), signerAddress: signer.address, ...deps }),
    /refused: Judge did not rule/);
});

test("no signature for a bounty that is not in dispute, or already resolved", async () => {
  for (const over of [{ inDispute: false }, { resolved: true, inDispute: false }]) {
    const { cid, deps } = await setup({ over });
    await assert.rejects(prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid, signerAddress: signer.address, ...deps }),
      /refused: job 7 is not in dispute/);
  }
});

test("no signature when the pinned record is not this ruling, or the CID does not serve it", async () => {
  const { deps } = await setup();
  const other = await pinnedRecordFor(fakeChain({ sub: bad })); // a real record, for the other submission
  await assert.rejects(prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid: cidV0(other), signerAddress: signer.address,
    ...deps, fetchImpl: serve({ [cidV0(other)]: other }) }), /refused: the pinned record is not this ruling/);
  await assert.rejects(prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid: cidV0(Buffer.from("never pinned")),
    signerAddress: signer.address, ...deps }), /refused: the pinned record/);
  await assert.rejects(prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid: "bafynotacidv0", signerAddress: signer.address, ...deps }),
    /refused: .*CID/);
});

test("no signature unless our contract holds the role, serves this adapter, runs, and trusts the signer", async () => {
  const cases = [
    [{ arbitratorOfAdapter: "0x" + "de".repeat(20) }, /does not hold the adapter's arbitrator role/],
    [{ adapterOfArb: "0x" + "cd".repeat(20) }, /serves another adapter/],
    [{ paused: true }, /paused/],
    [{ handingBack: true }, /handing the role back/],
    [{ active: false }, /not an active signer/],
  ];
  for (const [arb, re] of cases) {
    const { cid, deps } = await setup({ arb });
    await assert.rejects(prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid, signerAddress: signer.address, ...deps }), re);
  }
});

test("no signature when the deployed contract computes another digest", async () => {
  const { cid, deps } = await setup({ arb: { digestFor: () => "0x" + "00".repeat(32) } });
  await assert.rejects(prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid, signerAddress: signer.address, ...deps }),
    /refused: the contract's digest differs/);
});

test("no signature on another chain than the network asked for", async () => {
  const { cid, deps } = await setup();
  const wrong = { ...deps.client, getChainId: async () => 5042 };
  await assert.rejects(prepareRuling({ jobId: "7", network: NET, arbitrator: ARBITRATOR, cid, signerAddress: signer.address, ...deps, client: wrong }),
    /chain 5042, not arc-testnet/);
});

test("the CLI needs the signer key and never prints it", async () => {
  const { cid, deps } = await setup();
  const argv = ["7", "--network", NET, "--arbitrator", ARBITRATOR, "--cid", cid];
  await assert.rejects(runArbitrateCli(argv, { ...deps, env: {} }), /ARBITRATOR_SIGNER_KEY/);
  const key = "0x" + "11".repeat(32);
  const out = await runArbitrateCli(argv, { ...deps, env: { ARBITRATOR_SIGNER_KEY: key } });
  assert.equal(out.record.signer, signer.address);
  assert.equal(out.record.relayed, false, "signing alone sends nothing");
  assert.ok(!JSON.stringify(out.record).includes(key.slice(2)), "the key is not in the record");
  assert.equal(out.record.ruling.jobId, "7");
  assert.equal(out.record.rulingCid, `ipfs://${cid}`);
});
