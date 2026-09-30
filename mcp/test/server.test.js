// The MCP server, used the way an agent uses it: an MCP client over an in-memory transport.
// Every tool reuses code that is tested against the judge elsewhere (web/builder.js, web/app.js),
// so this suite holds the wiring: the right answers come back, bad input is refused in words,
// networks and job ids are closed sets, calls on different networks never share settings, and
// the tool descriptions claim nothing the tools do not do.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createJudgeServer } from "../src/judge-mcp.js";
import { fakeChain } from "../../web/test/helpers/fake-chain.mjs";

const JOB18_HASH = "0xd761b8357e12d75984f1502b113ccd4c3b0fa12302b2d0d89fe5d7b21f3a120b";
const JOB18 = {
  count: { min: 10, max: 10 },
  uniqueBy: { field: "website", key: "domain" },
  fields: [
    { name: "name", type: "text" },
    { name: "website", type: "url" },
    { name: "network", type: "one-of", options: ["Arc", "Base"] },
    { name: "paid_work_evidence", type: "url" },
    { name: "contact", type: "email-or-url" },
  ],
};
const lead = (i) => ({ name: `Team ${i}`, website: `https://team${i}.example.com`, network: "Arc", paid_work_evidence: `https://team${i}.example.com/w`, contact: `hi@team${i}.example.com` });
const LEADS = Array.from({ length: 10 }, (_, i) => lead(i));

async function connect(opts = {}) {
  const server = createJudgeServer(opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}
const call = (client, name, args) => client.callTool({ name, arguments: args });
const body = (res) => JSON.parse(res.content[0].text);
/** A refusal: either the SDK rejects the arguments, or the tool answers with isError and a message.
 *  Only the call may throw here; the isError assertion stays outside the catch, or it would be swallowed. */
async function refused(client, name, args, pattern) {
  let res, threw = null;
  try {
    res = await call(client, name, args);
  } catch (e) {
    threw = e;
  }
  if (!threw) assert.equal(res.isError, true, `${name} ${JSON.stringify(args).slice(0, 80)} should be refused`);
  const text = threw ? threw.message : res.content[0].text;
  if (pattern) assert.match(text, pattern);
}

const TOOLS = ["judge_build_checklist", "judge_check_delivery", "judge_job_status", "judge_verify_ruling", "judge_request_ruling"];

test("it offers exactly the five tools and the criteria reference, described without overclaiming", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
  for (const t of tools) {
    const words = `${t.title ?? ""} ${t.description ?? ""} ${JSON.stringify(t.inputSchema)}`;
    assert.ok((t.description ?? "").length > 40, t.name);
    assert.doesNotMatch(words, /[\u2014\u2013]/, `${t.name}: no em or en dashes`);
    assert.doesNotMatch(words, /same checks/i, `${t.name}: say "a copy of the judge's checks", never "the same checks"`);
    assert.equal(t.inputSchema.type, "object", t.name);
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.judge_request_ruling.annotations.readOnlyHint, false);
  for (const n of TOOLS.filter((x) => x !== "judge_request_ruling")) assert.equal(byName[n].annotations.readOnlyHint, true, n);
  assert.match(byName.judge_request_ruling.description, /settles/);
  assert.match(byName.judge_check_delivery.description, /copy of the judge's checks/);
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri), ["judge://docs/criteria"]);
  const doc = await client.readResource({ uri: "judge://docs/criteria" });
  assert.match(doc.contents[0].text, /^# Acceptance criteria reference/);
});

test("build: job 18's answers give the checklist on Arc mainnet, with its hash and plain words", async () => {
  const client = await connect();
  const out = body(await call(client, "judge_build_checklist", { template: "records", answers: JOB18, summary: "Ten poster leads." }));
  assert.equal(out.criteriaHash, JOB18_HASH);
  assert.ok(out.jobDescription.startsWith("Ten poster leads.\n```judge-criteria\n"));
  assert.equal(out.plainWords[0], "A JSON list of exactly 10 entries.");
  assert.equal(out.criteria.passThreshold, 100);
});

