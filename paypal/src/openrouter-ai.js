import { z } from "zod";
import { dryRunEvaluate } from "../engine/evaluate.js";
import { checkCriteria } from "./escrow.js";
import { AiError, Draft, DRAFTER_SYSTEM, WORKER_SYSTEM, toCriteria } from "./ai.js";

export const OPENROUTER_MODEL = "openai/gpt-4.1-mini";

/** Identifiers the request names, like RCPT-1042 or INV-7: a draft must pin each one, or other IDs would pass. */
export function namedIds(request) {
  return [...new Set(String(request).match(/\b[A-Z][A-Z0-9]{1,15}-[0-9]{1,12}\b/g) ?? [])].slice(0, 32);
}

export function createOpenRouterAi({ apiKey = process.env.OPENROUTER_API_KEY, model = OPENROUTER_MODEL,
  fetchImpl = fetch, evaluate = dryRunEvaluate, baseUrl = "https://openrouter.ai/api/v1", publicUrl = "http://localhost:3000" } = {}) {
  if (!apiKey) throw new Error("Set OPENROUTER_API_KEY to use the OpenRouter AI provider");

  async function chat(messages, schema = null) {
    let jsonSchema = null;
    if (schema) {
      jsonSchema = z.toJSONSchema(schema);
      delete jsonSchema.$schema;
    }
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`, "content-type": "application/json",
        "http-referer": publicUrl, "x-title": "Judge Pay",
      },
      body: JSON.stringify({
        model, messages, max_completion_tokens: 4000, temperature: 0,
        ...(schema ? {
          response_format: { type: "json_schema", json_schema: { name: "judge_pay_acceptance_checks", strict: true, schema: jsonSchema } },
          provider: { require_parameters: true },
        } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new AiError(response.status, `OpenRouter: ${body?.error?.message ?? `request failed with HTTP ${response.status}`}`);
    const message = body?.choices?.[0]?.message;
    const content = typeof message?.content === "string" ? message.content
      : Array.isArray(message?.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("") : "";
    if (!content.trim()) throw new AiError(422, "OpenRouter returned an empty response");
    return { content, model: body?.model ?? model };
  }

  async function draftCriteria({ request } = {}) {
    if (typeof request !== "string" || !request.trim() || request.length > 4000) throw new AiError(400, "describe the job in 1 to 4000 characters");
    const messages = [{ role: "system", content: DRAFTER_SYSTEM }, { role: "user", content: request.trim() }];
    const named = namedIds(request);
    let lastGood = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await chat(messages, Draft);
      let problem = null;
      let draft = null;
      try {
        const parsed = Draft.safeParse(JSON.parse(result.content));
        if (parsed.success) draft = parsed.data;
        else problem = "the reply did not match the acceptance-check schema";
      } catch { problem = "the reply was not valid JSON"; }
      if (draft) {
        try {
          const out = { ...draft, criteria: checkCriteria(toCriteria(draft)), reasons: draft.checks.map((check) => check.why), model: result.model };
          const unpinned = named.filter((id) => !JSON.stringify(out.criteria).includes(id));
          if (!unpinned.length) return out;
          lastGood = { ...out, unpinned };
          problem = `the request names ${unpinned.join(", ")}, but no check restricts them, so a delivery with made-up IDs would pass. In the JSON shape, give the field or list that holds them an enum of exactly these values, for example "items": { "type": "string", "enum": ${JSON.stringify(unpinned)} } on a list. Keep every other rule`;
        } catch (error) { problem = error.message; }
      }
      messages.push({ role: "assistant", content: result.content }, { role: "user", content: `That draft cannot be used: ${problem}. Return a corrected draft.` });
    }
    if (lastGood) return lastGood;
    throw new AiError(422, "could not draft valid checks for this request; write them by hand or rephrase the request");
  }

  async function work({ task, criteria, reasons = [], jobId, maxRounds = 3 } = {}) {
    if (typeof task !== "string" || !task.trim()) throw new AiError(400, "the task is empty");
    const listed = criteria.checks.map((check, index) => `- ${check.kind} ${JSON.stringify(check.params)}${reasons[index] ? `: ${reasons[index]}` : ""}`).join("\n");
    const messages = [
      { role: "system", content: WORKER_SYSTEM },
      { role: "user", content: `Task:\n${task}\n\nChecks your delivery must pass:\n${listed}` },
    ];
    const trace = [];
    let content = "";
    for (let round = 1; round <= maxRounds; round++) {
      const result = await chat(messages);
      content = result.content.trim();
      const evaluated = await evaluate({ criteria, deliverable: content || " ", jobId });
      if (evaluated.status !== 200) throw new AiError(500, `the dry run could not score the draft: ${evaluated.body.error ?? evaluated.body.reason}`);
      const failed = evaluated.body.results.filter((item) => !item.pass);
      trace.push({ round, model: result.model, score: evaluated.body.score, pass: evaluated.body.pass, failed: failed.map((item) => `${item.kind}: ${item.detail}`) });
      if (evaluated.body.pass) return { content, passed: true, rounds: round, trace, model: result.model };
      messages.push({ role: "assistant", content: result.content },
        { role: "user", content: `These checks did not pass:\n${failed.map((item) => `- ${item.kind}: ${item.detail}`).join("\n")}\nRevise the deliverable so every check passes. Reply with the full deliverable only.` });
    }
    return { content, passed: false, rounds: maxRounds, trace, model };
  }

  return { draftCriteria, work, model, provider: "openrouter" };
}
