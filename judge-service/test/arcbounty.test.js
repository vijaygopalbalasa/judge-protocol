// ArcBounty rulings: every link from the escrow to the file bytes is recomputed, never trusted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak256, toBytes, stringToBytes } from "viem";
import {
  cidV0, parseIpfsLink, escrowCommitmentOf, reviewerDecision, ruleOnSubmission, criteriaFromDescription,
  rulingHashOf, blockAtOrAfter, readBounty, fetchVerified, runCli, MAX_SINGLE_BLOCK, ARCBOUNTY_NETWORKS,
} from "../src/arcbounty.js";

const fixture = (f) => readFileSync(new URL(`./fixtures/arcbounty/${f}`, import.meta.url));

test("cidV0 matches IPFS's own CIDs: the empty file, hello world, and a description ArcBounty pinned", () => {
  assert.equal(cidV0(Buffer.alloc(0)), "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH");
  assert.equal(cidV0(Buffer.from("hello world\n")), "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o");
  // job 5 on ArcBounty's Arc mainnet adapter: its description is ipfs://QmTakzdHyr8y...
  assert.equal(cidV0(fixture("job5-description.md")), "QmTakzdHyr8yDS9ca7odE76nND7bXPYjwMHD2TVza2JHgH");
});

test("cidV0 refuses a file IPFS would split into several blocks, and accepts one full block", () => {
  assert.throws(() => cidV0(Buffer.alloc(MAX_SINGLE_BLOCK + 1)), /several blocks/);
  assert.match(cidV0(Buffer.alloc(MAX_SINGLE_BLOCK)), /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
});

test("parseIpfsLink takes ipfs://Qm... and a bare CIDv0, and refuses anything that is not content-addressed", () => {
  const cid = "QmTakzdHyr8yDS9ca7odE76nND7bXPYjwMHD2TVza2JHgH";
  assert.deepEqual(parseIpfsLink(`ipfs://${cid}`), { cid });
  assert.deepEqual(parseIpfsLink(cid), { cid });
  assert.match(parseIpfsLink("https://gist.github.com/someone/abc").error, /not content-addressed/);
  assert.match(parseIpfsLink("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi").error, /CIDv1/);
  assert.match(parseIpfsLink("ipfs://Qm123").error, /not a CIDv0/);
  assert.match(parseIpfsLink(`ipfs://${cid.slice(0, -1)}0`).error, /not a CIDv0/, "0 is not a base58 digit");
  assert.match(parseIpfsLink("").error, /no link/);
  assert.match(parseIpfsLink(undefined).error, /no link/);
});

test("escrowCommitmentOf is keccak256 of the link string, as the adapter commits it (job 5 on Arc mainnet)", () => {
  // JobSubmitted(5).deliverable on the escrow 0x64cA39Fc..., tx 0x20a74e9e77...
  assert.equal(escrowCommitmentOf("ipfs://Qmaf3UVHbQTtMkUThyyrG93Q4G5yJuPb7i2Yqt8sMQ3xxr"),
    "0x8d4a1f5b7fa363a28452aaeccceff02f06767ae4e41d61c8b8f60dd4774b6127");
});

const criteria = { version: 1, passThreshold: 100, checks: [
  { kind: "length", params: { min: 5, max: 60, unit: "words" } },
  { kind: "contains", params: { all: ["escrow", "USDC"] } },
] };
const describe = (c) => Buffer.from("# Explain escrow in one line\n\nA short note.\n\n```judge-criteria\n" + JSON.stringify(c) + "\n```\n");
const description = describe(criteria);
const good = Buffer.from("The escrow holds USDC until the judge rules on the work.");
const bad = Buffer.from("A note that never names either of the two required terms.");
const link = (b) => `ipfs://${cidV0(b)}`;
const input = (sub, over = {}) => ({
  network: "arc-mainnet", jobId: "42",
  descriptionLink: link(description), descriptionBytes: description,
  submissionLink: link(sub), submissionBytes: sub,
  escrowCommitment: keccak256(toBytes(link(sub))), decision: "awaiting-review", ...over,
});

test("a submission that meets the description's criteria is ruled PASS, with every link recorded", async () => {
  const r = await ruleOnSubmission(input(good));
  assert.equal(r.status, "ruled", r.reason);
  const g = r.ruling;
  assert.equal(g.kind, "judge-protocol/arcbounty-ruling@1");
  assert.equal(g.pass, true);
  assert.equal(g.score, 100);
  assert.equal(g.jobId, "42");
  assert.equal(g.adapter, ARCBOUNTY_NETWORKS["arc-mainnet"].adapter);
  assert.equal(g.escrow, ARCBOUNTY_NETWORKS["arc-mainnet"].escrow);
  assert.equal(g.description.cid, cidV0(description));
  assert.equal(g.submission.cid, cidV0(good));
  assert.equal(g.submission.escrowCommitment, keccak256(toBytes(link(good))));
  assert.equal(g.submission.contentKeccak, keccak256(good));
  assert.deepEqual(g.criteria, criteria);
  assert.match(g.criteriaHash, /^0x[0-9a-f]{64}$/);
  assert.match(g.evidenceHash, /^0x[0-9a-f]{64}$/);
  assert.equal(g.reviewerDecision, "awaiting-review");
  assert.match(g.recompute, /arcbounty\.js 42 --network arc-mainnet/);
});

test("a submission that misses the criteria is ruled REJECT: a real ruling, not an abstention", async () => {
  const r = await ruleOnSubmission(input(bad));
  assert.equal(r.status, "ruled");
  assert.equal(r.ruling.pass, false);
  assert.ok(r.ruling.score < 100);
});

test("the same inputs always give the same evidenceHash, and a different submission a different one", async () => {
  const a = await ruleOnSubmission(input(good));
  const b = await ruleOnSubmission(input(good));
  const c = await ruleOnSubmission(input(bad));
  assert.equal(a.ruling.evidenceHash, b.ruling.evidenceHash);
  assert.notEqual(a.ruling.evidenceHash, c.ruling.evidenceHash);
});

test("one changed byte in the submission is caught: the judge abstains instead of ruling on other content", async () => {
  const tampered = Buffer.from(good);
  tampered[0] ^= 1;
  const r = await ruleOnSubmission({ ...input(good), submissionBytes: tampered });
  assert.equal(r.status, "abstained");
  assert.match(r.reason, /submission.*does not match its CID/);
});

test("a description whose bytes do not match its CID is caught the same way", async () => {
  const other = describe({ ...criteria, passThreshold: 50 });
  const r = await ruleOnSubmission({ ...input(good), descriptionBytes: other });
  assert.equal(r.status, "abstained");
  assert.match(r.reason, /description.*does not match its CID/);
});

test("an escrow commitment that is not keccak256 of the submission link is refused, and a missing one too", async () => {
  let r = await ruleOnSubmission({ ...input(good), escrowCommitment: keccak256(toBytes(link(bad))) });
  assert.equal(r.status, "abstained");
  assert.match(r.reason, /escrow's commitment is not keccak256 of the submission link/);
  // The two refusals say different things: nothing on chain is not the same finding as a mismatch.
  for (const missing of [undefined, null, "", "0x1234"]) {
    r = await ruleOnSubmission({ ...input(good), escrowCommitment: missing });
    assert.equal(r.status, "abstained");
    assert.match(r.reason, /escrow shows no commitment/, String(missing));
  }
});

test("a description without a judge-criteria block, or with invalid criteria, gets no ruling", async () => {
  const plain = Buffer.from("# A bounty with no criteria\n\nWrite something good.\n");
  let r = await ruleOnSubmission({ ...input(good), descriptionLink: link(plain), descriptionBytes: plain });
  assert.equal(r.status, "abstained");
  assert.match(r.reason, /judge-criteria/);
  const invalid = describe({ version: 1, checks: [{ kind: "length", params: { minWords: 3 } }] });
  r = await ruleOnSubmission({ ...input(good), descriptionLink: link(invalid), descriptionBytes: invalid });
  assert.equal(r.status, "abstained");
  assert.match(r.reason, /invalid criteria/i);
});

test("a submission that is a web link rather than an IPFS file gets no ruling", async () => {
  const r = await ruleOnSubmission({ ...input(good), submissionLink: "https://gist.github.com/someone/abc",
    escrowCommitment: keccak256(toBytes("https://gist.github.com/someone/abc")) });
  assert.equal(r.status, "abstained");
  assert.match(r.reason, /not content-addressed/);
});

test("criteria that need a live network probe are not ruled on, since nobody could recompute them", async () => {
  const live = describe({ version: 1, checks: [{ kind: "http-endpoint", params: { url: "https://example.com", expectStatus: 200 } }] });
  const r = await ruleOnSubmission({ ...input(good), descriptionLink: link(live), descriptionBytes: live });
  assert.equal(r.status, "abstained");
  assert.match(r.reason, /live/);
});

test("an unknown network is refused rather than guessed", async () => {
  const r = await ruleOnSubmission({ ...input(good), network: "arc-mainet" });
  assert.equal(r.status, "abstained");
  assert.match(r.reason, /network/);
});

// A chain where block n has timestamp 1000 + 2n.
const clock = { getBlock: async ({ blockNumber }) => ({ number: blockNumber, timestamp: 1000n + 2n * blockNumber }) };

test("blockAtOrAfter finds the first block at or after a timestamp", async () => {
  assert.equal(await blockAtOrAfter(clock, 1000n, 0n, 100n), 0n);
  assert.equal(await blockAtOrAfter(clock, 1051n, 0n, 100n), 26n);
  assert.equal(await blockAtOrAfter(clock, 1052n, 0n, 100n), 26n);
  assert.equal(await blockAtOrAfter(clock, 5000n, 0n, 100n), 100n, "past the head: the head");
});

test("readBounty returns the adapter's record and the escrow's commitment from the submission block", async () => {
  const sub = "ipfs://Qmaf3UVHbQTtMkUThyyrG93Q4G5yJuPb7i2Yqt8sMQ3xxr";
  const meta = { submittedResultHash: sub, submittedAt: 1052n, ipfsDescHash: "ipfs://QmTakzdHyr8yDS9ca7odE76nND7bXPYjwMHD2TVza2JHgH",
    rejectedAt: 0n, inDispute: false, resolved: true, disputeRaisedAt: 0n };
  const seen = [];
  const client = {
    ...clock,
    getBlockNumber: async () => 100n,
    readContract: async ({ functionName, args }) => { assert.equal(functionName, "bounties"); assert.equal(args[0], 5n); return meta; },
    getLogs: async (q) => { seen.push(q); return [{ address: "0xe", args: { jobId: 5n, deliverable: escrowCommitmentOf(sub) }, blockNumber: 26n }]; },
  };
  const r = await readBounty(client, { adapter: "0xa", escrow: "0xe", fromBlock: 0n }, 5n);
  assert.equal(r.meta, meta);
  assert.equal(r.escrowCommitment, escrowCommitmentOf(sub));
  assert.equal(r.submittedBlock, 26n);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].address, "0xe");
  assert.equal(seen[0].args.jobId, 5n);
  assert.ok(seen[0].toBlock - seen[0].fromBlock <= 10000n, "a narrow window that Arc's public RPC accepts");
});

