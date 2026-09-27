// Model-assisted drafting, for the sentences the deterministic drafter cannot
// read. The rules go first and the model only sees what they left over. It
// must map every leftover sentence to checks or call it not checkable, and it
// may only use the owner's own words and numbers: a term, a count, a field
// name, a URL or a digest that is not in the sentence sends that sentence back
// to the owner. The result must also pass the judge's own validator. So the
// model can read awkward phrasing; it cannot add requirements.
import { validateCriteria } from "../../kit/judge-kit.js";
import { draftCriteria, splitSentences } from "./drafter.js";

const KINDS = ["length", "contains", "schema", "checksum", "http-endpoint"];
const CHECK_FIELDS = ["kind", "params", "weight", "covers"];

const PROMPT = `You turn acceptance sentences into checks for a deterministic judge.
Kinds (params):
- length: { min?, max?, unit?: "words" | "chars" }
- contains: { all: [terms], wholeWords?: true }
- schema: { required?: [field names], types?: { field: "string" | "number" | "boolean" | "object" } }
- checksum: { sha256: "<64 hex>" }
- http-endpoint: { url, expectStatus?, bodyIncludes?: [terms] }
Rules: use only words, numbers, names, URLs and digests that appear in the sentence itself. Never invent a requirement.
If a sentence is subjective or cannot be checked this way, list it in notCheckable.
Answer with JSON only: {"checks":[{"kind":...,"params":{...},"covers":"<the exact sentence>"}],"notCheckable":["<the exact sentence>"]}`;

const has = (sentence, value) => sentence.toLowerCase().includes(String(value).toLowerCase());

/** Why a model check is not grounded in its sentence, or null if it is. */
function ungrounded(check, sentence) {
  const p = check.params ?? {};
  const words = (list) => (list ?? []).find((t) => !has(sentence, t));
  switch (check.kind) {
    case "length":
      for (const k of ["min", "max"]) if (p[k] !== undefined && !new RegExp(`(^|\\D)${p[k]}(\\D|$)`).test(sentence)) return `${k} ${p[k]}`;
      if (p.unit === "chars" && !/char/i.test(sentence)) return "a character count";
      return null;
    case "contains": { const t = words(p.all); return t === undefined ? null : `"${t}"`; }
    case "schema": { const f = words([...(p.required ?? []), ...Object.keys(p.types ?? {})]); return f === undefined ? null : `field "${f}"`; }
    case "checksum": return has(sentence, p.sha256) ? null : "the digest";
    case "http-endpoint": {
      if (!has(sentence, p.url)) return "the URL";
      if (p.expectStatus !== undefined && !has(sentence, p.expectStatus)) return `status ${p.expectStatus}`;
      const t = words(p.bodyIncludes); return t === undefined ? null : `"${t}"`;
    }
    default: return `kind ${check.kind}`;
  }
}

/**
 * Draft criteria, asking the model only about the sentences the rules could not read.
 * @param {string} text  the owner's acceptance text
 * @param {{ chat?: (messages) => Promise<string>, model?: string }} opts
 * @returns {Promise<{ complete, criteria, uncovered, reason?, draftedBy?, modelChecks? }>}
 */
export async function draftWithModel(text, { chat, model = "model" } = {}) {
  const rules = draftCriteria(text);
  if (rules.complete) return { ...rules, draftedBy: "rules" };
  if (!chat || !rules.uncovered?.length) return rules; // a conflict, or no model: the rules' answer stands
  const leftover = rules.uncovered;
  const back = (reason, uncovered = leftover) => ({ complete: false, criteria: null, uncovered, reason });

  let answer;
  try {
    const raw = await chat([{ role: "system", content: PROMPT }, { role: "user", content: JSON.stringify({ sentences: leftover }) }]);
    answer = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch (e) {
    return back(`the model gave no usable answer (${String(e.message || e).slice(0, 80)}); the owner decides these sentences`);
  }
  if (!answer || !Array.isArray(answer.checks) || !Array.isArray(answer.notCheckable ?? [])) return back("the model answered in the wrong shape; the owner decides these sentences");

  const notCheckable = (answer.notCheckable ?? []).filter((s) => leftover.includes(s));
  if (notCheckable.length) return back("the model says these cannot be checked by a deterministic judge", notCheckable);

  const modelChecks = [];
  for (const c of answer.checks) {
    if (!c || typeof c !== "object" || !KINDS.includes(c.kind) || Object.keys(c).some((k) => !CHECK_FIELDS.includes(k))) {
      return back("the model proposed a check the judge would refuse");
    }
    if (!leftover.includes(c.covers)) return back("the model quoted a sentence that is not in the brief");
    const why = ungrounded(c, c.covers);
    if (why) return back(`the model used ${why}, which is not in the owner's words`, [c.covers]);
    const { covers, ...check } = c;
    if (check.kind === "contains" && check.params?.wholeWords === undefined) check.params = { ...check.params, wholeWords: true };
    modelChecks.push({ sentence: covers, check });
  }
  const skipped = leftover.filter((s) => !modelChecks.some((m) => m.sentence === s));
  if (skipped.length) return back("the model did not cover every sentence", skipped);

  const covered = splitSentences(text).filter((s) => !leftover.includes(s));
  const base = covered.length ? draftCriteria(covered.map((s) => `${s}.`).join(" ")) : { complete: true, criteria: { version: 1, checks: [] } };
  if (!base.complete) return back(base.reason);
  const criteria = { version: 1, checks: [...base.criteria.checks, ...modelChecks.map((m) => m.check)] };
  const v = validateCriteria(criteria);
  if (!v.valid) return back(`the drafted criteria would be refused by the judge: ${v.reason}`);
  return { complete: true, criteria, uncovered: [], draftedBy: `${covered.length ? "rules+" : ""}model:${model}`, modelChecks };
}

/** A chat function for any OpenAI-compatible endpoint (Gemini, Groq, OpenRouter, Vercel AI Gateway). */
export function openAIChat({ baseUrl, apiKey, model, fetchImpl = fetch, timeoutMs = 30_000 }) {
  return async (messages) => {
    const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`model call failed: HTTP ${res.status}`);
    const d = await res.json();
    return d?.choices?.[0]?.message?.content ?? "";
  };
}

/** The model to draft with, from the environment, or null (rules only). Free tiers first. */
export function modelFromEnv(env = process.env) {
  const pick = (baseUrl, apiKey, model, name) => ({ chat: openAIChat({ baseUrl, apiKey, model }), model, name });
  if (env.LLM_API_KEY && env.LLM_BASE_URL && env.LLM_MODEL) return pick(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL, "custom");
  if (env.GEMINI_API_KEY) return pick("https://generativelanguage.googleapis.com/v1beta/openai", env.GEMINI_API_KEY, env.LLM_MODEL || "gemini-2.5-flash", "Gemini");
  if (env.GROQ_API_KEY) return pick("https://api.groq.com/openai/v1", env.GROQ_API_KEY, env.LLM_MODEL || "llama-3.3-70b-versatile", "Groq");
  if (env.AI_GATEWAY_API_KEY) return pick("https://ai-gateway.vercel.sh/v1", env.AI_GATEWAY_API_KEY, env.LLM_MODEL || "openai/gpt-5-nano", "Vercel AI Gateway");
  return null;
}
