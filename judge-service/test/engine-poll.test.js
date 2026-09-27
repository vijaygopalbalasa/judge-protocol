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