test("readBounty reports no commitment when the escrow shows no submission, or two", async () => {
  const meta = { submittedResultHash: "ipfs://QmX", submittedAt: 1052n, rejectedAt: 0n, inDispute: false, resolved: false, disputeRaisedAt: 0n };
  const mk = (logs) => ({ ...clock, getBlockNumber: async () => 100n, readContract: async () => meta, getLogs: async () => logs });
  assert.equal((await readBounty(mk([]), { adapter: "0xa", escrow: "0xe", fromBlock: 0n }, 5n)).escrowCommitment, null);
  const two = [{ args: { deliverable: "0x" + "11".repeat(32) } }, { args: { deliverable: "0x" + "22".repeat(32) } }];
  assert.equal((await readBounty(mk(two), { adapter: "0xa", escrow: "0xe", fromBlock: 0n }, 5n)).escrowCommitment, null);
});

test("fetchVerified skips a source that serves other bytes and takes the first that matches the CID", async () => {
  const cid = cidV0(good);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith("https://a.example/")) return { status: 200, content: Buffer.from("not it") };
    if (url.startsWith("https://b.example/")) return { status: 200, content: Buffer.from(good) };
    throw new Error("unreachable");
  };
  const got = await fetchVerified(cid, { sources: ["https://a.example/", "https://b.example/", "https://c.example/"], fetchImpl });
  assert.deepEqual(got.bytes, good);
  assert.equal(got.source, "https://b.example/");
  assert.deepEqual(calls, [`https://a.example/${cid}`, `https://b.example/${cid}`]);
  await assert.rejects(fetchVerified(cid, { sources: ["https://a.example/"], fetchImpl }), /no source served bytes matching/);
});

