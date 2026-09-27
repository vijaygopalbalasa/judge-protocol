import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// /verdict requires a configured judge address; set BEFORE importing http.js
// (config.js reads env at import time).
process.env.JUDGE_ADDRESS = "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD";

const { createJudgeApi } = await import("../src/http.js");
const { evidenceHashOf } = await import("../src/evidence.js");
const { criteriaHash } = await import("../src/criteria.js");
const { keccak256 } = await import("viem");

const ZERO32 = `0x${"0".repeat(64)}`;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function withApi(deps, fn) {
  const server = createJudgeApi(deps);
  const base = await listen(server);
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

function evidenceFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-"));
  fs.writeFileSync(path.join(dir, "job-42-abcd1234.json"), JSON.stringify({ jobId: "42", pass: true }));
  return dir;
}

const verdictStub = (timestamp, over = {}) => ({
  readContract: async () => ({
    jobId: 7n, criteriaHash: ZERO32, deliverable: ZERO32,
    score: 100, threshold: 100, pass: true, evidenceHash: ZERO32,
    timestamp, ...over,
  }),
});

test("GET /healthz reports ok + chain identity + injected watcher state", async () => {
  await withApi({ getState: () => ({ cursor: 123n, lastError: null }) }, async (base) => {
    const r = await fetch(`${base}/healthz`);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.ok, true);
    assert.ok(b.chainId);
    assert.equal(b.acp.length, 42);
    assert.equal(b.cursor, "123"); // BigInt serialized as string
  });
});

test("GET /verdict/:jobId: 400 on junk, 404 when unrecorded, 200 with fields", async () => {
  await withApi({ publicClient: verdictStub(0) }, async (base) => {
    assert.equal((await fetch(`${base}/verdict/abc`)).status, 400);
    assert.equal((await fetch(`${base}/verdict/7`)).status, 404);
  });
  await withApi({ publicClient: verdictStub(1754600000, { score: 80, threshold: 75 }) }, async (base) => {
    const r = await fetch(`${base}/verdict/7`);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.jobId, "7");
    assert.equal(b.score, 80);
    assert.equal(b.threshold, 75);
    assert.equal(b.pass, true);
    assert.equal(b.timestamp, 1754600000);
  });
});

test("GET /evidence/:jobId serves the stored file; 404 unknown; 400 traversal-shaped ids", async () => {
  const dir = evidenceFixtureDir();
  await withApi({ evidenceDir: dir }, async (base) => {
    const r = await fetch(`${base}/evidence/42`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-evidence-file"), "job-42-abcd1234.json");
    assert.deepEqual(await r.json(), { jobId: "42", pass: true });

    assert.equal((await fetch(`${base}/evidence/999`)).status, 404);
    assert.equal((await fetch(`${base}/evidence/..%2F..%2Fetc`)).status, 400);
  });
});

test("POST /evaluate dry-runs checkers and returns the recomputable evidenceHash", async () => {
  await withApi({}, async (base) => {
    const criteria = {
      version: 1,
      passThreshold: 100,
      checks: [
        { kind: "contains", params: { all: ["alpha", "beta"] } },
        { kind: "length", params: { min: 2, max: 10 } },
      ],
    };
    const deliverable = "alpha and beta words";
    const r = await fetch(`${base}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ criteria, deliverable }),
    });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.dryRun, true);
    assert.equal(b.pass, true);
    assert.equal(b.score, 100);
    assert.equal(b.results.length, 2);

    // The returned evidenceHash must equal an independent local recompute.
    const content = Buffer.from(deliverable, "utf8");
    const expected = evidenceHashOf({
      jobId: "0",
      criteriaHash: criteriaHash(criteria),
      deliverable: keccak256(content),
      criteria,
      results: b.results,
      score: b.score,
      threshold: b.threshold,
      pass: b.pass,
    });
    assert.equal(b.evidenceHash, expected);
  });
});

test("POST /evaluate: 422 invalid criteria, 400 missing fields/bad JSON, 413 oversize", async () => {
  await withApi({}, async (base) => {
    const post = (body, headers = { "content-type": "application/json" }) =>
      fetch(`${base}/evaluate`, { method: "POST", headers, body });

    // empty checks: the DEFECT-2 class must be refused, never scored
    let r = await post(JSON.stringify({ criteria: { checks: [] }, deliverable: "x" }));
    assert.equal(r.status, 422);

    r = await post(JSON.stringify({ deliverable: "x" }));
    assert.equal(r.status, 400);

    r = await post(JSON.stringify({ criteria: { checks: [{ kind: "length", params: {} }] } }));
    assert.equal(r.status, 400); // no deliverable at all

    r = await post("{not json");
    assert.equal(r.status, 400);

    r = await post(Buffer.alloc(1_200_000, "a"));
    assert.equal(r.status, 413);
  });
});
