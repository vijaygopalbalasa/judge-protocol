// The MCP server, used the way an agent uses it: an MCP client over an in-memory transport.
// Every tool reuses code that is tested against the judge elsewhere (web/builder.js, web/app.js),
// so this suite holds the wiring: the right answers come back, every refusal says why, networks
// and job ids are closed sets, each network reads only its own RPC and contracts, and the tool
// descriptions claim nothing the tools do not do.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createJudgeServer, checklistState } from "../src/judge-mcp.js";
import { fakeChain } from "../../web/test/helpers/fake-chain.mjs";
import { synthJob } from "../../web/test/helpers/synth.mjs";

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
const TESTNET = { rpc: "https://rpc.testnet.arc.io", judge: "0x6eff7d4bb514d341abed90bf4c667d0a980173ad", acp: "0x0747eef0706327138c69792bf28cd525089e4583" };
const MAINNET = { rpc: "https://rpc.mainnet.arc.io", judge: "0xc9de51a6b440d834d05e22d0d500f41df1b56321", acp: "0x64ca39fc57315d0d488accac07c37c6e841cd058" };
const INVALID_ARGS = /Input validation error/;

async function connect(opts = {}) {
  const server = createJudgeServer(opts);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}
const call = (client, name, args) => client.callTool({ name, arguments: args });
const body = (res) => {
  assert.notEqual(res.isError, true, res.content[0].text);
  return JSON.parse(res.content[0].text);
};
/** A refusal with the expected message: either the SDK rejects the arguments, or the tool answers with isError.
 *  Only the call may throw here; the isError assertion stays outside the catch, or it would be swallowed. */
async function refused(client, name, args, pattern) {
  assert.ok(pattern instanceof RegExp, "every refusal names the message it expects");
  let res, threw = null;
  try {
    res = await call(client, name, args);
  } catch (e) {
    threw = e;
  }
  if (!threw) assert.equal(res.isError, true, `${name} ${JSON.stringify(args).slice(0, 80)} should be refused`);
  assert.match(threw ? threw.message : res.content[0].text, pattern);
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
    assert.doesNotMatch(words, /before any money moves/i, `${t.name}: escrow is funded before submit, so this would overclaim`);
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
  await refused(client, "judge_build_checklist", { template: "text", answers: { minWords: 5, minwords: 5 } }, INVALID_ARGS);
  await refused(client, "judge_build_checklist", { template: "essay", answers: {} }, INVALID_ARGS);
});

test("check: the dry run answers pass and fail like the judge, from criteria or from a job description", async () => {
  const client = await connect();
  const built = body(await call(client, "judge_build_checklist", { template: "records", answers: JOB18 }));
  const pass = body(await call(client, "judge_check_delivery", { criteria: built.criteria, deliverable: JSON.stringify(LEADS) }));
  assert.deepEqual({ final: pass.final, pass: pass.pass, score: pass.score }, { final: true, pass: true, score: 100 });
  const fail = body(await call(client, "judge_check_delivery", { jobDescription: built.jobDescription, deliverable: JSON.stringify(LEADS.slice(0, 9)) }));
  assert.deepEqual({ final: fail.final, pass: fail.pass, score: fail.score }, { final: true, pass: false, score: 0 });
  assert.match(fail.results[0].detail, /9 items/);
  assert.ok(fail.results[0].check.startsWith("A JSON list of exactly 10 entries. "));
  const b64 = body(await call(client, "judge_check_delivery", { criteria: built.criteria, deliverableBase64: Buffer.from(JSON.stringify(LEADS)).toString("base64") }));
  assert.equal(b64.pass, true);
});