test("escrowCommitmentOf hashes the link's characters, as abi.encodePacked(string) does, even for a 0x string", () => {
  assert.equal(escrowCommitmentOf("0x1234"), keccak256(stringToBytes("0x1234")));
  assert.notEqual(escrowCommitmentOf("0x1234"), keccak256("0x1234"));
});

test("reviewerDecision follows the adapter's lifecycle, including a rejection that can still be undone", () => {
  const day = 86400n;
  const base = { submittedResultHash: "ipfs://QmX", submittedAt: 1000n, rejectedAt: 0n, inDispute: false, resolved: false, disputeRaisedAt: 0n };
  const now = 1000n + day;
  assert.equal(reviewerDecision({ ...base, submittedResultHash: "" }, now), "no-submission");
  assert.equal(reviewerDecision(base, now), "awaiting-review");
  assert.equal(reviewerDecision(base, 1000n + 15n * day), "auto-approvable", "past the 14-day window only approval remains");
  assert.equal(reviewerDecision({ ...base, resolved: true }, now), "approved");
  assert.equal(reviewerDecision({ ...base, rejectedAt: 1100n }, now), "rejection-pending", "the poster can withdraw it, the worker can challenge it");
  assert.equal(reviewerDecision({ ...base, rejectedAt: 1100n, resolved: true }, now), "rejected", "finalizeRejection refunded the poster");
  assert.equal(reviewerDecision({ ...base, rejectedAt: 1100n, inDispute: true, disputeRaisedAt: 1200n }, now), "in-dispute");
  assert.equal(reviewerDecision({ ...base, resolved: true, disputeRaisedAt: 1200n }, now), "dispute-resolved");
});

