// ERC-8412 end to end on the mock chain: the client preregisters the job's
// criteria document with exactly the arguments GET /api/erc8412 gives it, the
// provider submits, the judge rules and attests through JudgeAttestor (the
// mock checks the judge's EIP-712 signature), and the package rebuilt from
// chain data alone verifies on every rule, under the reference verifier too.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.EVIDENCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "judge-evidence-"));
const { mockChain, CLIENT, blockTime, describe } = await import("./helpers/mock-chain.js");
const { judgeNow, findSubmission } = await import("../src/judge-now.js");
const { erc8412Status } = await import("../src/erc8412-status.js");
const { createErc8412Handler } = await import("../api/erc8412.js");
const { config } = await import("../src/config.js");

const ZERO32 = "0x" + "0".repeat(64);
const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "erc8412");
const python = spawnSync("python3", ["--version"]).status === 0;
const expiredAt = () => BigInt(Math.floor(Date.now() / 1000) + 3600);
const status = (m, input) => erc8412Status(input, { publicClient: m.clients.publicClient, findSubmission });

test("preregister with the API's arguments, rule, attest, rebuild from chain: the package verifies", async () => {
  const preregistrations = {};
  const m = mockChain({ jobs: [{ id: 61, expiredAt: expiredAt() }, { id: 62, expiredAt: expiredAt(), content: "Short and wrong." }], preregistrations });
  for (const [id, verdict] of [[61, "Satisfied"], [62, "NotSatisfied"]]) {
    const before = await status(m, { jobId: String(id) });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.status, "not-preregistered");
    const a = before.body.preregister;
    assert.equal(a.verifier, config.erc8412Attestor);
    // The client sends registry.preregister(...) with exactly these arguments, before the provider submits.
    preregistrations[before.body.preregistrationId] = [CLIENT, a.criteriaDigest, a.taskRef, a.obligationCount, a.obligationFlags,
      BigInt(a.expiry), blockTime(m.latest - 60n), a.verifier, a.supersedes, ZERO32];
    assert.equal((await status(m, { jobId: String(id) })).body.status, "preregistered");

    const ruled = await judgeNow({ jobId: String(id) }, { clients: m.clients });
    assert.equal(ruled.body.result, "judged");
    assert.equal(ruled.body.erc8412.status, "attested", JSON.stringify(ruled.body.erc8412));
    assert.ok(!("documents" in ruled.body.erc8412), "the response stays small; the documents are served by GET /api/erc8412");
    assert.ok(m.attestations.has(before.body.preregistrationId), "recorded through JudgeAttestor with the judge's signature");

    const after = await status(m, { jobId: String(id) });
    assert.equal(after.body.status, "attested");
    assert.deepEqual([after.body.check.violations, after.body.check.unchecked], [[], []], JSON.stringify(after.body.check));
    assert.equal(after.body.package.chain.attestation.verdict, verdict);
    if (python) {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "erc8412-")), "p.json");
      fs.writeFileSync(f, JSON.stringify({ name: `roundtrip-${id}`, ...after.body.package }));
      const out = spawnSync("python3", [path.join(FX, "reference", "verifier", "verify.py"), f], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
      assert.equal(JSON.parse(out.stdout).valid, true, `${out.stdout}${out.stderr}`);
    }
  }
});

test("a preregistration made after the provider submitted is never attested", async () => {
  const preregistrations = {};
  const m = mockChain({ jobs: [{ id: 63, expiredAt: expiredAt() }], preregistrations });
  const before = await status(m, { jobId: "63" });
  const a = before.body.preregister;
  preregistrations[before.body.preregistrationId] = [CLIENT, a.criteriaDigest, a.taskRef, a.obligationCount, a.obligationFlags,
    BigInt(a.expiry), blockTime(m.latest - 10n), a.verifier, a.supersedes, ZERO32]; // the submit was at latest - 50
  const ruled = await judgeNow({ jobId: "63" }, { clients: m.clients });
  assert.equal(ruled.body.result, "judged", "the ruling itself is unaffected");
  assert.equal(ruled.body.erc8412.status, "evidence-predates-criteria");
  assert.equal(m.attestations.size, 0);
});

test("the endpoint refuses what it cannot describe, and says why", async () => {
  const m = mockChain({ jobs: [
    { id: 64, expiredAt: expiredAt(), evaluator: "0x000000000000000000000000000000000000dEaD" },
    { id: 65, expiredAt: expiredAt(), description: "no criteria here" },
    { id: 66, expiredAt: expiredAt(), description: describe({ version: 1, checks: [{ kind: "length", params: { min: 1 }, weight: 0.5 }] }) },
  ] });
  assert.equal((await status(m, { jobId: "abc" })).status, 400);
  assert.equal((await status(m, { jobId: "61", submitTx: "0x12" })).status, 400);
  assert.equal((await status(m, { jobId: "999" })).status, 404);
  assert.equal((await status(m, { jobId: "64" })).body.result, "not-ours");
  assert.equal((await status(m, { jobId: "65" })).status, 422);
  const frac = await status(m, { jobId: "66" });
  assert.equal(frac.status, 422);
  assert.match(frac.body.error, /integer/);
});

test("GET /api/erc8412 answers GET only, and a chain outage is a 503, never a crash", async () => {
  const m = mockChain({ jobs: [{ id: 67, expiredAt: expiredAt() }] });
  const call = async (handler, method, query) => {
    const res = { code: 0, payload: undefined, headersSent: false, headers: {} };
    res.status = (c) => { res.code = c; return res; };
    res.json = (o) => { res.payload = o; res.headersSent = true; return res; };
    res.end = () => { res.headersSent = true; return res; };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
    await handler({ method, query, headers: {} }, res);
    return res;
  };
  const h = createErc8412Handler({ publicClient: m.clients.publicClient, findSubmission });
  const ok = await call(h, "GET", { jobId: "67" });
  assert.equal(ok.code, 200);
  assert.equal(ok.payload.status, "not-preregistered");
  assert.equal((await call(h, "POST", {})).code, 405);
  const down = createErc8412Handler({ publicClient: { readContract: async () => { throw new Error("HTTP 429"); } }, findSubmission });
  const r = await call(down, "GET", { jobId: "67" });
  assert.equal(r.code, 503);
  assert.equal(r.payload.result, "retry-later");
});
