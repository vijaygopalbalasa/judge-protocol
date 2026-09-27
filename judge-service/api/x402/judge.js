// POST /api/x402/judge  { "jobId": "123", "submitTx": "0x..." (optional) }
//   A ruling paid over x402: 0.01 USDC through Circle Gateway on Arc testnet,
//   settled only once the judge has a verdict ready, before it signs. A job it can rule gets
//   402 with the terms until a payment-signature header comes with it; any
//   other job is answered for free. The free POST /api/judge still works.
import { createPaidJudge, PRICE_LABEL, ARC_TESTNET_NETWORK } from "../../src/x402.js";
import { cors, readJsonBody } from "../../src/vercel-util.js";

export function createX402JudgeHandler(opts = {}) {
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
    if (req.method !== "POST") {
      res.status(405).json({ error: "use POST {\"jobId\": \"<id>\"} from an x402 client", charged: false, price: `${PRICE_LABEL} per ruling, settled only once a verdict is ready`,
        network: ARC_TESTNET_NETWORK, settlement: "Circle Gateway (batched)", free: "POST /api/judge (testnet)" });
      return;
    }
    const body = readJsonBody(req);
    if (!body.ok) { res.status(body.status).json({ error: body.error, charged: false }); return; }
    paid ??= createPaidJudge(opts);
    const r = await paid({ jobId: body.value.jobId, submitTx: body.value.submitTx, paymentHeader: (req.headers || {})["payment-signature"] });
    for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
    res.status(r.status).json(r.body);
  }
}

export default createX402JudgeHandler();
