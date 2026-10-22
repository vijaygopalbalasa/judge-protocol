// GET /api/arcbounty: the keyless check ArcBounty's review script calls (Sofiia7/ARC#4, ask 1 of Oct 1). It must
// answer exactly what `node src/arcbounty.js` prints for the same bounty, refuse anything but a job id and a known
// network, never take an RPC or file source from the caller, and say plainly when it cannot read the chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cidV0, escrowCommitmentOf, runCli, ARCBOUNTY_NETWORKS } from "../src/arcbounty.js";

const { createArcbountyHandler } = await import("../api/arcbounty.js");

function call(handler, { method = "GET", query = {} } = {}) {
  const res = { code: 0, headers: {}, payload: undefined };
  res.status = (c) => { res.code = c; return res; };
  res.json = (o) => { res.payload = o; return res; };
  res.end = () => res;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  return Promise.resolve(handler({ method, headers: {}, query }, res)).then(() => res);
}

// One bounty (job 7) on a fake chain, with its description and submission served by a fake IPFS source.
const criteria = { version: 1, passThreshold: 100, checks: [
  { kind: "length", params: { min: 5, max: 60, unit: "words" } },
  { kind: "contains", params: { all: ["escrow", "USDC"] } },
] };
const description = Buffer.from("# Explain escrow in one line\n\nA short note.\n\n```judge-criteria\n" + JSON.stringify(criteria) + "\n```\n");
const good = Buffer.from("The escrow holds USDC until the judge rules on the work.");
const bad = Buffer.from("A note that never names either of the two required terms.");
const link = (b) => `ipfs://${cidV0(b)}`;
const clock = { getBlock: async ({ blockNumber }) => ({ number: blockNumber, timestamp: 1000n + 2n * blockNumber }) };
function fakeChain({ chainId = 5042, sub = good, poster = "0x" + "ab".repeat(20), submitted = true, network = "arc-mainnet" } = {}) {
  const meta = { poster, ipfsDescHash: link(description), submittedResultHash: submitted ? link(sub) : "", submittedAt: submitted ? 1052n : 0n,
    rejectedAt: 0n, inDispute: false, resolved: false, disputeRaisedAt: 0n };
  const escrow = ARCBOUNTY_NETWORKS[network].escrow;
  return { ...clock, getChainId: async () => chainId, getBlockNumber: async () => 100n, readContract: async () => meta,
    getLogs: async () => [{ address: escrow, args: { jobId: 7n, deliverable: escrowCommitmentOf(link(sub)) }, blockNumber: 26n }] };
}
const serve = (files) => async (url) => {
  const cid = url.split("/").pop();
  if (files[cid]) return { status: 200, content: files[cid] };
  throw new Error("404");
};
const files = { [cidV0(description)]: description, [cidV0(good)]: good, [cidV0(bad)]: bad };
/** The handler with the real CLI underneath, on the fake chain and source; records the argv the CLI was given. */
function withChain(chainOpts = {}, { fetchFiles = files } = {}) {
  const argvs = [];
  const run = (argv) => { argvs.push(argv); return runCli(argv, { makeClient: () => fakeChain(chainOpts), fetchImpl: serve(fetchFiles), now: () => 2000n }); };
  return { handler: createArcbountyHandler({ run }), argvs, run };
}
const plain = (o) => JSON.parse(JSON.stringify(o, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

test("a submission that meets the criteria comes back ruled PASS, exactly as the CLI prints it", async () => {
  const { handler, run } = withChain();
  const r = await call(handler, { query: { jobId: "7" } });
  assert.equal(r.code, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.status, "ruled");
  assert.equal(r.payload.ruling.pass, true);
  assert.equal(r.payload.ruling.score, 100);
  assert.equal(r.payload.network, "arc-mainnet", "Arc mainnet is the default network");
  assert.deepEqual(r.payload, plain((await run(["7", "--network", "arc-mainnet"])).result));
  assert.match(r.payload.ruling.rulingHash, /^0x[0-9a-f]{64}$/);
  assert.match(r.headers["cache-control"], /s-maxage=\d+/);
});

test("a submission that misses the criteria is a real REJECT with the failing check named", async () => {
  const { handler } = withChain({ sub: bad });
  const r = await call(handler, { query: { jobId: "7", network: "arc-mainnet" } });
  assert.equal(r.code, 200);
  assert.equal(r.payload.status, "ruled");
  assert.equal(r.payload.ruling.pass, false);
  assert.ok(r.payload.ruling.results.some((c) => c.kind === "contains" && c.pass === false));
});

test("no submission yet, and a file nobody serves, are answers the review script can act on, not errors", async () => {
  const none = await call(withChain({ submitted: false }).handler, { query: { jobId: "7" } });
  assert.equal(none.code, 200);
  assert.equal(none.payload.status, "no-submission");
  const missing = await call(withChain({}, { fetchFiles: { [cidV0(description)]: description } }).handler, { query: { jobId: "7" } });
  assert.equal(missing.code, 200);
  assert.equal(missing.payload.status, "abstained");
  assert.match(missing.payload.reason, /no source served bytes matching/);
});

test("Arc testnet is served too, on ArcBounty's trial adapter", async () => {
  const { handler, argvs } = withChain({ chainId: 5042002, network: "arc-testnet" });
  const r = await call(handler, { query: { jobId: "7", network: "arc-testnet" } });
  assert.equal(r.code, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.ruling.adapter, ARCBOUNTY_NETWORKS["arc-testnet"].adapter);
  assert.deepEqual(argvs, [["7", "--network", "arc-testnet"]]);
});

test("a job id that is not an ArcBounty bounty is a 404, and a chain read failure is a 503 that is never cached", async () => {
  const notOurs = await call(withChain({ poster: "0x" + "00".repeat(20) }).handler, { query: { jobId: "7" } });
  assert.equal(notOurs.code, 404);
  assert.equal(notOurs.payload.status, "not-found");
  const down = await call(createArcbountyHandler({ run: async () => { throw new Error("HTTP request failed. fetch failed"); } }), { query: { jobId: "7" } });
  assert.equal(down.code, 503);
  assert.equal(down.headers["cache-control"], "no-store");
  assert.doesNotMatch(JSON.stringify(down.payload), /fetch failed/, "no internal error text in the answer");
});

test("only a job id and a known network are taken: no RPC, no file, no option reaches the CLI", async () => {
  const { handler, argvs } = withChain();
  const cases = [
    [{}, /jobId/], [{ jobId: "abc" }, /jobId/], [{ jobId: "0" }, /jobId/], [{ jobId: "-5" }, /jobId/],
    [{ jobId: "7 --rpc http://10.0.0.1" }, /jobId/], [{ jobId: ["7", "8"] }, /jobId/], [{ jobId: "1".repeat(31) }, /jobId/],
    [{ jobId: "7", network: "base" }, /network/], [{ jobId: "7", network: "__proto__" }, /network/], [{ jobId: "7", network: ["arc-mainnet"] }, /network/],
    [{ jobId: "7", rpc: "http://evil.example" }, /unknown parameter "rpc"/], [{ jobId: "7", submission: "/etc/passwd" }, /unknown parameter "submission"/],
  ];
  for (const [query, message] of cases) {
    const r = await call(handler, { query });
    assert.equal(r.code, 400, JSON.stringify(query));
    assert.match(r.payload.error, message, JSON.stringify(query));
  }
  assert.equal(argvs.length, 0, "a refused request never reaches the CLI");
});

test("GET only, with CORS for a browser or a script on another origin", async () => {
  const { handler } = withChain();
  assert.equal((await call(handler, { method: "POST", query: { jobId: "7" } })).code, 405);
  const pre = await call(handler, { method: "OPTIONS" });
  assert.equal(pre.code, 204);
  assert.equal(pre.headers["access-control-allow-origin"], "*");
});
