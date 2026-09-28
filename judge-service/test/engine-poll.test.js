import test from "node:test";
import assert from "node:assert/strict";
import { pollOnce } from "../src/engine.js";

// Stub client: records the block ranges getLogs is called with, returns no logs.
function stubClients(latestBlock, ranges) {
  return {
    publicClient: {
      getBlockNumber: async () => latestBlock,
      getLogs: async ({ fromBlock, toBlock }) => {
        ranges.push([fromBlock, toBlock]);
        return [];
      },
    },
    signerAccount: {},
    relayerWallet: {},
  };
}

test("pollOnce scans a long catch-up in bounded chunks (RPC range safety)", async () => {
  const ranges = [];
  const tip = await pollOnce(stubClients(25_000n, ranges), 1n);
  assert.equal(tip, 25_000n);
  assert.deepEqual(ranges, [
    [1n, 10_000n],
    [10_001n, 20_000n],
    [20_001n, 25_000n],
  ]);
});

test("pollOnce with an up-to-date cursor issues a single bounded query", async () => {
  const ranges = [];
  const tip = await pollOnce(stubClients(105n, ranges), 100n);
  assert.equal(tip, 105n);
  assert.deepEqual(ranges, [[100n, 105n]]);
});

test("pollOnce past the tip scans nothing and does not move backwards", async () => {
  const ranges = [];
  const tip = await pollOnce(stubClients(100n, ranges), 101n);
  assert.equal(tip, 100n); // caller resumes from tip+1 == 101, cursor stays put
  assert.deepEqual(ranges, []);
});

test("a verdict is dated no later than the chain head, whichever clock runs ahead", async () => {
  const { verdictTimestamp, VERDICT_CLOCK_MARGIN_S } = await import("../src/engine.js");
  const chainAt = (t) => ({ getBlock: async ({ blockTag }) => { assert.equal(blockTag, "latest"); return { number: 1n, timestamp: t }; } });
  const head = 1_790_000_000n;
  // This machine's clock is an hour ahead of the chain: dating by the clock would be a verdict from the
  // future, which JudgeEvaluator refuses (StaleVerdict). The chain's head decides.
  assert.equal(await verdictTimestamp(chainAt(head), Number(head + 3600n) * 1000), head - VERDICT_CLOCK_MARGIN_S);
  // The clock is behind the chain (a node ahead of the others): the clock decides.
  assert.equal(await verdictTimestamp(chainAt(head), Number(head - 60n) * 1000), head - 60n - VERDICT_CLOCK_MARGIN_S);
  assert.equal(await verdictTimestamp(chainAt(head), Number(head) * 1000 + 999), head - VERDICT_CLOCK_MARGIN_S, "whole seconds, rounded down");
  // A head that cannot be read is an error, never a silent fall back to the clock that caused the problem.
  const down = { getBlock: async () => { throw new Error("HTTP request failed. Status: 503"); } };
  await assert.rejects(verdictTimestamp(down, Number(head) * 1000), /503/);
});
