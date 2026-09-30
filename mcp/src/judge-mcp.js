// Judge Protocol as MCP tools: write a checklist, test a delivery against it, read a job, verify a
// ruling, and ask the hosted judge to rule on Arc testnet. Every tool reuses code the rest of the repo
// tests against the judge: web/builder.js (the checklist builder) and web/app.js (the in-browser
// verifier). Inputs are closed sets: a known network, a job id, text or base64. The server contacts only
// the chosen network's Arc RPC and, for ruling requests, the hosted judge; a URL inside a checklist is
// never fetched here, and no file path or address is ever taken from a caller.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const WEB = new URL("../../web/", import.meta.url);
const builder = await import(new URL("builder.js", WEB).href);
const app = await import(new URL("app.js", WEB).href); // pure helpers only: parsing, hashing, validation
const { NETWORKS } = app;
const NETWORK_IDS = Object.keys(NETWORKS);
const RULING_NETWORKS = NETWORK_IDS.filter((n) => NETWORKS[n].judgeApi); // the verifier asks for rulings on these only
const CRITERIA_DOC = new URL("../../docs/CRITERIA.md", import.meta.url);
const VERIFIER = "https://judge-protocol-verifier.vercel.app";
const MAX = builder.MAX_DELIVERABLE_BYTES;

// One verifier instance per network, configured once. web/app.js keeps its network in a module-level
// CFG, so a single shared instance would let overlapping calls on two networks read each other's settings.
const instances = new Map();
function verifierFor(network) {
  if (!instances.has(network)) {
    instances.set(network, import(new URL(`app.js?mcp-network=${network}`, WEB).href).then((m) => {
      const n = NETWORKS[network];
      Object.assign(m.CFG, {
        network, unknownNetwork: null, label: n.label, rpc: n.directRpc, directRpc: n.directRpc, chainId: n.chainId,
        judge: n.judge, hook: n.hook, acp: n.acp, acpLabel: n.acpLabel, explorer: n.explorer, judgeApi: n.judgeApi, knownJobs: n.knownJobs,
      });
      return m;
    }));
  }
  return instances.get(network);
}