test("check: criteria the judge refuses are refused here too, including a __proto__ member any JSON parser keeps", async () => {
  const client = await connect();
  const proto = JSON.parse('{"__proto__":{"x":1},"version":1,"checks":[{"kind":"length","params":{"min":1}}]}');
  assert.ok(Object.hasOwn(proto, "__proto__"), "JSON.parse makes it an own member, as a client's message would");
  await refused(client, "judge_check_delivery", { criteria: proto, deliverable: "hello" }, /__proto__/);
  await refused(client, "judge_check_delivery", { criteria: [{ kind: "length" }], deliverable: "hello" }, /criteria must be a JSON object/);
  await refused(client, "judge_check_delivery", { criteria: { checks: [{ kind: "code-test" }] }, deliverable: "x" }, /unknown kind/);
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
  await refused(client, "judge_check_delivery", { jobDescription: "no block here", deliverable: "x" }, /judge-criteria/);
  await refused(client, "judge_check_delivery", { criteria: text.criteria }, /exactly one of deliverable or deliverableBase64/);
  await refused(client, "judge_check_delivery", { criteria: text.criteria, deliverable: "x", deliverableBase64: "eA==" }, /exactly one of deliverable or deliverableBase64/);
  await refused(client, "judge_check_delivery", { criteria: text.criteria, jobDescription: text.jobDescription, deliverable: "x" }, /exactly one of criteria or jobDescription/);
  await refused(client, "judge_check_delivery", { criteria: text.criteria, deliverableBase64: "not base64!" }, /base64/);
  await refused(client, "judge_check_delivery", { jobDescription: "x".repeat(65_537), deliverable: "x" }, INVALID_ARGS);
});

test("checklistState: a block the judge would refuse is reported as present but not valid", () => {
  assert.deepEqual(checklistState("no block"), { hasChecklist: false, checklistValid: false });
  assert.deepEqual(checklistState("```judge-criteria\n{}\n```"), { hasChecklist: true, checklistValid: false });
  assert.deepEqual(checklistState('```judge-criteria\n{"__proto__":{},"checks":[{"kind":"length"}]}\n```'), { hasChecklist: true, checklistValid: false });
  assert.deepEqual(checklistState('```judge-criteria\n{"checks":[{"kind":"length"}]}\n```'), { hasChecklist: true, checklistValid: true });
});

// The chain tools read Arc through the global fetch, like the verifier; a fake chain built from recorded
// Arc testnet data answers here, and every request is recorded, so these tests never touch the network.
function withChain(opts, fn) {
  return async () => {
    const real = globalThis.fetch;
    const chain = fakeChain(opts);
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const req = JSON.parse(init.body);
      seen.push({ url, method: req.method, to: req.params?.[0]?.to?.toLowerCase() });
      return chain.fetch(url, init);
    };
    try { await fn(seen); } finally { globalThis.fetch = real; }
  };
}
/** Replace one 32-byte word of the recorded getJob answer (word 0 is the offset; the job's fields start at word 1). */
const setWord = (hex, i, value) => hex.slice(0, 2 + i * 64) + BigInt(value).toString(16).padStart(64, "0") + hex.slice(2 + (i + 1) * 64);
const JOB_WORD = { evaluator: 4, budget: 6, expiredAt: 7 };

test("verify: a real PASS and a real REJECT ruling on Arc testnet both come back verified", withChain({}, async () => {
  const client = await connect();
  const pass = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "171925" }));
  assert.equal(pass.outcome, "verified", JSON.stringify(pass.checks));
  assert.equal(pass.verdict.pass, true);
  assert.ok(pass.checks.length >= 9);
  assert.equal(pass.error, null);
  const reject = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "170856" }));
  assert.equal(reject.outcome, "verified");
  assert.equal(reject.verdict.pass, false);
  const none = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "999999999" }));
  assert.equal(none.outcome, "error");
  assert.match(none.error, /No such job/);
}));

test("verify: networks never share settings, even when calls overlap, and each reads only its own RPC and contracts", withChain({}, async (seen) => {
  const client = await connect();
  const [testnet, mainnet] = await Promise.all([
    call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "171925" }),
    call(client, "judge_verify_ruling", { network: "arc-mainnet", jobId: "171925" }),
  ]);
  const t = body(testnet), m = body(mainnet);
  assert.equal(t.outcome, "verified");
  assert.equal(t.judge.toLowerCase(), TESTNET.judge);
  assert.equal(m.judge.toLowerCase(), MAINNET.judge);
  assert.equal(m.outcome, "error", "the fake chain only knows the testnet contracts, so mainnet reads must fail");
  assert.match(m.error, /Arc mainnet/);
  const main = seen.filter((c) => c.url === MAINNET.rpc);
  assert.ok(main.length > 0, "mainnet calls went to the mainnet RPC");
  assert.ok(seen.every((c) => c.url === TESTNET.rpc || c.url === MAINNET.rpc), "no other host is ever contacted");
  for (const c of main.filter((x) => x.method === "eth_call")) assert.ok([MAINNET.judge, MAINNET.acp].includes(c.to), `mainnet eth_call to ${c.to}`);
  for (const c of seen.filter((x) => x.url === TESTNET.rpc && x.method === "eth_call")) assert.ok([TESTNET.judge, TESTNET.acp].includes(c.to), `testnet eth_call to ${c.to}`);
}));

