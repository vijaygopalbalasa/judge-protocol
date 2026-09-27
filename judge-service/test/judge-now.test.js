// The hosted judge: on-demand rulings (anyone may ask; the ruling is
// deterministic, so it does not matter who asks) and the daily safety sweep.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVIDENCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "judge-evidence-"));
const { mockChain, CRITERIA, TEXT, describe } = await import("./helpers/mock-chain.js");
const { judgeNow, sweepRecent, jobStatus } = await import("../src/judge-now.js");
const { evaluateJob } = await import("../src/engine.js");

const deliverableOf = (m, id) => m.logs.find((l) => l.args.jobId === BigInt(id)).args.deliverable;
const txOf = (m, id) => m.logs.find((l) => l.args.jobId === BigInt(id)).transactionHash;

/* --------------------------- structured outcomes --------------------------- */

test("evaluateJob reports why it did or did not judge, instead of returning null", async () => {
  const m = mockChain({ jobs: [
    { id: 1 }, { id: 2, evaluator: "0x000000000000000000000000000000000000dEaD" },
    { id: 3, status: "Completed" }, { id: 4, budget: 5_000n },
    { id: 5, description: "no criteria here" }, { id: 6, content: "tampered" },
  ] });
  const run = (id, hash) => evaluateJob(BigInt(id), hash ?? deliverableOf(m, id), m.clients, txOf(m, id));
  const ok = await run(1);
  assert.equal(ok.outcome, "judged");
  assert.equal(ok.pass, true);
  assert.equal(ok.score, 100);
  assert.match(ok.txHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(await run(2), { outcome: "not-ours" });
  assert.equal((await run(3)).outcome, "skip");
  assert.match((await run(4)).reason, /budget/);
  assert.match((await run(5)).reason, /judge-criteria/);
  const wrong = await run(6, deliverableOf(m, 1)); // content does not hash to the commitment
  assert.equal(wrong.outcome, "abstain");
  assert.match(wrong.reason, /hash mismatch/);
});

/* ------------------------------- judgeNow --------------------------------- */

test("judgeNow rejects bad input with 400 and a missing signer with 503", async () => {
  const m = mockChain({ jobs: [{ id: 1 }] });
  for (const bad of [undefined, "", "abc", "-1", "0", "1e3", "12.5", 12.5, "9".repeat(80)]) {
    const r = await judgeNow({ jobId: bad }, { clients: m.clients });
    assert.equal(r.status, 400, `jobId ${JSON.stringify(bad)}`);
  }
  assert.equal((await judgeNow({ jobId: "1", submitTx: "0x1234" }, { clients: m.clients })).status, 400);
  const noKey = await judgeNow({ jobId: "1" }, { makeClients: () => { throw new Error("no signer key"); } });
  assert.equal(noKey.status, 503);
  assert.equal(m.calls.writeContract.length, 0);
});

test("judgeNow on a Submitted job naming the judge: rules once and settles on-chain", async () => {
  const m = mockChain({ jobs: [{ id: 42 }] });
  const r = await judgeNow({ jobId: "42" }, { clients: m.clients });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "judged");
  assert.equal(r.body.pass, true);
  assert.equal(r.body.score, 100);
  assert.equal(m.calls.writeContract.length, 1);
  assert.equal(m.calls.writeContract[0].functionName, "relay", "a separate relayer must use the permissionless relay()");
});

test("the same relay path also works when signer and relayer are one key", async () => {
  const m = mockChain({ jobs: [{ id: 54 }], sameKey: true });
  const r = await judgeNow({ jobId: "54" }, { clients: m.clients });
  assert.equal(r.body.result, "judged");
});

test("judgeNow finds the submission from a tx hint without scanning logs", async () => {
  const m = mockChain({ jobs: [{ id: 43, block: 1_000n }] }); // far in the past
  const r = await judgeNow({ jobId: "43", submitTx: txOf(m, 43) }, { clients: m.clients });
  assert.equal(r.body.result, "judged");
  assert.equal(m.calls.getLogs.length, 0);
});

test("judgeNow rejects a tx hint that is not this job's submission", async () => {
  const m = mockChain({ jobs: [{ id: 44 }, { id: 45 }] });
  const r = await judgeNow({ jobId: "44", submitTx: txOf(m, 45) }, { clients: m.clients });
  assert.equal(r.status, 404);
  assert.equal(m.calls.writeContract.length, 0);
});

test("judgeNow searches back in bounded windows when there is no hint", async () => {
  const m = mockChain({ latest: 64_000_000n, jobs: [{ id: 46, block: 64_000_000n - 25_000n }] });
  const r = await judgeNow({ jobId: "46" }, { clients: m.clients });
  assert.equal(r.body.result, "judged");
  for (const [from, to] of m.calls.getLogs) assert.ok(to - from + 1n <= 10_000n);
});

