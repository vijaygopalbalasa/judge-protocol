// The model only helps with sentences the rules could not read, and it may only
// use the owner's own words and numbers. Anything it invents, skips or calls
// uncheckable goes back to the owner, exactly as without a model.
import test from "node:test";
import assert from "node:assert/strict";
import { draftWithModel, openAIChat } from "../src/llm-drafter.js";
import { validateCriteria } from "../../kit/judge-kit.js";

const S1 = "The summary needs to reference both Circle and Arc by name";
const S2 = "Return a JSON object whose invoiceId is text and whose total is a number";
const reply = (o) => async () => JSON.stringify(o);

test("no model call when the rules already read every sentence", async () => {
  let calls = 0;
  const d = await draftWithModel("It must be between 50 and 200 words. Mention USDC and Arc.", { chat: async () => { calls++; return "{}"; } });
  assert.equal(calls, 0);
  assert.equal(d.complete, true);
  assert.equal(d.draftedBy, "rules");
});

test("the model turns an unreadable sentence into grounded checks, merged with the rules' checks", async () => {
  const d = await draftWithModel(`It must be between 50 and 200 words. ${S1}.`, { model: "test-model", chat: reply({
    checks: [{ kind: "contains", params: { all: ["Circle", "Arc"] }, covers: S1 }], notCheckable: [] }) });
  assert.equal(d.complete, true, d.reason);
  assert.equal(d.draftedBy, "rules+model:test-model");
  assert.deepEqual(d.criteria.checks.map((c) => c.kind), ["length", "contains"]);
  assert.equal(d.criteria.checks[1].params.wholeWords, true, "whole words by default, like the rules");
  assert.ok(!("covers" in d.criteria.checks[1]), "the judge refuses unknown check fields");
  assert.deepEqual(d.modelChecks, [{ sentence: S1, check: d.criteria.checks[1] }]);
  assert.equal(validateCriteria(d.criteria).valid, true);
});

test("typed JSON fields are fine when every field name is the owner's", async () => {
  const d = await draftWithModel(`${S2}.`, { chat: reply({
    checks: [{ kind: "schema", params: { required: ["invoiceId", "total"], types: { invoiceId: "string", total: "number" } }, covers: S2 }], notCheckable: [] }) });
  assert.equal(d.complete, true, d.reason);
});