test("verify: a delivery hosted elsewhere says why it is incomplete, and the exact bytes finish it", async () => {
  const content = Buffer.from("The deliverable, as the provider hosted it.");
  const jobs = await synthJob({ id: 930001, criteria: { version: 1, checks: [{ kind: "length", params: { min: 3 } }] }, content, providerURI: "ipfs://bafyexample" });
  await withChain({ extraJobs: jobs }, async () => {
    const client = await connect();
    const first = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "930001" }));
    assert.equal(first.outcome, "incomplete");
    assert.deepEqual({ reason: first.incomplete.reason, uri: first.incomplete.uri }, { reason: "remote-uri", uri: "ipfs://bafyexample" });
    assert.match(first.hint, /deliverableBase64/);
    const done = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "930001", deliverableBase64: content.toString("base64") }));
    assert.equal(done.outcome, "verified");
    const wrong = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "930001", deliverable: "not the delivered bytes" }));
    assert.equal(wrong.outcome, "incomplete", "bytes that are not the delivery are the caller's mistake, never the judge's");
    assert.match(wrong.pasteNote, /do not hash to the provider's on-chain commitment/);
  })();
});

test("verify: pasted bytes are ignored when the chain already carries the delivery", withChain({}, async () => {
  const client = await connect();
  const r = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "171925", deliverable: "x" }));
  assert.equal(r.outcome, "verified");
  assert.match(r.pasteNote, /already carries/);
}));

test("verify: pasted text gets the verifier's line-ending repair, as on the page", async () => {
  const content = Buffer.from("line one\r\nline two\r\n");
  const jobs = await synthJob({ id: 930002, criteria: { version: 1, checks: [{ kind: "length", params: { min: 2 } }] }, content, providerURI: "ipfs://bafycrlf" });
  await withChain({ extraJobs: jobs }, async () => {
    const client = await connect();
    const r = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "930002", deliverable: "line one\nline two\n" }));
    assert.equal(r.outcome, "verified");
    assert.match(r.pasteNote, /CRLF/);
  })();
});

test("verify: a ruling with a live web check is reported unsupported, naming the check", async () => {
  const criteria = { version: 1, checks: [{ kind: "length", params: { min: 1 } }, { kind: "http-endpoint", params: { url: "https://status.example.com" } }] };
  const jobs = await synthJob({ id: 930003, criteria, content: "delivered", assumePass: [true, true] });
  await withChain({ extraJobs: jobs }, async () => {
    const client = await connect();
    const r = body(await call(client, "judge_verify_ruling", { network: "arc-testnet", jobId: "930003" }));
    assert.equal(r.outcome, "unsupported");
    assert.deepEqual(r.unsupported, ["http-endpoint"]);
  })();
});

test("status: read from chain, with the checklist state and the verdict", withChain({}, async (seen) => {
  const client = await connect();
  const s = body(await call(client, "judge_job_status", { network: "arc-testnet", jobId: "171925" }));
  assert.equal(s.found, true);
  assert.equal(s.status, "Completed");
  assert.equal(s.judgeIsEvaluator, true);
  assert.deepEqual({ has: s.hasChecklist, valid: s.checklistValid }, { has: true, valid: true });
  assert.equal(s.verdict.pass, true);
  assert.ok(seen.every((c) => c.url === TESTNET.rpc));
  const none = body(await call(client, "judge_job_status", { network: "arc-testnet", jobId: "999999999" }));
  assert.equal(none.found, false);
}));

