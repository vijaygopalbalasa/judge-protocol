import test from "node:test";
import assert from "node:assert/strict";
import { createOpenRouterAi, OPENROUTER_MODEL } from "../src/openrouter-ai.js";

const nil = { min: null, max: null, unit: null, all: null, wholeWords: null, required: null, types: null, shape: null };
const DRAFT = {
  title: "Steel bottle blurb", summary: "A short blurb naming the product and capacity.", passThreshold: 100,
  checks: [
    { ...nil, kind: "length", why: "Between 5 and 40 words.", weight: 1, min: 5, max: 40, unit: "words" },
    { ...nil, kind: "contains", why: "Names the product and capacity.", weight: 2, all: ["SteelSip", "750 ml"] },
  ],
  notCheckable: ["Whether the tone is friendly"],
};
const CRITERIA = { version: 1, passThreshold: 100, checks: [
  { kind: "contains", params: { all: ["SteelSip", "750 ml"] }, weight: 1 },
  { kind: "length", params: { min: 5, max: 40 }, weight: 1 },
] };

function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url, request });
    const next = replies.shift();
    if (!next) throw new Error("no queued reply");
    return { ok: next.ok ?? true, status: next.status ?? 200, async json() { return next.body ?? { model: OPENROUTER_MODEL, choices: [{ message: { content: next.content } }] }; } };
  };
  return { calls, fetchImpl };
}

test("OpenRouter drafts structured criteria with strict provider routing", async () => {
  const fake = fakeFetch([{ content: JSON.stringify(DRAFT) }]);
  const ai = createOpenRouterAi({ apiKey: "test-openrouter-key", fetchImpl: fake.fetchImpl });
  const out = await ai.draftCriteria({ request: "Write a SteelSip 750 ml bottle blurb" });
  const call = fake.calls[0];
  const body = JSON.parse(call.request.body);
  assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(call.request.headers.authorization, "Bearer test-openrouter-key");
  assert.equal(body.model, "openai/gpt-4.1-mini");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.$schema, undefined);
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /constrain the specific numeric field/);
  assert.equal(out.criteria.checks.length, 2);
  assert.equal(out.criteria.checks[1].params.all[0], "SteelSip");
  assert.equal(out.model, OPENROUTER_MODEL);
  assert.equal(ai.provider, "openrouter");
});

test("OpenRouter gets one exact criteria repair turn", async () => {
  const broken = { ...DRAFT, checks: [{ ...nil, kind: "json", why: "bad shape", weight: 1, shape: JSON.stringify({ name: "string" }) }] };
  const fake = fakeFetch([{ content: JSON.stringify(broken) }, { content: JSON.stringify(DRAFT) }]);
  const out = await createOpenRouterAi({ apiKey: "x", fetchImpl: fake.fetchImpl }).draftCriteria({ request: "blurb" });
  assert.equal(out.criteria.checks.length, 2);
  assert.equal(fake.calls.length, 2);
  const messages = JSON.parse(fake.calls[1].request.body).messages;
  assert.equal(messages.length, 4);
  assert.match(messages[3].content, /unknown keyword "name"/);
});

test("OpenRouter worker revises against deterministic failures and returns the actual model", async () => {
  const fake = fakeFetch([{ content: "A lovely bottle." }, { content: "SteelSip keeps 750 ml of water cold all day long." }]);
  const out = await createOpenRouterAi({ apiKey: "x", fetchImpl: fake.fetchImpl }).work({ task: "Blurb", criteria: CRITERIA, jobId: "1792000000000001" });
  assert.equal(out.passed, true);
  assert.equal(out.rounds, 2);
  assert.equal(out.trace[0].pass, false);
  assert.equal(out.trace[1].pass, true);
  assert.equal(out.trace[1].model, OPENROUTER_MODEL);
  const messages = JSON.parse(fake.calls[1].request.body).messages;
  assert.match(messages[3].content, /missing terms: SteelSip, 750 ml/);
});

test("OpenRouter stops without a passing draft after three rounds", async () => {
  const fake = fakeFetch([{ content: "no" }, { content: "still no" }, { content: "nope" }]);
  const out = await createOpenRouterAi({ apiKey: "x", fetchImpl: fake.fetchImpl }).work({ task: "Blurb", criteria: CRITERIA });
  assert.equal(out.passed, false);
  assert.equal(out.trace.length, 3);
});

test("OpenRouter reports provider errors and validates input before calls", async () => {
  const fake = fakeFetch([{ ok: false, status: 401, body: { error: { message: "bad key" } } }]);
  const ai = createOpenRouterAi({ apiKey: "x", fetchImpl: fake.fetchImpl });
  await assert.rejects(ai.draftCriteria({ request: "blurb" }), /OpenRouter: bad key/);
  await assert.rejects(ai.draftCriteria({ request: "" }), (error) => error.status === 400);
  assert.equal(fake.calls.length, 1);
  assert.throws(() => createOpenRouterAi({ apiKey: "" }), /OPENROUTER_API_KEY/);
});