test("judgeNow does nothing for jobs that are not ours, not submitted, or already judged", async () => {
  const done = { jobId: 49n, criteriaHash: "0x" + "11".repeat(32), deliverable: "0x" + "22".repeat(32), score: 100, threshold: 100, pass: true, evidenceHash: "0x" + "33".repeat(32), timestamp: 1786133592n };
  const m = mockChain({ jobs: [
    { id: 47, evaluator: "0x000000000000000000000000000000000000dEaD" },
    { id: 48, status: "Funded", submitted: false },
    { id: 49, status: "Completed", verdict: done },
  ] });
  assert.equal((await judgeNow({ jobId: "47" }, { clients: m.clients })).body.result, "not-ours");
  assert.equal(m.calls.getLogs.length, 0, "a job that is not ours must not trigger any chain search");
  assert.equal((await judgeNow({ jobId: "48" }, { clients: m.clients })).body.result, "not-submitted");
  const again = await judgeNow({ jobId: "49" }, { clients: m.clients });
  assert.equal(again.body.result, "already-judged");
  assert.equal(again.body.verdict.pass, true);
  assert.equal(m.calls.writeContract.length, 0);
});

test("judgeNow reports an abstention (with its reason) instead of guessing", async () => {
  const bad = { version: 1, passThreshold: 0, checks: [] }; // the service never scores this
  const m = mockChain({ jobs: [{ id: 50, description: describe(bad) }] });
  const r = await judgeNow({ jobId: "50" }, { clients: m.clients });
  assert.equal(r.status, 422);
  assert.equal(r.body.result, "abstained");
  assert.match(r.body.reason, /invalid criteria/);
  assert.equal(m.calls.writeContract.length, 0);
});

test("two callers racing: the loser reports the winner's verdict, not an error", async () => {
  const m = mockChain({ jobs: [{ id: 51 }], relay: "revert-then-judged" });
  const r = await judgeNow({ jobId: "51" }, { clients: m.clients });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "already-judged");
});

test("a relay failure with no verdict on-chain is a 502, not a false success", async () => {
  const m = mockChain({ jobs: [{ id: 52 }], relay: "revert" });
  const r = await judgeNow({ jobId: "52" }, { clients: m.clients });
  assert.equal(r.status, 502);
  assert.notEqual(r.body.result, "judged");
});

test("a failing deliverable is judged REJECT, and that is still a ruling", async () => {
  const m = mockChain({ jobs: [{ id: 53, content: "Too short." }] });
  const r = await judgeNow({ jobId: "53" }, { clients: m.clients });
  assert.equal(r.body.result, "judged");
  assert.equal(r.body.pass, false);
});

/* ------------------------------- sweepRecent ------------------------------ */

test("the sweep judges every pending job in the lookback window, in bounded chunks", async () => {
  const latest = 64_000_000n;
  const m = mockChain({ latest, jobs: [
    { id: 60, block: latest - 100n }, { id: 61, block: latest - 150_000n },
    { id: 62, block: latest - 400_000n }, // outside a 180k lookback
    { id: 63, evaluator: "0x000000000000000000000000000000000000dEaD", block: latest - 10n },
  ] });
  const s = await sweepRecent({ clients: m.clients }, { lookbackBlocks: 180_000n });
  assert.equal(s.judged, 2);
  assert.deepEqual(s.outcomes.filter((o) => o.outcome === "judged").map((o) => o.jobId).sort(), ["60", "61"]);
  for (const [from, to] of m.calls.getLogs) assert.ok(to - from + 1n <= 10_000n);
  const again = await sweepRecent({ clients: m.clients }, { lookbackBlocks: 180_000n });
  assert.equal(again.judged, 0, "a second sweep must not rule twice");
});

/* ------------------ mined reverts and repeated requests --------------------- */

test("a verdict tx that is mined but reverts is never reported as judged", async () => {
  const m = mockChain({ jobs: [{ id: 90 }], relay: "mined-revert" });
  const r = await judgeNow({ jobId: "90" }, { clients: m.clients });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.notEqual(r.body.result, "judged");
});

test("if another caller's verdict landed first, a mined revert reports that verdict", async () => {
  const m = mockChain({ jobs: [{ id: 91 }], relay: "mined-revert-then-judged" });
  const r = await judgeNow({ jobId: "91" }, { clients: m.clients });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "already-judged");
});

test("repeat requests for a job that cannot be judged are answered from a short cache", async () => {
  const bad = { version: 1, passThreshold: 0, checks: [] };
  const m = mockChain({ jobs: [{ id: 92, description: describe(bad) }] });
  const first = await judgeNow({ jobId: "92" }, { clients: m.clients });
  const before = m.calls.getLogs.length;
  const second = await judgeNow({ jobId: "92" }, { clients: m.clients });
  assert.equal(first.status, 422);
  assert.equal(second.status, 422);
  assert.equal(second.body.cached, true);
  assert.equal(m.calls.getLogs.length, before, "a cached answer does no chain search");
});