test("status: budget, expiry and evaluator are read exactly, even an expiry no calendar can show", async () => {
  const other = "0x1111111111111111111111111111111111111111";
  const rewrite = (fields) => (id, hex) => (id === "171925" ? Object.entries(fields).reduce((h, [k, v]) => setWord(h, JOB_WORD[k], v), hex) : hex);
  await withChain({ job: rewrite({ budget: 1_234_567n, expiredAt: 1_790_000_000n, evaluator: other }) }, async () => {
    const client = await connect();
    const s = body(await call(client, "judge_job_status", { network: "arc-testnet", jobId: "171925" }));
    assert.equal(s.budgetUsdc, "1.234567");
    assert.equal(s.expiresAt, new Date(1_790_000_000 * 1000).toISOString());
    assert.equal(s.expiresAtSeconds, "1790000000");
    assert.equal(s.evaluator.toLowerCase(), other);
    assert.equal(s.judgeIsEvaluator, false);
  })();
  await withChain({ job: rewrite({ budget: 2_000_000n, expiredAt: (1n << 256n) - 1n }) }, async () => {
    const client = await connect();
    const s = body(await call(client, "judge_job_status", { network: "arc-testnet", jobId: "171925" }));
    assert.equal(s.budgetUsdc, "2");
    assert.equal(s.expiresAt, null);
    assert.equal(s.expiresAtSeconds, null, "a value the reader could not hold exactly is not printed as if it were exact");
    assert.match(s.expiry, /beyond any calendar date/);
  })();
});

test("status: mainnet reads go only to the mainnet RPC and contracts", withChain({}, async (seen) => {
  const client = await connect();
  await refused(client, "judge_job_status", { network: "arc-mainnet", jobId: "16" }, /could not read Arc mainnet/);
  assert.ok(seen.length > 0);
  for (const c of seen) {
    assert.equal(c.url, MAINNET.rpc);
    if (c.method === "eth_call") assert.ok([MAINNET.judge, MAINNET.acp].includes(c.to), c.to);
  }
}));

test("chain tools refuse unknown networks, unknown fields, and anything that is not a job id", withChain({}, async () => {
  const client = await connect();
  for (const name of ["judge_job_status", "judge_verify_ruling"]) {
    await refused(client, name, { network: "base", jobId: "1" }, INVALID_ARGS);
    await refused(client, name, { network: "arc-testnet", jobId: "12abc" }, INVALID_ARGS);
    await refused(client, name, { network: "arc-testnet", jobId: "0" }, /positive whole number/);
    await refused(client, name, { network: "arc-testnet", jobId: "1", rpc: "https://evil.example" }, INVALID_ARGS);
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

test("request: an abstention and a busy judge are answers, and the API cannot overwrite the tool's own fields", async () => {
  const abstain = await connect({ fetchImpl: fakeApi(422, { result: "abstained", reason: "invalid criteria" }).fetchImpl });
  assert.deepEqual(body(await call(abstain, "judge_request_ruling", { jobId: "7" })), { network: "arc-testnet", httpStatus: 422, result: "abstained", reason: "invalid criteria" });
  const busy = await connect({ fetchImpl: fakeApi(503, { result: "retry-later" }).fetchImpl });
  assert.equal(body(await call(busy, "judge_request_ruling", { jobId: "7" })).result, "retry-later");
  const liar = await connect({ fetchImpl: fakeApi(500, { httpStatus: 200, network: "arc-mainnet", error: "boom" }).fetchImpl });
  const out = body(await call(liar, "judge_request_ruling", { jobId: "7" }));
  assert.deepEqual({ httpStatus: out.httpStatus, network: out.network }, { httpStatus: 500, network: "arc-testnet" });
});

test("request: only Arc testnet, only a job id, only a 32-byte transaction hash", async () => {
  const api = fakeApi(200, {});
  const client = await connect({ fetchImpl: api.fetchImpl });
  await refused(client, "judge_request_ruling", { network: "arc-mainnet", jobId: "16" }, INVALID_ARGS);
  await refused(client, "judge_request_ruling", { jobId: "abc" }, INVALID_ARGS);
  await refused(client, "judge_request_ruling", { jobId: "5", submitTx: "0x1234" }, INVALID_ARGS);
  await refused(client, "judge_request_ruling", { jobId: "0" }, /positive whole number/);
  const down = await connect({ fetchImpl: async () => { throw new Error("offline"); } });
  await refused(down, "judge_request_ruling", { jobId: "5" }, /could not reach the hosted judge/);
  assert.equal(api.seen.length, 0, "a refused request never reaches the judge");
});
