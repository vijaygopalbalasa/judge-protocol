// The AI module against a stand-in Claude client: the requests it sends, how drafts become Judge criteria, the repair
// turn, refusals, and the worker's self-check loop. No request reaches the API here.
import test from "node:test";
import assert from "node:assert/strict";
import { createAi, toCriteria, AiError, MODEL } from "../src/ai.js";
import { checkCriteria } from "../src/escrow.js";

/** A client whose replies are queued per method; every request is recorded. */
function fakeClient({ parse = [], create = [] } = {}) {
  const calls = { parse: [], create: [] };
  const take = (q, name) => { if (!q.length) throw new Error(`no queued reply for ${name}`); return q.shift(); };
  return {
    calls,
    beta: { messages: {
      async parse(req) { calls.parse.push(JSON.parse(JSON.stringify(req))); return take(parse, "parse"); },
      async create(req) { calls.create.push(JSON.parse(JSON.stringify(req))); return take(create, "create"); },
    } },
  };
}
const nil = { min: null, max: null, unit: null, all: null, wholeWords: null, required: null, types: null, shape: null };
const draftReply = (draft) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(draft) }], parsed_output: draft });
const textReply = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
const DRAFT = {
  title: "Product blurb for a steel water bottle", summary: "A 40 to 80 word blurb that names the product and its capacity.", passThreshold: 100,
  checks: [
    { ...nil, kind: "length", why: "Between 40 and 80 words.", weight: 1, min: 40, max: 80, unit: "words" },
    { ...nil, kind: "contains", why: "Names the product and its capacity.", weight: 2, all: ["SteelSip", "750 ml"] },
  ],
  notCheckable: ["Whether the tone is friendly"],
};

test("drafting asks Claude Opus 5.5 for structured output, with refusal fallbacks on", async () => {
  const client = fakeClient({ parse: [draftReply(DRAFT)] });
  const ai = createAi({ client });
  const out = await ai.draftCriteria({ request: "A short blurb for my SteelSip 750 ml bottle" });
  const req = client.calls.parse[0];
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(MODEL, "claude-opus-5-5");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(req.fallbacks, "default");
  assert.equal(req.output_config.effort, "medium");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(req.thinking, undefined, "Opus 5.5 always thinks; the request does not try to switch it");
  assert.deepEqual(req.messages, [{ role: "user", content: "A short blurb for my SteelSip 750 ml bottle" }]);
  assert.deepEqual(out.criteria, { version: 1, passThreshold: 100, checks: [
    { kind: "length", params: { min: 40, max: 80, unit: "words" }, weight: 1 },
    { kind: "contains", params: { all: ["SteelSip", "750 ml"] }, weight: 2 },
  ] });
  assert.deepEqual(out.reasons, ["Between 40 and 80 words.", "Names the product and its capacity."]);
  assert.deepEqual(out.notCheckable, ["Whether the tone is friendly"]);
});

test("every kind maps to criteria Judge accepts; fields that do not apply are dropped", () => {
  const c = toCriteria({ passThreshold: 80, checks: [
    { ...nil, kind: "schema", why: "", weight: 1, required: ["name", "price"], types: [{ field: "price", type: "number" }] },
    { ...nil, kind: "json", why: "", weight: 3, shape: JSON.stringify({ type: "object", required: ["items"], properties: { items: { type: "array", minItems: 1 } } }) },
    { ...nil, kind: "contains", why: "", weight: 1, all: ["refund"], wholeWords: true },
    { ...nil, kind: "length", why: "", weight: 1, max: 300, unit: "chars" },
  ] });
  assert.deepEqual(c.checks[0].params, { required: ["name", "price"], types: { price: "number" } });
  assert.deepEqual(c.checks[1].params.shape.properties.items, { type: "array", minItems: 1 });
  assert.deepEqual(c.checks[2].params, { all: ["refund"], wholeWords: true });
  assert.deepEqual(c.checks[3].params, { max: 300, unit: "chars" });
  assert.equal(checkCriteria(c), c, "valid Judge criteria");
  assert.throws(() => toCriteria({ passThreshold: 100, checks: [{ ...nil, kind: "json", why: "", weight: 1, shape: "{not json" }] }), AiError);
});