test("fetch failures never echo internal network details back to the caller", async () => {
  const m = mockChain({ jobs: [{ id: 93, uri: "http://10.1.2.3/secret" }] });
  const r = await judgeNow({ jobId: "93" }, { clients: m.clients });
  assert.doesNotMatch(JSON.stringify(r.body), /10\.1\.2\.3|blocked address/);
});

/* ------------------------ transient vs permanent -------------------------- */
// A reserved .invalid host never resolves, so this fails fast and offline too.
const DOWN = "https://deliverable-host.invalid/report.txt";

test("a deliverable host that cannot be reached is retryable, not a permanent abstention", async () => {
  const m = mockChain({ jobs: [{ id: 70, uri: DOWN }] });
  const o = await evaluateJob(70n, deliverableOf(m, 70), m.clients, txOf(m, 70));
  assert.equal(o.outcome, "retry", JSON.stringify(o));
  const r = await judgeNow({ jobId: "70" }, { clients: m.clients });
  assert.equal(r.status, 503);
  assert.equal(r.body.result, "retry-later");
  assert.equal(m.calls.writeContract.length, 0);
});

test("the sweep retries a transient failure on its next pass instead of forgetting the job", async () => {
  const m = mockChain({ jobs: [{ id: 71, uri: DOWN }] });
  const first = await sweepRecent({ clients: m.clients }, { lookbackBlocks: 5_000n });
  const second = await sweepRecent({ clients: m.clients }, { lookbackBlocks: 5_000n });
  for (const s of [first, second]) {
    assert.deepEqual(s.outcomes.map((o) => [o.jobId, o.outcome]), [["71", "retry"]]);
  }
});

test("permanent problems are still abstentions (422), with the reason", async () => {
  const m = mockChain({ jobs: [{ id: 72, uri: "ftp://example.com/deliverable.txt" }] });
  const r = await judgeNow({ jobId: "72" }, { clients: m.clients });
  assert.equal(r.status, 422);
  assert.match(r.body.reason, /unsupported/);
});

/* ------------------------------ coverage & status -------------------------- */

test("the daily sweep looks back far enough to survive one skipped or late cron run", async () => {
  const { SWEEP_LOOKBACK_BLOCKS } = await import("../src/judge-now.js");
  const twoDays = BigInt(Math.ceil((2 * 24 * 3600) / 0.52));
  assert.ok(SWEEP_LOOKBACK_BLOCKS >= twoDays, `lookback ${SWEEP_LOOKBACK_BLOCKS} < ${twoDays}`);
  const src = fs.readFileSync(new URL("../api/cron/sweep.js", import.meta.url), "utf8");
  assert.match(src, /SWEEP_LOOKBACK_BLOCKS/, "the cron handler must use the shared constant");
});

test("read-only status names every state honestly", async () => {
  const { jobStatus } = await import("../src/judge-now.js");
  const m = mockChain({ jobs: [
    { id: 80, status: "Open", submitted: false }, { id: 81, status: "Funded", submitted: false },
    { id: 82, status: "Expired", submitted: false }, { id: 83 },
    { id: 84, evaluator: "0x000000000000000000000000000000000000dEaD" },
  ] });
  const st = async (id) => (await jobStatus({ jobId: String(id) }, { clients: m.clients })).body;
  assert.equal((await st(80)).result, "not-submitted");
  assert.equal((await st(81)).result, "not-submitted");
  assert.equal((await st(82)).result, "expired");
  assert.equal((await st(83)).result, "pending");
  const other = await st(84);
  assert.equal(other.result, "not-ours");
  assert.match(other.evaluator, /^0x000000000000000000000000000000000000dEaD$/i);
});

test("a submission outside the search window says how to find it, not 'ask again shortly'", async () => {
  const m = mockChain({ latest: 64_000_000n, jobs: [{ id: 85, block: 1_000n }] });
  const r = await judgeNow({ jobId: "85" }, { clients: m.clients });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /submitTx/);
  assert.match(r.body.error, /hours/);
  assert.match(r.body.error, /daily sweep/);
  assert.doesNotMatch(r.body.error, /shortly/);
});

void CRITERIA; void TEXT;

test("reading a job's status needs no signer key: a deployment without keys still answers GET", async () => {
  const m = mockChain({ jobs: [{ id: 95 }] });
  const deps = {
    makeClients: () => { throw new Error("JUDGE_SIGNER_KEY is not set"); },
    makePublicClient: () => m.clients.publicClient,
  };
  const r = await jobStatus({ jobId: "95" }, deps);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "pending");
  assert.equal(m.calls.writeContract.length, 0);
});
