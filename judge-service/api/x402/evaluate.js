// POST /api/x402/evaluate  { "criteria": {...}, "deliverable": "text" | "deliverableBase64": "...", "jobId"?: "N" }
//   The deterministic evaluation of POST /api/evaluate, sold over x402: 0.01 USDC through Circle Gateway on the
//   Arc network this judge runs on (mainnet or testnet). Bad input is answered free; a ready result gets 402 with
//   the terms until a payment-signature header comes with it. Never signs, never settles anything on chain.
import { createPaidEvaluate, networkFor } from "../../src/x402-evaluate.js";
import { PRICE_LABEL } from "../../src/x402.js";
import { MAX_DELIVERABLE_BYTES } from "../../src/evaluate.js";
import { cors, readJsonBody } from "../../src/vercel-util.js";
import { config } from "../../src/config.js";

const MAX_REQUEST_BYTES = Math.ceil(MAX_DELIVERABLE_BYTES * 1.4) + 16 * 1024; // base64 + criteria

export function createX402EvaluateHandler(opts = {}) {
  const chainId = opts.chainId ?? config.chain.id;
  const net = networkFor(chainId);
  let paid; // built on first use
  return async function handler(req, res) {
    try { await handle(req, res); } catch (e) {
      if (!res.headersSent) res.status(503).json({ error: "temporary failure; you were not charged", charged: false });
    }
  };
  async function handle(req, res) {
    cors(res);
    res.setHeader("access-control-allow-headers", "content-type, payment-signature");
    res.setHeader("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (!net) {
      res.status(404).json({ error: `paid evaluations settle through Circle Gateway on Arc; this judge runs on chain ${chainId}, which has no Gateway network here. The free POST /api/evaluate still works`, charged: false });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "use POST {\"criteria\": {...}, \"deliverable\": \"...\"} from an x402 client", charged: false,
        price: `${PRICE_LABEL} per evaluation, settled only once the result is ready`, network: net.network, settlement: "Circle Gateway (batched)",
        free: "POST /api/evaluate", spec: "/api/openapi" });
      return;
    }
    const body = readJsonBody(req, MAX_REQUEST_BYTES);
    if (!body.ok) { res.status(body.status).json({ error: body.error, charged: false }); return; }
    paid ??= createPaidEvaluate({ chainId, ...opts });
    const host = (req.headers || {}).host;
    const resource = opts.resourceUrl ?? (host ? `https://${host}/api/x402/evaluate` : undefined);
    const r = await paid({ input: body.value, paymentHeader: (req.headers || {})["payment-signature"], resource });
    for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
    res.status(r.status).json(r.body);
  }
}

export default createX402EvaluateHandler();
