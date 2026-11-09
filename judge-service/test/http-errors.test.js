// Unit tests for spec api-errors (.kiro/specs/api-errors). Real HTTP on an
// ephemeral port, stubbed chain client, no real RPC or key.
import test from "node:test";
import assert from "node:assert/strict";

process.env.JUDGE_ADDRESS = "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD";

const { createJudgeApi } = await import("../src/http.js");

async function withApi(deps, fn) {
  const server = createJudgeApi(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Capture console.error calls (stderr) while fn runs.
async function captureErrors(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map((a) => (a instanceof Error ? `${a.stack ?? a.message}` : String(a))).join(" "));
  try {
    const result = await fn();
    return { result, logged: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

const SECRET = "https://rpc.example.test/v2/SECRET-KEY-123";

// ---- Task 1: fixed 500 body, full error logged ----

test("task 1: unexpected error answers 500 {error:'internal error'} without the error text", async () => {
  const getState = () => { throw new Error(`boom ${SECRET}`); };
  await withApi({ getState }, async (base) => {
    const { result, logged } = await captureErrors(async () => {
      const r = await fetch(`${base}/healthz`);
      return { status: r.status, text: await r.text() };
    });
    assert.equal(result.status, 500);
    assert.deepEqual(JSON.parse(result.text), { error: "internal error" });
    assert.equal(result.text.includes("SECRET-KEY-123"), false);
    assert.equal(result.text.includes("boom"), false);
    assert.ok(logged.includes(`boom ${SECRET}`), "full error must be logged");
    assert.ok(logged.includes("/healthz"), "log line names the path");
    assert.ok(logged.includes("GET"), "log line names the method");
  });
});

test("task 1: deliberate 400/413/422 keep status and message and are not logged as failures", async () => {
  await withApi({}, async (base) => {
    const post = (body) =>
      fetch(`${base}/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const { result, logged } = await captureErrors(async () => {
      const out = [];
      let r = await post(JSON.stringify({ criteria: { checks: [] }, deliverable: "x" }));
      out.push([r.status, await r.json()]);
      r = await post(Buffer.alloc(1_200_000, "a"));
      out.push([r.status, await r.json()]);
      r = await post("{not json");
      out.push([r.status, await r.json()]);
      r = await fetch(`${base}/verdict/abc`);
      out.push([r.status, await r.json()]);
      return out;
    });
    assert.equal(result[0][0], 422);
    assert.match(result[0][1].error, /^invalid criteria: .+/);
    assert.deepEqual(result[1], [413, { error: "body too large" }]);
    assert.deepEqual(result[2], [400, { error: "body must be JSON" }]);
    assert.deepEqual(result[3], [400, { error: "jobId must be a positive integer" }]);
    assert.equal(logged, "", "deliberate errors are not logged");
  });
});

// ---- Task 2: failing chain read on /verdict is a 502 with a fixed body ----

const failingChain = {
  readContract: async () => {
    throw new Error(`HTTP request failed.\n\nURL: ${SECRET}\nRequest body: {"method":"eth_call"}`);
  },
};

test("task 2: failing chain read answers 502 {error:'upstream chain read failed'} with no upstream detail", async () => {
  await withApi({ publicClient: failingChain }, async (base) => {
    const { result, logged } = await captureErrors(async () => {
      const r = await fetch(`${base}/verdict/7`);
      return { status: r.status, text: await r.text() };
    });
    assert.equal(result.status, 502);
    assert.deepEqual(JSON.parse(result.text), { error: "upstream chain read failed" });
    assert.equal(result.text.includes("SECRET-KEY-123"), false);
    assert.equal(result.text.includes("rpc.example.test"), false);
    assert.equal(result.text.includes("eth_call"), false);
    assert.ok(logged.includes(SECRET), "full upstream error must be logged");
    assert.ok(logged.includes("/verdict/7"), "log line names the path");
  });
});

test("task 2: only the read is wrapped; a failure shaping the response is still a 500", async () => {
  // timestamp is a BigInt-incompatible mix: Number(Symbol()) throws after the read succeeded.
  const badShape = { readContract: async () => ({ timestamp: 5, score: Symbol("x") }) };
  await withApi({ publicClient: badShape }, async (base) => {
    const { result } = await captureErrors(async () => {
      const r = await fetch(`${base}/verdict/7`);
      return { status: r.status, body: await r.json() };
    });
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: "internal error" });
  });
});

test("task 2: a successful read and a 404 for an unrecorded verdict are unchanged", async () => {
  const ZERO32 = `0x${"0".repeat(64)}`;
  const stub = (timestamp) => ({
    readContract: async () => ({
      jobId: 7n, criteriaHash: ZERO32, deliverable: ZERO32,
      score: 80, threshold: 75, pass: true, evidenceHash: ZERO32, timestamp,
    }),
  });
  await withApi({ publicClient: stub(0) }, async (base) => {
    assert.equal((await fetch(`${base}/verdict/7`)).status, 404);
  });
  await withApi({ publicClient: stub(1754600000) }, async (base) => {
    const r = await fetch(`${base}/verdict/7`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).score, 80);
  });
});

// ---- Task 3: /evidence/:jobId matches only job-<id>-<hex>.json ----

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function evidenceDirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "http-errors-evidence-"));
  const now = Date.now() / 1000;
  for (const [name, ageSeconds] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ file: name }));
    fs.utimesSync(file, now - ageSeconds, now - ageSeconds);
  }
  return dir;
}

test("task 3: sibling job-<id>-* files are ignored even when newer than the real evidence", async () => {
  const dir = evidenceDirWith({
    "job-42-abcd1234.json": 300,
    "job-42-arbitration.json": 10,
    "job-42-deadbeef.json.bak": 5,
    "job-42-deadbeef.txt": 5,
    "job-42-.json": 5,
  });
  await withApi({ evidenceDir: dir }, async (base) => {
    const r = await fetch(`${base}/evidence/42`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-evidence-file"), "job-42-abcd1234.json");
    assert.deepEqual(await r.json(), { file: "job-42-abcd1234.json" });
  });
});

test("task 3: only non-matching files answers the same 404 as no evidence", async () => {
  const dir = evidenceDirWith({ "job-42-arbitration.json": 10, "job-42-deadbeef.json.bak": 5 });
  await withApi({ evidenceDir: dir }, async (base) => {
    const sibling = await fetch(`${base}/evidence/42`);
    const none = await fetch(`${base}/evidence/999`);
    assert.equal(sibling.status, 404);
    assert.equal(none.status, 404);
    assert.equal(sibling.headers.get("x-evidence-file"), null);
    assert.deepEqual(await sibling.json(), { error: "no evidence stored for job 42" });
  });
});

test("task 3: hex match is case-insensitive, the newest matching file wins, and ids do not collide by prefix", async () => {
  const dir = evidenceDirWith({
    "job-42-ABCDEF01.json": 100,
    "job-42-0123abcd.json": 50,
    "job-420-ffffffff.json": 1, // a different job whose id starts with 42
    "job-4-abcd1234.json": 1,
  });
  await withApi({ evidenceDir: dir }, async (base) => {
    const r = await fetch(`${base}/evidence/42`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-evidence-file"), "job-42-0123abcd.json");
    const r420 = await fetch(`${base}/evidence/420`);
    assert.equal(r420.headers.get("x-evidence-file"), "job-420-ffffffff.json");
  });
});
