// The AI in Judge Pay, through Claude: it drafts the acceptance checks from a buyer's plain-language request (the buyer
// reviews them before paying), and an AI worker writes the deliverable, checking itself against the same deterministic
// checks before it submits. The AI never decides a payment: only Judge's checks, agreed before any money moved, do.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { dryRunEvaluate } from "../engine/evaluate.js";
import { checkCriteria } from "./escrow.js";

export const MODEL = "claude-opus-5-5";
// On a policy decline the API re-runs the request on Anthropic's recommended fallback model, chosen by category.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

export class AiError extends Error {
  constructor(status, message) { super(message); this.name = "AiError"; this.status = status; }
}

const Check = z.object({
  kind: z.enum(["length", "contains", "json", "schema"]),
  why: z.string().describe("One plain sentence for the buyer: what this check guarantees about the delivery."),
  weight: z.number().int().min(1).max(10),
  min: z.number().int().min(0).nullable(),
  max: z.number().int().min(0).nullable(),
  unit: z.enum(["words", "chars"]).nullable(),
  all: z.array(z.string()).nullable(),
  wholeWords: z.boolean().nullable(),
  required: z.array(z.string()).nullable(),
  types: z.array(z.object({ field: z.string(), type: z.enum(["string", "number", "boolean", "object"]) })).nullable(),
  shape: z.string().nullable().describe("For kind json only: the shape, written as a JSON string."),
});
export const Draft = z.object({
  title: z.string(),
  summary: z.string().describe("One sentence: what passing every check guarantees."),
  passThreshold: z.number().int().min(1).max(100),
  checks: z.array(Check),
  notCheckable: z.array(z.string()).describe("Parts of the request a program cannot verify, such as tone or accuracy."),
});

const DRAFTER_SYSTEM = `You turn a request for paid work into acceptance checks that a program runs on the delivered text. Payment is released only if the delivery passes, and the buyer reviews your checks before paying, so each check must be something a program verifies the same way every time.

Check kinds:
- length: the size of the delivery in words (unit "words") or characters (unit "chars"), with min, max or both.
- contains: terms that must all appear, matched exactly and case-sensitively (all). Set wholeWords to true to require whole words.
- json: the delivery must be JSON of a given shape. Write the shape as a JSON string using only these keywords: type (object, array, string, number, integer, boolean, null), required, properties, additionalProperties, items, minItems, maxItems, minLength, maxLength, minimum, maximum, enum, format ("url" or "email"), anyOf. Each keyword other than type, enum and anyOf sits in a shape that declares the type it applies to.
- schema: the delivery must be a JSON object with the required fields, and optionally the types of some fields (string, number, boolean, object).

Use two to six checks and set passThreshold to 100 unless the request allows partial credit. Leave a field null when it does not apply to a check. Anything a program cannot verify, such as tone, accuracy or taste, goes in notCheckable and never into a check. Keep the title under 80 characters.`;

const WORKER_SYSTEM = "You are a worker paid through Judge Pay. Write exactly the deliverable the task asks for. A program checks your delivery against the listed checks, and you are paid only if it passes. Reply with the deliverable itself and nothing else.";

/** The drafted checks as Judge criteria: fields that do not apply are dropped, the json shape is parsed. */
export function toCriteria(draft) {
  const checks = draft.checks.map((c) => {
    const params = {};
    if (c.kind === "length") {
      if (c.min !== null) params.min = c.min;
      if (c.max !== null) params.max = c.max;
      if (c.unit !== null) params.unit = c.unit;
    } else if (c.kind === "contains") {
      params.all = c.all ?? [];
      if (c.wholeWords !== null) params.wholeWords = c.wholeWords;
    } else if (c.kind === "schema") {
      params.required = c.required ?? [];
      if (c.types?.length) params.types = Object.fromEntries(c.types.map((t) => [t.field, t.type]));
    } else if (c.kind === "json") {
      try { params.shape = JSON.parse(c.shape ?? ""); } catch { throw new AiError(422, `the json check's shape is not valid JSON: ${c.shape}`); }
    }
    return { kind: c.kind, params, weight: c.weight };
  });
  return { version: 1, passThreshold: draft.passThreshold, checks };
}

const textOf = (res) => res.content.filter((b) => b.type === "text").map((b) => b.text).join("");

function refused(res) {
  if (res.stop_reason !== "refusal") return null;
  return new AiError(422, `Claude declined this request${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}`);
}

export function createAi({ client = new Anthropic(), model = MODEL, evaluate = dryRunEvaluate } = {}) {
  /** Draft the checks for a request; one repair turn if the first draft is not valid Judge criteria. */
  async function draftCriteria({ request } = {}) {
    if (typeof request !== "string" || !request.trim() || request.length > 4000) throw new AiError(400, "describe the job in 1 to 4000 characters");
    const messages = [{ role: "user", content: request.trim() }];
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await client.beta.messages.parse({
        model, max_tokens: 16000, ...FALLBACK, system: DRAFTER_SYSTEM, messages,
        output_config: { effort: "medium", format: zodOutputFormat(Draft) },
      });
      const no = refused(res);
      if (no) throw no;
      const draft = res.parsed_output;
      let problem = null;
      if (!draft) problem = "the reply did not match the schema";
      else {
        try { return { ...draft, criteria: checkCriteria(toCriteria(draft)), reasons: draft.checks.map((c) => c.why) }; } catch (e) { problem = e.message; }
      }
      messages.push({ role: "assistant", content: res.content }, { role: "user", content: `That draft cannot be used: ${problem}. Return a corrected draft.` });
    }
    throw new AiError(422, "could not draft valid checks for this request; write them by hand or rephrase the request");
  }

  /** The AI worker: write the deliverable, run the free dry run, revise until it passes or the rounds run out. */
  async function work({ task, criteria, reasons = [], jobId, maxRounds = 3 } = {}) {
    if (typeof task !== "string" || !task.trim()) throw new AiError(400, "the task is empty");
    const listed = criteria.checks.map((c, i) => `- ${c.kind} ${JSON.stringify(c.params)}${reasons[i] ? `: ${reasons[i]}` : ""}`).join("\n");
    const messages = [{ role: "user", content: `Task:\n${task}\n\nChecks your delivery must pass:\n${listed}` }];
    const trace = [];
    let content = "";
    for (let round = 1; round <= maxRounds; round++) {
      const res = await client.beta.messages.create({ model, max_tokens: 16000, ...FALLBACK, system: WORKER_SYSTEM, messages, output_config: { effort: "medium" } });
      const no = refused(res);
      if (no) throw no;
      content = textOf(res).trim();
      const r = await evaluate({ criteria, deliverable: content || " ", jobId });
      if (r.status !== 200) throw new AiError(500, `the dry run could not score the draft: ${r.body.error ?? r.body.reason}`);
      const failed = r.body.results.filter((x) => !x.pass);
      trace.push({ round, score: r.body.score, pass: r.body.pass, failed: failed.map((x) => `${x.kind}: ${x.detail}`) });
      if (r.body.pass) return { content, passed: true, rounds: round, trace };
      messages.push({ role: "assistant", content: res.content },
        { role: "user", content: `These checks did not pass:\n${failed.map((x) => `- ${x.kind}: ${x.detail}`).join("\n")}\nRevise the deliverable so every check passes. Reply with the full deliverable only.` });
    }
    return { content, passed: false, rounds: maxRounds, trace };
  }

  return { draftCriteria, work, model };
}