test("a draft Judge cannot use gets one repair turn carrying the exact problem, appended to the conversation", async () => {
  const broken = { ...DRAFT, checks: [{ ...nil, kind: "json", why: "valid JSON", weight: 1, shape: JSON.stringify({ name: "string" }) }] };
  const client = fakeClient({ parse: [draftReply(broken), draftReply(DRAFT)] });
  const out = await createAi({ client }).draftCriteria({ request: "blurb" });
  assert.equal(out.criteria.checks.length, 2);
  const second = client.calls.parse[1].messages;
  assert.equal(second.length, 3, "append-only: the first reply stays in the history");
  assert.equal(second[1].role, "assistant");
  assert.deepEqual(second[1].content, draftReply(broken).content, "the assistant turn is passed back unchanged");
  assert.match(second[2].content, /cannot be used: invalid criteria: .*unknown keyword "name"/);
});

test("two unusable drafts end in a clear error, never in unchecked criteria", async () => {
  const broken = { ...DRAFT, checks: [{ ...nil, kind: "json", why: "", weight: 1, shape: "nope" }] };
  const client = fakeClient({ parse: [draftReply(broken), { stop_reason: "end_turn", content: [], parsed_output: null }] });
  await assert.rejects(createAi({ client }).draftCriteria({ request: "x" }), (e) => e instanceof AiError && e.status === 422 && /write them by hand/.test(e.message));
});

test("a refusal is reported with its category; nothing reads the empty content", async () => {
  const client = fakeClient({ parse: [{ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" }, content: [], parsed_output: null }] });
  await assert.rejects(createAi({ client }).draftCriteria({ request: "x" }), (e) => e instanceof AiError && /declined.*cyber/.test(e.message));
  const c2 = fakeClient({ create: [{ stop_reason: "refusal", stop_details: null, content: [] }] });
  await assert.rejects(createAi({ client: c2 }).work({ task: "t", criteria: { version: 1, checks: [{ kind: "length", params: { min: 1 } }] } }), /declined/);
});

test("requests are sized and validated before any call", async () => {
  const client = fakeClient();
  await assert.rejects(createAi({ client }).draftCriteria({ request: "" }), (e) => e.status === 400);
  await assert.rejects(createAi({ client }).draftCriteria({ request: "x".repeat(4001) }), (e) => e.status === 400);
  await assert.rejects(createAi({ client }).work({ task: " ", criteria: { version: 1, checks: [] } }), (e) => e.status === 400);
  assert.equal(client.calls.parse.length + client.calls.create.length, 0);
});

const CRITERIA = { version: 1, passThreshold: 100, checks: [
  { kind: "contains", params: { all: ["SteelSip", "750 ml"] }, weight: 1 },
  { kind: "length", params: { min: 5, max: 40 }, weight: 1 },
] };

test("the worker revises until the free dry run passes, telling Claude exactly which checks failed", async () => {
  const client = fakeClient({ create: [textReply("A lovely bottle for every day."), textReply("SteelSip keeps 750 ml of water cold all day long.")] });
  const out = await createAi({ client }).work({ task: "Blurb for SteelSip", criteria: CRITERIA, reasons: ["names it", "short"], jobId: "1792000000000001" });
  assert.equal(out.passed, true);
  assert.equal(out.rounds, 2);
  assert.equal(out.content, "SteelSip keeps 750 ml of water cold all day long.");
  assert.deepEqual(out.trace.map((t) => [t.round, t.score, t.pass]), [[1, 50, false], [2, 100, true]]);
  const first = client.calls.create[0];
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.fallbacks, "default");
  assert.match(first.messages[0].content, /contains \{"all":\["SteelSip","750 ml"\]\}: names it/);
  const second = client.calls.create[1].messages;
  assert.equal(second.length, 3);
  assert.match(second[2].content, /contains: missing terms: SteelSip, 750 ml/);
});

test("the worker stops after its rounds and says it did not pass; the job is never submitted by the AI module", async () => {
  const client = fakeClient({ create: [textReply("no"), textReply("still no"), textReply("nope")] });
  const out = await createAi({ client }).work({ task: "t", criteria: CRITERIA, maxRounds: 3 });
  assert.equal(out.passed, false);
  assert.equal(out.trace.length, 3);
  assert.equal(client.calls.create.length, 3);
});