test("build: answers the judge would refuse come back as a plain message, and unknown fields are refused", async () => {
  const client = await connect();
  await refused(client, "judge_build_checklist", { template: "records", answers: { fields: [{ name: "n", type: "one-of", options: [] }] } }, /at least one option/);
  await refused(client, "judge_build_checklist", { template: "text", answers: {} }, /word range or at least one required term/);
  await refused(client, "judge_build_checklist", { template: "text", answers: { minWords: 5, minwords: 5 } });
  await refused(client, "judge_build_checklist", { template: "essay", answers: {} });
});

test("check: the dry run answers pass and fail like the judge, from criteria or from a job description", async () => {
  const client = await connect();
  const built = body(await call(client, "judge_build_checklist", { template: "records", answers: JOB18 }));
  const pass = body(await call(client, "judge_check_delivery", { criteria: built.criteria, deliverable: JSON.stringify(LEADS) }));
  assert.deepEqual({ final: pass.final, pass: pass.pass, score: pass.score }, { final: true, pass: true, score: 100 });
  const fail = body(await call(client, "judge_check_delivery", { jobDescription: built.jobDescription, deliverable: JSON.stringify(LEADS.slice(0, 9)) }));
  assert.deepEqual({ final: fail.final, pass: fail.pass, score: fail.score }, { final: true, pass: false, score: 0 });
  assert.match(fail.results[0].detail, /9 items/);
  assert.equal(fail.results[0].check, "A JSON list of exactly 10 entries. " + fail.results[0].check.slice("A JSON list of exactly 10 entries. ".length));
  const b64 = body(await call(client, "judge_check_delivery", { criteria: built.criteria, deliverableBase64: Buffer.from(JSON.stringify(LEADS)).toString("base64") }));
  assert.equal(b64.pass, true);
});

test("check: what the judge refuses is never scored, and a live web check is never final", async () => {
  const client = await connect();
  const text = body(await call(client, "judge_build_checklist", { template: "text", answers: { minWords: 1 } }));
  const big = body(await call(client, "judge_check_delivery", { criteria: text.criteria, deliverable: "a".repeat(1_000_001) }));
  assert.deepEqual({ final: big.final, tooLarge: big.tooLarge, pass: big.pass }, { final: false, tooLarge: true, pass: null });
  const bigB64 = body(await call(client, "judge_check_delivery", { criteria: text.criteria, deliverableBase64: Buffer.alloc(1_000_001, 97).toString("base64") }));
  assert.equal(bigB64.tooLarge, true);
  const probe = body(await call(client, "judge_build_checklist", { template: "endpoint", answers: { url: "https://example.com/health" } }));
  const live = body(await call(client, "judge_check_delivery", { criteria: probe.criteria, deliverable: "x" }));
  assert.equal(live.final, false);
  assert.equal(live.results[0].notRun, true);
  await refused(client, "judge_check_delivery", { criteria: { checks: [{ kind: "code-test" }] }, deliverable: "x" }, /unknown kind/);
  await refused(client, "judge_check_delivery", { jobDescription: "no block here", deliverable: "x" }, /judge-criteria/);
  await refused(client, "judge_check_delivery", { criteria: text.criteria }, /exactly one of deliverable or deliverableBase64/);
  await refused(client, "judge_check_delivery", { criteria: text.criteria, deliverable: "x", deliverableBase64: "eA==" }, /exactly one of deliverable or deliverableBase64/);
  await refused(client, "judge_check_delivery", { criteria: text.criteria, jobDescription: text.jobDescription, deliverable: "x" }, /exactly one of criteria or jobDescription/);
  await refused(client, "judge_check_delivery", { criteria: text.criteria, deliverableBase64: "not base64!" }, /base64/);
});

// The chain tools read Arc through the global fetch, like the verifier; here a fake chain built from
// recorded Arc testnet data answers instead, so these tests never touch the network.
function withFakeChain(fn) {
  return async () => {
    const real = globalThis.fetch;
    globalThis.fetch = fakeChain().fetch;
    try { await fn(); } finally { globalThis.fetch = real; }
  };
}

test("verify: a real PASS and a real REJECT ruling on Arc testnet both come back verified", withFakeChain(async () => {
  const client = await connect();
  const pass = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "171925" }));
  assert.equal(pass.outcome, "verified", JSON.stringify(pass.checks));
  assert.equal(pass.verdict.pass, true);
  assert.ok(pass.checks.length >= 9);
  const reject = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "170856" }));
  assert.equal(reject.outcome, "verified");
  assert.equal(reject.verdict.pass, false);
}));