test("anything the model invents sends the sentence back to the owner", async () => {
  const cases = [
    ["a term not in the sentence", { kind: "contains", params: { all: ["Circle", "USDC"] } }],
    ["a word count nobody wrote", { kind: "length", params: { min: 200 } }],
    ["a field name nobody wrote", { kind: "schema", params: { required: ["amount"] } }],
    ["a URL nobody wrote", { kind: "http-endpoint", params: { url: "https://example.com/health" } }],
    ["a digest nobody wrote", { kind: "checksum", params: { sha256: "a".repeat(64) } }],
  ];
  for (const [label, check] of cases) {
    const d = await draftWithModel(`${S1}.`, { chat: reply({ checks: [{ ...check, covers: S1 }], notCheckable: [] }) });
    assert.equal(d.complete, false, label);
    assert.deepEqual(d.uncovered, [S1], label);
    assert.match(d.reason, /owner's words/, label);
  }
});

test("a sentence the model skips, calls uncheckable, or misquotes goes back to the owner", async () => {
  const skip = await draftWithModel(`${S1}. ${S2}.`, { chat: reply({ checks: [{ kind: "contains", params: { all: ["Circle", "Arc"] }, covers: S1 }], notCheckable: [] }) });
  assert.equal(skip.complete, false);
  assert.deepEqual(skip.uncovered, [S2]);
  const taste = "Make the landing page look great";
  const subjective = await draftWithModel(`${taste}.`, { chat: reply({ checks: [], notCheckable: [taste] }) });
  assert.equal(subjective.complete, false);
  assert.deepEqual(subjective.uncovered, [taste]);
  const misquote = await draftWithModel(`${S1}.`, { chat: reply({ checks: [{ kind: "contains", params: { all: ["Circle"] }, covers: "The summary mentions Circle" }], notCheckable: [] }) });
  assert.equal(misquote.complete, false);
  assert.deepEqual(misquote.uncovered, [S1]);
});

test("a broken, failing or rule-breaking model never crashes the agent and never counts as a draft", async () => {
  for (const [label, chat] of [
    ["not JSON", async () => "Sure! Here are your checks"],
    ["throws", async () => { throw new Error("rate limited"); }],
    ["unknown kind", reply({ checks: [{ kind: "vibes", params: {}, covers: S1 }], notCheckable: [] })],
    ["extra field", reply({ checks: [{ kind: "contains", params: { all: ["Circle"] }, covers: S1, note: "x" }], notCheckable: [] })],
    ["checks not a list", reply({ checks: "contains Circle", notCheckable: [] })],
  ]) {
    const d = await draftWithModel(`${S1}.`, { chat });
    assert.equal(d.complete, false, label);
    assert.deepEqual(d.uncovered, [S1], label);
  }
});

test("conflicts the rules find are refused before any model call", async () => {
  let calls = 0;
  const d = await draftWithModel(`The sha256 is ${"a".repeat(64)}. The sha256 is ${"b".repeat(64)}. ${S1}.`, { chat: async () => { calls++; return "{}"; } });
  assert.equal(d.complete, false);
  assert.match(d.reason, /conflict/);
  assert.equal(calls, 0);
});

test("without a model the result is exactly the rules' answer", async () => {
  const d = await draftWithModel(`${S1}.`, {});
  assert.equal(d.complete, false);
  assert.deepEqual(d.uncovered, [S1]);
});

test("openAIChat speaks the OpenAI-compatible protocol and fails loudly on HTTP errors", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{\"ok\":1}" } }] }) }; };
  const chat = openAIChat({ baseUrl: "https://llm.example/v1/", apiKey: "k-123", model: "m-1", fetchImpl });
  assert.equal(await chat([{ role: "user", content: "hi" }]), "{\"ok\":1}");
  assert.equal(seen[0].url, "https://llm.example/v1/chat/completions");
  assert.equal(seen[0].init.headers.authorization, "Bearer k-123");
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, "m-1");
  assert.equal(body.temperature, 0);
  const failing = openAIChat({ baseUrl: "https://llm.example/v1", apiKey: "k", model: "m", fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  await assert.rejects(() => failing([]), /HTTP 429/);
});

test("a doctored quote cannot smuggle in a term, even next to an honest check", async () => {
  const d = await draftWithModel(`${S1}.`, { chat: reply({ checks: [
    { kind: "contains", params: { all: ["Circle", "Arc"] }, covers: S1 },
    { kind: "contains", params: { all: ["USDC"] }, covers: `${S1} and USDC` },
  ], notCheckable: [] }) });
  assert.equal(d.complete, false, "the invented USDC requirement must not get through");
  assert.deepEqual(d.uncovered, [S1]);
});

test("if the model both answers a sentence and calls it uncheckable, its doubt wins", async () => {
  const d = await draftWithModel(`${S1}.`, { chat: reply({ checks: [{ kind: "contains", params: { all: ["Circle", "Arc"] }, covers: S1 }], notCheckable: [S1] }) });
  assert.equal(d.complete, false);
  assert.deepEqual(d.uncovered, [S1]);
  assert.match(d.reason, /cannot be checked/);
});

test("modelFromEnv picks a free provider from the environment, and none without a key", async () => {
  const { modelFromEnv } = await import("../src/llm-drafter.js");
  assert.equal(modelFromEnv({}), null);
  assert.deepEqual((({ name, model }) => ({ name, model }))(modelFromEnv({ GEMINI_API_KEY: "g" })), { name: "Gemini", model: "gemini-2.5-flash" });
  assert.equal(modelFromEnv({ GROQ_API_KEY: "q" }).name, "Groq");
  assert.equal(modelFromEnv({ AI_GATEWAY_API_KEY: "v" }).name, "Vercel AI Gateway");
  assert.equal(modelFromEnv({ LLM_API_KEY: "k", LLM_BASE_URL: "https://x/v1", LLM_MODEL: "m", GEMINI_API_KEY: "g" }).name, "custom", "an explicit endpoint wins");
});
