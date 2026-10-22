// The OpenAPI 3.1 description of the hosted judge's public endpoints, built from the same constants the handlers
// use, so a listing (Circle's Agent Marketplace asks for one) describes what actually runs. Served by GET /api/openapi.
import { MAX_DELIVERABLE_BYTES } from "./evaluate.js";
import { PRICE_LABEL } from "./x402.js";
import { networkFor } from "./x402-evaluate.js";
import { config } from "./config.js";

const checkKinds = ["length", "contains", "schema", "json", "checksum", "http-endpoint"]; // checkers/index.js PARAM_NAMES

export function openapi({ chainId = config.chain.id, host } = {}) {
  const net = networkFor(chainId);
  const where = net ? net.label : `chain ${chainId}`;
  const criteria = {
    type: "object", required: ["version", "checks"],
    description: "The judge-criteria block: deterministic checks with weights and a pass threshold (docs/CRITERIA.md).",
    properties: {
      version: { type: "integer", const: 1 },
      passThreshold: { type: "integer", minimum: 0, maximum: 100, default: 100 },
      checks: { type: "array", minItems: 1, items: { type: "object", required: ["kind", "params"],
        properties: { kind: { type: "string", enum: checkKinds }, params: { type: "object" }, weight: { type: "integer", minimum: 1, default: 1 } } } },
    },
  };
  const evaluateInput = {
    type: "object", required: ["criteria"],
    description: `Exactly one of deliverable (UTF-8 text) or deliverableBase64 (bytes), at most ${MAX_DELIVERABLE_BYTES} bytes decoded.`,
    properties: { criteria, deliverable: { type: "string" }, deliverableBase64: { type: "string", contentEncoding: "base64" },
      jobId: { type: "string", pattern: "^[0-9]{1,30}$", description: "Optional; only mixed into the evidenceHash." } },
  };
  const result = {
    type: "object",
    properties: {
      dryRun: { type: "boolean", const: true }, valid: { type: "boolean", const: true },
      criteriaHash: { type: "string", description: "keccak256 of the canonical criteria JSON" },
      deliverable: { type: "string", description: "keccak256 of the deliverable bytes" },
      results: { type: "array", items: { type: "object", properties: { kind: { type: "string" }, weight: { type: "integer" }, pass: { type: ["boolean", "null"] }, detail: { type: "string" } } } },
      score: { type: ["integer", "null"], minimum: 0, maximum: 100 }, threshold: { type: "integer" }, pass: { type: ["boolean", "null"] },
      evidenceHash: { type: ["string", "null"], description: "keccak256 of the recomputable verdict core; what the judge signs on chain" },
    },
  };
  const paidResult = { allOf: [result, { type: "object", properties: {
    charged: { oneOf: [{ type: "boolean" }, { type: "string", const: "unknown" }] },
    payment: { type: "object", properties: { amount: { type: "string" }, asset: { type: "string" }, network: { type: "string" }, transaction: { type: ["string", "null"] }, payer: { type: "string" } } },
  } }] };
  const error = { type: "object", properties: { error: { type: "string" } } };
  const paymentRequired = {
    description: `Payment required: ${PRICE_LABEL} through Circle Gateway on ${where}. The PAYMENT-REQUIRED header carries the x402 v2 terms (base64 JSON); the body repeats them.`,
    headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } } },
    content: { "application/json": { schema: { type: "object", properties: { x402Version: { type: "integer", const: 2 }, accepts: { type: "array" }, resource: { type: "object" }, error: { type: "string" } } } } },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Judge Protocol",
      version: "1.1.0",
      description: `A neutral, deterministic evaluator for ERC-8183 agent-job escrow, running on ${where}. Every check is computer-repeatable (length, required terms, JSON shape, schema, checksum, endpoint probe) and every verdict is recomputable from the criteria and the delivered bytes. Source: https://github.com/vijaygopalbalasa/judge-protocol`,
      license: { name: "MIT" },
    },
    servers: host ? [{ url: `https://${host}` }] : [],
    paths: {
      "/api/evaluate": { post: {
        summary: "Evaluate a deliverable against criteria (free, dry run)",
        description: "The exact deterministic checks the judge would run, the score and decision, and the evidenceHash it would sign. Never signs, never settles, never makes a network request (http-endpoint checks are reported as not run and score is null).",
        requestBody: { required: true, content: { "application/json": { schema: evaluateInput } } },
        responses: { 200: { description: "The dry-run result", content: { "application/json": { schema: result } } },
          400: { description: "Bad input", content: { "application/json": { schema: error } } },
          413: { description: "Deliverable too large", content: { "application/json": { schema: error } } },
          422: { description: "Invalid criteria", content: { "application/json": { schema: { type: "object", properties: { valid: { type: "boolean", const: false }, reason: { type: "string" } } } } } } },
      } },
      "/api/x402/evaluate": { post: {
        summary: `Evaluate a deliverable against criteria (${PRICE_LABEL} over x402)`,
        description: `The same evaluation as /api/evaluate, paid per request over x402 (Circle Gateway nanopayments, batched and gasless for the payer) on ${where}. Bad input and criteria that need a live probe are answered free; a ready result gets 402 with the terms until a payment-signature header comes with the request. Only a settled payment gets the result.`,
        requestBody: { required: true, content: { "application/json": { schema: evaluateInput } } },
        parameters: [{ name: "payment-signature", in: "header", required: false, schema: { type: "string" }, description: "x402 v2 payment payload (base64 JSON) accepting the terms from the 402" }],
        responses: { 200: { description: "The result, with the payment receipt; PAYMENT-RESPONSE header on a confirmed settlement",
            headers: { "PAYMENT-RESPONSE": { schema: { type: "string" } } }, content: { "application/json": { schema: paidResult } } },
          402: paymentRequired,
          400: { description: "Bad input, or criteria with live checks (answered free)", content: { "application/json": { schema: error } } },
          503: { description: "Circle Gateway unavailable; nothing charged", content: { "application/json": { schema: error } } } },
      } },
      "/api/judge": {
        post: { summary: "Rule on a Submitted ERC-8183 job that names this judge as evaluator (free)",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" }, submitTx: { type: "string" } } } } } },
          responses: { 200: { description: "judged, already-judged, pending or abstained, with the on-chain verdict when there is one" } } },
        get: { summary: "Read-only status of a job: pending, judged (with the on-chain verdict), or not ours",
          parameters: [{ name: "jobId", in: "query", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "The status" } } },
      },
      "/api/erc8412": { get: { summary: "ERC-8412 preregistration arguments for a job, or the attested package rebuilt from chain data",
        parameters: [{ name: "jobId", in: "query", required: true, schema: { type: "string" } }, { name: "submitTx", in: "query", required: false, schema: { type: "string" } }],
        responses: { 200: { description: "The package" } } } },
      "/api/arcbounty": { get: { summary: "The deterministic score for the latest submission on an ArcBounty bounty (keyless, read-only)",
        parameters: [{ name: "jobId", in: "query", required: true, schema: { type: "string" } }, { name: "network", in: "query", required: true, schema: { type: "string", enum: ["arc-mainnet", "arc-testnet"] } }],
        responses: { 200: { description: "ruled, no-submission or abstained" }, 404: { description: "Not an ArcBounty bounty" }, 503: { description: "Chain or IPFS read failed" } } } },
      "/api/health": { get: { summary: "Who the judge is, whether its signer is authorized on chain, and whether it has gas", responses: { 200: { description: "Public health data; never any key material" } } } },
      "/api/openapi": { get: { summary: "This document", responses: { 200: { description: "OpenAPI 3.1 JSON" } } } },
    },
  };
}