/* -------------------------------- results -------------------------------- */
const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] });
const refuse = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const usdc = (units) => {
  const u = BigInt(units);
  const frac = (u % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${u / 1_000_000n}${frac ? `.${frac}` : ""}`;
};
/** A date for a chain timestamp, or null when there is none or no calendar can show it (an expiry can be uint256 max). */
const iso = (seconds) => {
  const ms = Number(seconds) * 1000;
  return ms > 0 && Number.isFinite(ms) && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
};
const verdictOut = (v) => (v && v.timestamp > 0
  ? { pass: v.pass, score: v.score, threshold: v.threshold, criteriaHash: v.criteriaHash, evidenceHash: v.evidenceHash, at: iso(v.timestamp) }
  : null);
const TOO_LARGE = `The judge reads deliveries of at most ${MAX.toLocaleString("en-US")} bytes and would not rule on this one.`;
const MAX_DESCRIPTION = 65_536; // bounds the criteria-block search on a caller's job description
const MAX_TEXT = 4_000_000;
const MAX_BASE64 = 1_400_000;

/** Base64 to bytes, or null when it is not base64 (whitespace is ignored). */
function fromBase64(s) {
  const b64 = s.replace(/\s+/g, "");
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Whether a job description carries a criteria block, and whether the judge would accept it. */
export function checklistState(description) {
  const c = app.extractCriteria(description);
  return { hasChecklist: c !== null, checklistValid: c !== null && app.validateCriteria(c).valid };
}

/* -------------------------------- inputs --------------------------------- */
const network = z.enum(NETWORK_IDS).default("arc-testnet").describe(`Which deployment: ${NETWORK_IDS.join(" or ")}.`);
const jobId = z.union([z.string().regex(/^\s*[0-9]{1,15}\s*$/), z.number().int().positive()]).describe("The ERC-8183 job id, a positive whole number.");
const idOf = (v) => app.parseJobId(String(v));

const field = z.strictObject({
  name: z.string().describe("The field name, exactly as it must appear."),
  type: z.enum(builder.FIELD_TYPES).describe("text, url (a web address), email, email-or-url, number, integer, yes-no (JSON true or false), or one-of."),
  options: z.array(z.string()).optional().describe("For one-of: the exact texts allowed (letter case counts)."),
  required: z.boolean().optional().describe("Default true."),
});
const answers = z.strictObject({
  minWords: z.number().optional().describe("text: fewest words."),
  maxWords: z.number().optional().describe("text: most words."),
  terms: z.array(z.string()).optional().describe("text: words or phrases that must appear, exact letter case."),
  wholeWords: z.boolean().optional().describe("text: match terms as whole words only."),
  count: z.strictObject({ min: z.number().optional(), max: z.number().optional() }).optional().describe("records: fewest and most entries."),
  fields: z.array(field).optional().describe("records and record: the fields of each entry or of the object."),
  uniqueBy: z.strictObject({ field: z.string(), key: z.enum(["domain", "value"]) }).optional()
    .describe('records: no two entries share this field, compared by host name ("domain", web address fields only) or by exact value.'),
  noExtraFields: z.boolean().optional().describe("records and record: refuse fields not listed."),
  sha256: z.string().optional().describe("file: the SHA-256 of the exact file, 64 hex characters."),
  size: z.number().optional().describe("file: its size in bytes, if known (over 1,000,000 the judge could never rule)."),
  url: z.string().optional().describe("endpoint: the address the judge probes once, when it rules."),
  expectStatus: z.number().optional().describe("endpoint: the status it must answer with, 200 to 299 or 400 to 599 (default 200)."),
  bodyIncludes: z.array(z.string()).optional().describe("endpoint: text the reply must include."),
  passThreshold: z.number().optional().describe("0 to 100; the default 100 means every check must pass."),
});

/* --------------------------------- server -------------------------------- */
export function createJudgeServer({ fetchImpl = (...a) => fetch(...a) } = {}) {
  const server = new McpServer(
    { name: "judge-protocol", version: "0.1.0" },
    {
      instructions: "Judge Protocol is a neutral judge for ERC-8183 escrow on Arc. Before work starts, the payer writes what done means "
        + "into the job; the judge runs only checks a computer can repeat, signs the result, and the escrow pays or refunds. "
        + "Write a checklist with judge_build_checklist, try a delivery with judge_check_delivery, read a job with judge_job_status, "
        + "recompute a ruling with judge_verify_ruling, and ask for a ruling on Arc testnet with judge_request_ruling.",
    },
  );

  server.registerTool("judge_build_checklist", {
    title: "Write a checklist",
    description: "Write the acceptance checklist for an ERC-8183 job or a bounty from plain answers, as the checklist builder at "
      + "judge-protocol-verifier.vercel.app/build does. Templates: text (a written answer: minWords, maxWords, terms, wholeWords), "
      + "records (a JSON list: count, fields, uniqueBy, noExtraFields), record (a JSON object: fields, noExtraFields), file (an exact "
      + "file: sha256, size) and endpoint (a live web address: url, expectStatus, bodyIncludes). Returns the job description to paste "
      + "(a summary, then a judge-criteria block), the criteria, their hash, and what they check in plain words. Answers the judge would "
      + "refuse, or that could never pass, are refused with a message saying why. Only checks a computer can repeat: quality and taste "
      + "are out of scope.",
    inputSchema: z.strictObject({
      template: z.enum(builder.TEMPLATES).describe("text, records, record, file or endpoint."),
      answers: answers.describe("The answers for that template; fields for other templates are left out."),
      summary: z.string().max(2000).optional().describe("What the job is, for people; it goes above the checklist."),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ template, answers: a, summary }) => {
    try {
      const criteria = builder.buildCriteria(template, a);
      return json({
        jobDescription: builder.jobDescription(summary ?? "", criteria),
        criteria,
        criteriaHash: app.criteriaHash(criteria),
        plainWords: builder.describe(criteria),
      });
    } catch (e) {
      if (e instanceof builder.BuilderError) return refuse(e.message);
      throw e;
    }
  });

  server.registerTool("judge_check_delivery", {
    title: "Test a delivery (dry run)",
    description: "Dry run: score a delivery against a checklist with a copy of the judge's checks (tests hold it equal to the judge's "
      + "own). Give the criteria, or a job description that carries them, and the delivery as text or base64. Nothing is signed or "
      + "settled. A live web check is not run (only the judge makes it, when it rules), so such a result is marked not final, and a "
      + "delivery over 1,000,000 bytes is refused, as the judge refuses it.",
    inputSchema: z.strictObject({
      // Taken as it arrives, not through a record schema: a record would silently drop a __proto__ member the
      // judge refuses, and the dry run would then pass criteria the judge will never score.
      criteria: z.unknown().optional().describe("The criteria object (the JSON inside a judge-criteria block)."),
      jobDescription: z.string().max(MAX_DESCRIPTION).optional().describe("A job description with a judge-criteria block."),
      deliverable: z.string().max(MAX_TEXT).optional().describe("The delivery as text (UTF-8)."),
      deliverableBase64: z.string().max(MAX_BASE64).optional().describe("The delivery's exact bytes, base64."),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ criteria, jobDescription, deliverable, deliverableBase64 }) => {
    if ((criteria === undefined) === (jobDescription === undefined)) return refuse("Give exactly one of criteria or jobDescription.");
    if ((deliverable === undefined) === (deliverableBase64 === undefined)) return refuse("Give exactly one of deliverable or deliverableBase64.");
    if (criteria !== undefined && (criteria === null || typeof criteria !== "object" || Array.isArray(criteria))) {
      return refuse("criteria must be a JSON object, the one inside a judge-criteria block.");
    }
    const c = criteria ?? app.extractCriteria(jobDescription);
    if (!c) return refuse("The job description has no judge-criteria block the judge can read.");
    const v = app.validateCriteria(c);
    if (!v.valid) return refuse(`The judge would abstain: these criteria are invalid (${v.reason}).`);
    const bytes = deliverable !== undefined ? new TextEncoder().encode(deliverable) : fromBase64(deliverableBase64);
    if (!bytes) return refuse("deliverableBase64 is not valid base64.");
    const r = await builder.dryRun(c, bytes);
    if (r.tooLarge) return json({ final: false, tooLarge: true, pass: null, score: null, bytes: bytes.length, results: [], note: TOO_LARGE });
    return json({
      final: r.final,
      pass: r.pass,
      score: r.score,
      threshold: r.threshold,
      results: r.results.map((x, i) => ({
        check: builder.describeCheck(c.checks[i]), kind: x.kind, pass: x.pass, notRun: x.notRun,
        detail: x.notRun ? "a live web check: only the judge runs it, when it rules" : x.detail,
      })),
      note: r.final
        ? `A dry run: nothing was signed or settled. The judge would rule ${r.pass ? "PASS" : "REJECT"} (score ${r.score}, pass mark ${r.threshold}).`
        : "Not final: this checklist has a live web check, which only the judge runs when it rules.",
    });
  });

  server.registerTool("judge_job_status", {
    title: "Read a job",
    description: "Read an ERC-8183 job and Judge Protocol's verdict straight from Arc, testnet or mainnet: status, parties, budget, "
      + "expiry, whether this judge is the job's evaluator, whether the description carries a checklist, and the verdict if there is one. "
      + "Read only.",
    inputSchema: z.strictObject({ network, jobId }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ network: net, jobId: raw }) => {
    const id = idOf(raw);
    if (id === null) return refuse("jobId must be a positive whole number.");
    const v = await verifierFor(net);
    let job, verdict;
    try {
      [job, verdict] = await Promise.all([v.getJob(id), v.getVerdict(id)]);
    } catch (e) {
      return refuse(`The tool could not read ${NETWORKS[net].label}: ${e.message}`);
    }
    if (!job || /^0x0{40}$/i.test(job.evaluator || "")) return json({ network: net, jobId: String(id), found: false });
    return json({
      network: net,
      jobId: String(id),
      found: true,
      status: job.status,
      client: job.client,
      provider: job.provider,
      evaluator: job.evaluator,
      judgeIsEvaluator: job.evaluator.toLowerCase() === v.CFG.judge.toLowerCase(),
      budgetUsdc: usdc(job.budget),
      expiresAt: iso(job.expiredAt),
      expiresAtSeconds: String(job.expiredAt),
      ...checklistState(job.description),
      verdict: verdictOut(verdict),
      verifier: `${VERIFIER}/?network=${net}`,
    });
  });

  server.registerTool("judge_verify_ruling", {
    title: "Verify a ruling",
    description: "Recompute a Judge Protocol ruling from public chain data with the in-browser verifier's code: re-derive every hash, "
      + "re-run the checks, and compare them with the signed verdict on chain. The outcome is verified, mismatch, unsupported (a live "
      + "web check it cannot replay), incomplete, awaiting (submitted, not ruled yet) or error. A delivery hosted on https or IPFS is "
      + "not fetched: pass its exact bytes as deliverable or deliverableBase64, and they count only if they hash to the provider's "
      + "on-chain commitment. Read only.",
    inputSchema: z.strictObject({
      network,
      jobId,
      deliverable: z.string().max(MAX_TEXT).optional().describe("The delivered text, for a delivery hosted on https or IPFS."),
      deliverableBase64: z.string().max(MAX_BASE64).optional().describe("The delivered bytes, base64, for a delivery hosted on https or IPFS."),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ network: net, jobId: raw, deliverable, deliverableBase64 }) => {
    const id = idOf(raw);
    if (id === null) return refuse("jobId must be a positive whole number.");
    if (deliverable !== undefined && deliverableBase64 !== undefined) return refuse("Give at most one of deliverable or deliverableBase64.");
    const pasted = deliverable !== undefined ? new TextEncoder().encode(deliverable) : deliverableBase64 !== undefined ? fromBase64(deliverableBase64) : undefined;
    if (pasted === null) return refuse("deliverableBase64 is not valid base64.");
    const v = await verifierFor(net);
    const base = { network: net, jobId: String(id), judge: v.CFG.judge };
    let r;
    try {
      r = await v.verifyJob(id, pasted);
    } catch (e) {
      return json({ ...base, outcome: "error", error: `could not read ${NETWORKS[net].label}: ${e.message}` });
    }
    return json({
      ...base,
      outcome: v.outcome(r),
      error: r.error ?? null,
      verdict: verdictOut(r.verdict),
      checks: (r.checks || []).map((c) => ({ id: c.id, label: c.label, ok: c.ok, got: c.got ?? null, want: c.want ?? null })),
      deliverableSource: r.deliverableSource ?? null,
      incomplete: r.incomplete ?? null,
      unsupported: r.unsupported ?? [],
      ...((r.needsDeliverable || ["remote-uri", "no-uri"].includes(r.incomplete?.reason)) && {
        hint: "Pass the delivered bytes as deliverable or deliverableBase64; they count only if they hash to the provider's on-chain commitment.",
      }),
      verifier: `${VERIFIER}/?network=${net}`,
    });
  });

  server.registerTool("judge_request_ruling", {
    title: "Ask the judge to rule (Arc testnet)",
    description: "Ask the hosted judge to rule now on an ERC-8183 job on Arc testnet that names Judge Protocol as its evaluator. If the "
      + "job is submitted and its checklist is valid, the judge signs a verdict and settles the escrow on chain: PASS pays the provider, "
      + "REJECT refunds the client. This is the public endpoint behind the verifier's Ask the judge button. The judge's answer comes back "
      + "as it is: judged, already-judged, abstained with a reason, retry-later, and so on. Arc testnet only.",
    inputSchema: z.strictObject({
      network: z.enum(RULING_NETWORKS).default(RULING_NETWORKS[0]).describe(`Only ${RULING_NETWORKS.join(", ")}.`),
      jobId,
      submitTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional().describe("The provider's submit transaction hash, needed for submissions older than about 4 hours."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ network: net, jobId: raw, submitTx }) => {
    const id = idOf(raw);
    if (id === null) return refuse("jobId must be a positive whole number.");
    const payload = { jobId: String(id), ...(submitTx !== undefined && { submitTx }) };
    let res;
    try {
      res = await fetchImpl(`${NETWORKS[net].judgeApi}/api/judge`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
    } catch (e) {
      return refuse(`The tool could not reach the hosted judge: ${e.message}`);
    }
    const out = await res.json().catch(() => ({}));
    return json({ ...out, network: net, httpStatus: res.status });
  });

  server.registerResource("criteria-reference", "judge://docs/criteria", {
    title: "Acceptance criteria reference",
    description: "Every check kind, parameter and limit the judge reads (docs/CRITERIA.md).",
    mimeType: "text/markdown",
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: readFileSync(CRITERIA_DOC, "utf8") }] }));

  return server;
}