test("verify: networks never share settings, even when calls overlap", withFakeChain(async () => {
  const client = await connect();
  const [testnet, mainnet] = await Promise.all([
    call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "171925" }),
    call(client, "judge_verify_ruling", { network: "arc-mainnet", jobId: "171925" }),
  ]);
  const t = body(testnet), m = body(mainnet);
  assert.equal(t.outcome, "verified");
  assert.equal(t.judge, "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD");
  assert.equal(m.judge, "0xC9de51A6b440D834D05e22d0D500F41Df1B56321");
  assert.notEqual(m.outcome, "verified", "the recorded testnet job names the testnet judge, never the mainnet one");
}));

test("status: read from chain, with whether this judge is the job's evaluator and its verdict", withFakeChain(async () => {
  const client = await connect();
  const s = body(await call(client, "judge_job_status", { network: "arc-testnet", jobId: "171925" }));
  assert.equal(s.found, true);
  assert.equal(s.status, "Completed");
  assert.equal(s.judgeIsEvaluator, true);
  assert.equal(s.verdict.pass, true);
  const none = body(await call(client, "judge_job_status", { network: "arc-testnet", jobId: "999999999" }));
  assert.equal(none.found, false);
}));

test("chain tools refuse unknown networks and anything that is not a job id", withFakeChain(async () => {
  const client = await connect();
  for (const name of ["judge_job_status", "judge_verify_ruling"]) {
    await refused(client, name, { network: "base", jobId: "1" });
    await refused(client, name, { network: "arc-testnet", jobId: "12abc" });
    await refused(client, name, { network: "arc-testnet", jobId: "0" }, /positive whole number/);
    await refused(client, name, { network: "arc-testnet", jobId: "1", rpc: "https://evil.example" });
  }
}));

function fakeApi(status, payload) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { seen, fetchImpl };
}

test("request: asks the hosted judge on Arc testnet and returns its answer as it is", async () => {
  const api = fakeApi(200, { result: "judged", pass: true, score: 100, txHash: "0xabc" });
  const client = await connect({ fetchImpl: api.fetchImpl });
  const out = body(await call(client, "judge_request_ruling", { jobId: "186819" }));
  assert.deepEqual(out, { network: "arc-testnet", httpStatus: 200, result: "judged", pass: true, score: 100, txHash: "0xabc" });
  assert.equal(api.seen[0].url, "https://judge-protocol-api.vercel.app/api/judge");
  assert.deepEqual(JSON.parse(api.seen[0].init.body), { jobId: "186819" });
  const withTx = fakeApi(200, { result: "already-judged" });
  const c2 = await connect({ fetchImpl: withTx.fetchImpl });
  await call(c2, "judge_request_ruling", { jobId: "5", submitTx: "0x" + "ab".repeat(32) });
  assert.deepEqual(JSON.parse(withTx.seen[0].init.body), { jobId: "5", submitTx: "0x" + "ab".repeat(32) });
});

test("request: an abstention and a busy judge are answers, not failures", async () => {
  const abstain = await connect({ fetchImpl: fakeApi(422, { result: "abstained", reason: "invalid criteria" }).fetchImpl });
  assert.deepEqual(body(await call(abstain, "judge_request_ruling", { jobId: "7" })), { network: "arc-testnet", httpStatus: 422, result: "abstained", reason: "invalid criteria" });
  const busy = await connect({ fetchImpl: fakeApi(503, { result: "retry-later" }).fetchImpl });
  assert.equal(body(await call(busy, "judge_request_ruling", { jobId: "7" })).result, "retry-later");
});

test("request: only Arc testnet, only a job id, only a 32-byte transaction hash", async () => {
  const api = fakeApi(200, {});
  const client = await connect({ fetchImpl: api.fetchImpl });
  await refused(client, "judge_request_ruling", { network: "arc-mainnet", jobId: "16" });
  await refused(client, "judge_request_ruling", { jobId: "abc" });
  await refused(client, "judge_request_ruling", { jobId: "5", submitTx: "0x1234" });
  const down = await connect({ fetchImpl: async () => { throw new Error("offline"); } });
  await refused(down, "judge_request_ruling", { jobId: "5" }, /could not reach the hosted judge/);
  assert.equal(api.seen.length, 0, "a refused request never reaches the judge");
});
