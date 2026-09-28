// The ERC-8404 snapshot producer (src/rvr-snapshot.mjs) freezes one ruling into
// the profile's evidence closure. A snapshot the profile accepts must state chain
// facts as they were at one block, so these tests hold the producer to that: the
// chain id comes from the chain, every read is at or before readAt, the verdict's
// log agrees with the stored verdict, and a submit transaction it cannot read is
// an error, never a silent fall back to the client's description.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeEventTopics, keccak256, parseAbiItem, stringToHex, toHex } from "viem";
import { mockChain, TEXT, JUDGE } from "./helpers/mock-chain.js";

const { freezeRuling } = await import("../src/rvr-snapshot.mjs");

const VERDICT_SUBMITTED = parseAbiItem("event VerdictSubmitted(uint256 indexed jobId, bool indexed pass, uint8 score, bytes32 criteriaHash, bytes32 deliverable, bytes32 evidenceHash, address signer)");
const LATEST = 64_000_000n;
const COMMITTED = keccak256(stringToHex(TEXT));
const VERDICT = { jobId: 7n, criteriaHash: keccak256(toHex("criteria")), deliverable: COMMITTED, score: 100, threshold: 100, pass: true,
  evidenceHash: keccak256(toHex("evidence")), timestamp: 1_790_000_000n };

/** mockChain plus what the producer also reads: the chain id, block hashes and VerdictSubmitted logs. */
function chain({ chainId = 5042002, verdict = VERDICT, verdictLog = {}, hashAtSecondRead, ...jobOptions } = {}) {
  const { clients: { publicClient } } = mockChain({ latest: LATEST, jobs: [{ id: 7, status: verdict ? "Completed" : "Submitted", verdict, ...jobOptions }] });
  const verdictLogs = verdict ? [{ address: JUDGE, blockNumber: verdictLog.block ?? LATEST - 40n, transactionHash: keccak256(toHex("verdict-tx")),
    args: { jobId: 7n, pass: verdict.pass, score: verdictLog.score ?? verdict.score, criteriaHash: verdictLog.criteriaHash ?? verdict.criteriaHash,
      deliverable: verdictLog.deliverable ?? verdict.deliverable, evidenceHash: verdict.evidenceHash, signer: JUDGE },
    topics: encodeEventTopics({ abi: [VERDICT_SUBMITTED], eventName: "VerdictSubmitted", args: { jobId: 7n, pass: verdict.pass } }) }] : [];
  let blockReads = 0;
  return {
    ...publicClient,
    getChainId: async () => chainId,
    getBlock: async ({ blockTag, blockNumber }) => {
      const number = blockTag === "latest" ? LATEST : BigInt(blockNumber);
      blockReads++;
      const hash = blockReads > 1 && hashAtSecondRead ? hashAtSecondRead : keccak256(toHex(`block-${number}`));
      return { number, hash };
    },
    getLogs: async (args) => (String(args.address).toLowerCase() === JUDGE.toLowerCase()
      ? verdictLogs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock)
      : publicClient.getLogs(args)),
  };
}

test("a ruling is frozen at one block, with the submission's job id and the verdict's own log", async () => {
  const { snapshot, content } = await freezeRuling({ publicClient: chain(), jobId: 7n });
  assert.equal(snapshot.chainId, "5042002");
  assert.equal(snapshot.readAt.blockNumber, String(LATEST));
  assert.equal(snapshot.submission.jobId, "7");
  assert.equal(snapshot.submission.deliverable, COMMITTED);
  assert.equal(snapshot.verdict.blockNumber, String(LATEST - 40n));
  assert.equal(Buffer.from(content).toString("utf8"), TEXT);
});

test("the chain id is asked of the chain, never taken from config", async () => {
  await assert.rejects(freezeRuling({ publicClient: chain({ chainId: 1 }), jobId: 7n }), /chain 1, not 5042002/);
});

test("a hinted submit transaction mined after readAt is refused", async () => {
  const hint = keccak256(toHex("late-submit"));
  await assert.rejects(freezeRuling({ publicClient: chain({ txHash: hint, block: LATEST + 5n }), jobId: 7n, submitTx: hint }), /after readAt/);
});

test("a verdict log that disagrees with the stored verdict is refused", async () => {
  await assert.rejects(freezeRuling({ publicClient: chain({ verdictLog: { deliverable: keccak256(toHex("other")) } }), jobId: 7n }),
    /does not match the stored verdict/);
});

test("so is a verdict log whose score or criteria differ from the stored verdict", async () => {
  await assert.rejects(freezeRuling({ publicClient: chain({ verdictLog: { score: 99 } }), jobId: 7n }), /does not match the stored verdict/);
  await assert.rejects(freezeRuling({ publicClient: chain({ verdictLog: { criteriaHash: keccak256(toHex("other criteria")) } }), jobId: 7n }),
    /does not match the stored verdict/);
});

test("a chain that moved under the reads (readAt's hash changed) is refused", async () => {
  await assert.rejects(freezeRuling({ publicClient: chain({ hashAtSecondRead: keccak256(toHex("reorg")) }), jobId: 7n }), /reorganized/);
});

test("a submit transaction that cannot be read is an error, not the client's description", async () => {
  const client = chain({ description: `Job.\n\`\`\`judge-criteria\n{"checks":[{"kind":"length"}]}\n\`\`\`\ndeliverableURI: data:text/plain,elsewhere` });
  client.getTransaction = async () => { throw new Error("HTTP request failed. Status: 503"); };
  await assert.rejects(freezeRuling({ publicClient: client, jobId: 7n }), /cannot read the submit transaction/);
});

test("a job with no verdict yet is frozen with verdict null", async () => {
  const { snapshot } = await freezeRuling({ publicClient: chain({ verdict: null }), jobId: 7n });
  assert.equal(snapshot.verdict, null);
});

test("the command line runs when started through a symlink (a no-op there would write nothing and exit 0)", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rvr-snapshot-"));
  const link = path.join(dir, "rvr-snapshot.mjs");
  fs.symlinkSync(fileURLToPath(new URL("../src/rvr-snapshot.mjs", import.meta.url)), link);
  try {
    const run = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.equal(run.status, 2, `exit code ${run.status}, stderr: ${run.stderr}`);
    assert.match(run.stderr, /usage: node src\/rvr-snapshot\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