const withBlock = (text) => Buffer.from(text);
test("criteriaFromDescription takes exactly one judge-criteria block that starts its own line", () => {
  const ok = criteriaFromDescription(withBlock("# Title\n\n```judge-criteria\n" + JSON.stringify(criteria) + "\n```\n"));
  assert.deepEqual(ok.criteria, criteria);
  const two = criteriaFromDescription(withBlock("```judge-criteria\n{\"version\":1,\"checks\":[]}\n```\n\n```judge-criteria\n" + JSON.stringify(criteria) + "\n```\n"));
  assert.match(two.error, /exactly one judge-criteria block/);
  const inline = criteriaFromDescription(withBlock("see ```judge-criteria " + JSON.stringify(criteria) + "``` above"));
  assert.match(inline.error, /no judge-criteria block/);
  const bad = criteriaFromDescription(withBlock("```judge-criteria\n{not json\n```\n"));
  assert.match(bad.error, /does not parse/);
});

test("a criteria block hidden in an HTML comment or nested in a longer fence is refused, never used", () => {
  const decoy = { version: 1, checks: [{ kind: "contains", params: { all: ["zzz"] } }] };
  const hidden = criteriaFromDescription(withBlock("<!--\n```judge-criteria\n" + JSON.stringify(decoy) + "\n```\n-->\n# Visible\n"));
  assert.match(hidden.error, /HTML comment/);
  const both = criteriaFromDescription(withBlock("<!--\n```judge-criteria\n" + JSON.stringify(decoy) + "\n```\n-->\n```judge-criteria\n" + JSON.stringify(criteria) + "\n```\n"));
  assert.ok(both.error, "a hidden block next to a visible one is refused, not resolved");
  const nested = criteriaFromDescription(withBlock("````markdown\n```judge-criteria\n" + JSON.stringify(decoy) + "\n```\n````\n"));
  assert.match(nested.error, /longer code fence/);
});

