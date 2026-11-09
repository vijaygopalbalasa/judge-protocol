// Contracts for spec api-errors, Requirement 2 (.kiro/specs/api-errors/requirements.md).
// Real HTTP on an ephemeral port, temp evidence folders, no real RPC or key.
// Run: node --test contracts/api-errors/*.contract.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JUDGE_ADDRESS = "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD";

const { createJudgeApi } = await import("../../src/http.js");

// Evidence routes never read the chain; fail loudly if one ever does.
const noChain = {
  readContract: async () => {
    throw new Error("contract must not reach the chain");
  },
};

async function withApi(deps, fn) {
  const server = createJudgeApi({ publicClient: noChain, ...deps });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function tempEvidenceDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-errors-evidence-"));
  const now = Date.now() / 1000;
  for (const [name, { body, ageSeconds }] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(body));
    const t = now - ageSeconds;
    fs.utimesSync(file, t, t);
  }
  return dir;
}

test("R2.1 only job-<id>-<hex>.json files count; other job-<id>-* files are ignored even when newer", async () => {
  const dir = tempEvidenceDir({
    // the real evidence file is the OLDEST, so a loose prefix match would pick a sibling instead
    "job-42-abcd1234.json": { body: { kind: "evidence", jobId: "42" }, ageSeconds: 300 },
    "job-42-arbitration.json": { body: { kind: "arbitration", jobId: "42" }, ageSeconds: 10 },
    "job-42-notes.json": { body: { kind: "notes" }, ageSeconds: 20 },
    "job-42-deadbeef.json.bak": { body: { kind: "backup" }, ageSeconds: 5 },
    "job-42-deadbeef.txt": { body: { kind: "text" }, ageSeconds: 5 },
  });
  await withApi({ evidenceDir: dir }, async (base) => {
    const r = await fetch(`${base}/evidence/42`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-evidence-file"), "job-42-abcd1234.json");
    assert.deepEqual(await r.json(), { kind: "evidence", jobId: "42" });
  });
});

test("R2.2 a job with only non-matching files answers 404 like a job with no evidence", async () => {
  const dir = tempEvidenceDir({
    "job-42-arbitration.json": { body: { kind: "arbitration", jobId: "42" }, ageSeconds: 10 },
    "job-42-deadbeef.json.bak": { body: { kind: "backup" }, ageSeconds: 5 },
  });
  await withApi({ evidenceDir: dir }, async (base) => {
    const sibling = await fetch(`${base}/evidence/42`);
    const none = await fetch(`${base}/evidence/999`);
    assert.equal(none.status, 404);
    assert.equal(sibling.status, 404);
    assert.equal(sibling.headers.get("x-evidence-file"), null);
    // same shape as the no-evidence 404: a JSON error naming the job
    const body = await sibling.json();
    assert.equal(typeof body.error, "string");
    assert.match(body.error, /42/);
  });
});