test("a pathological description is refused quickly", () => {
  const t0 = Date.now();
  const r = criteriaFromDescription(withBlock("```judge-criteria" + " ".repeat(200000)));
  assert.ok(r.error);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test("the rulingHash binds the chain, the contracts, both links and the submission block", async () => {
  const r = await ruleOnSubmission({ ...input(good), submittedBlock: 26n });
  const g = r.ruling;
  assert.equal(g.submittedBlock, "26");
  assert.equal(g.rulingHash, rulingHashOf(g));
  for (const [k, v] of [["chainId", 5043], ["adapter", "0x" + "11".repeat(20)], ["escrow", "0x" + "22".repeat(20)], ["jobId", "43"],
    ["submittedBlock", "27"], ["evidenceHash", "0x" + "33".repeat(32)]]) {
    assert.notEqual(rulingHashOf({ ...g, [k]: v }), g.rulingHash, k);
  }
  assert.notEqual(rulingHashOf({ ...g, submission: { ...g.submission, cid: cidV0(bad) } }), g.rulingHash, "submission cid");
  assert.notEqual(rulingHashOf({ ...g, description: { ...g.description, cid: cidV0(bad) } }), g.rulingHash, "description cid");
  assert.notEqual(rulingHashOf({ ...g, submission: { ...g.submission, escrowCommitment: "0x" + "44".repeat(32) } }), g.rulingHash, "commitment");
});

test("a jobId with leading zeros is the same job: one normalised id and one evidenceHash", async () => {
  const a = await ruleOnSubmission({ ...input(good), jobId: "042" });
  const b = await ruleOnSubmission({ ...input(good), jobId: "42" });
  assert.equal(a.ruling.jobId, "42");
  assert.equal(a.ruling.evidenceHash, b.ruling.evidenceHash);
  assert.equal(a.ruling.rulingHash, b.ruling.rulingHash);
});

test("prototype names are not networks, and missing file bytes abstain instead of throwing", async () => {
  for (const network of ["__proto__", "constructor", "toString"]) {
    const r = await ruleOnSubmission({ ...input(good), network });
    assert.equal(r.status, "abstained", network);
  }
  const r = await ruleOnSubmission({ ...input(good), submissionBytes: undefined });
  assert.equal(r.status, "abstained");
  assert.match(r.reason, /the submission file is missing/);
});

test("readBounty ignores escrow logs from another address or for another job", async () => {
  const sub = "ipfs://Qmaf3UVHbQTtMkUThyyrG93Q4G5yJuPb7i2Yqt8sMQ3xxr";
  const meta = { submittedResultHash: sub, submittedAt: 1052n, rejectedAt: 0n, inDispute: false, resolved: false, disputeRaisedAt: 0n };
  const good = { address: "0xE000000000000000000000000000000000000001", args: { jobId: 5n, deliverable: escrowCommitmentOf(sub) }, blockNumber: 26n };
  const mk = (logs) => ({ ...clock, getBlockNumber: async () => 100n, readContract: async () => meta, getLogs: async () => logs });
  const net = { adapter: "0xa", escrow: "0xe000000000000000000000000000000000000001", fromBlock: 0n };
  const foreign = { ...good, address: "0x000000000000000000000000000000000000dEaD" };
  const otherJob = { ...good, args: { ...good.args, jobId: 6n } };
  assert.equal((await readBounty(mk([foreign, good]), net, 5n)).escrowCommitment, escrowCommitmentOf(sub));
  assert.equal((await readBounty(mk([otherJob, good]), net, 5n)).escrowCommitment, escrowCommitmentOf(sub));
  assert.equal((await readBounty(mk([foreign, otherJob]), net, 5n)).escrowCommitment, null);
});

// A fake chain for the CLI: one bounty (job 7) with a submission the escrow recorded.
function fakeChain({ chainId = 5042, desc, sub, escrow = ARCBOUNTY_NETWORKS["arc-mainnet"].escrow } = {}) {
  const meta = { poster: "0x" + "ab".repeat(20), ipfsDescHash: desc, submittedResultHash: sub, submittedAt: 1052n,
    rejectedAt: 0n, inDispute: false, resolved: false, disputeRaisedAt: 0n };
  return { ...clock, getChainId: async () => chainId, getBlockNumber: async () => 100n, readContract: async () => meta,
    getLogs: async () => [{ address: escrow, args: { jobId: 7n, deliverable: escrowCommitmentOf(sub) }, blockNumber: 26n }] };
}
const serve = (files) => async (url) => {
  const cid = url.split("/").pop();
  if (files[cid]) return { status: 200, content: files[cid] };
  throw new Error("404");
};

test("the CLI rules on a bounty end to end from a chain and a file source, with jobId and network in the output", async () => {
  const chain = fakeChain({ desc: link(description), sub: link(good) });
  const r = await runCli(["7"], { makeClient: () => chain, fetchImpl: serve({ [cidV0(description)]: description, [cidV0(good)]: good }), now: () => 2000n });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result.status, "ruled", r.result.reason);
  assert.equal(r.result.ruling.jobId, "7");
  assert.equal(r.result.ruling.pass, true);
  assert.equal(r.result.ruling.submittedBlock, "26");
});

test("the CLI refuses a chain that is not the network asked for, and unknown flags", async () => {
  const chain = fakeChain({ chainId: 1, desc: link(description), sub: link(good) });
  await assert.rejects(runCli(["7"], { makeClient: () => chain, fetchImpl: serve({}) }), /chain 1, not arc-mainnet \(5042\)/);
  await assert.rejects(runCli(["7", "--netwrok", "arc-mainnet"], { makeClient: () => chain }), /unknown option --netwrok/);
});

test("the CLI reports a file nobody serves as an abstention with the job and network, not a crash", async () => {
  const chain = fakeChain({ desc: link(description), sub: link(good) });
  const r = await runCli(["7"], { makeClient: () => chain, fetchImpl: serve({ [cidV0(description)]: description }), now: () => 2000n });
  assert.equal(r.result.status, "abstained");
  assert.match(r.result.reason, /no source served bytes matching/);
  assert.equal(r.result.jobId, "7");
  assert.equal(r.result.network, "arc-mainnet");
});
