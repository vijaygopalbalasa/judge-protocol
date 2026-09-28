// GET /api/erc8412?jobId=123[&submitTx=0x...]  (docs/ERC-8412.md)
//   Before the provider submits: the exact preregister() arguments for the job's
//   ERC-8412 criteria document, for the job's client to send to the registry.
//   After the judge attests: the whole package, rebuilt from chain data alone,
//   and our checker's verdict on it. Read-only; needs no keys.
import { erc8412Status } from "../src/erc8412-status.js";
import { findSubmission } from "../src/judge-now.js";
import { makePublicClient } from "../src/signer.js";
import { cors } from "../src/vercel-util.js";

export function createErc8412Handler(deps = {}) {
  return async function handler(req, res) {
    try { await handle(req, res); } catch (e) {
      // A chain read failed (rate limit, RPC outage): temporary, never a crash.
      if (!res.headersSent) res.status(503).json({ result: "retry-later", error: "could not read Arc testnet right now; try again shortly" });
    }
  };
  async function handle(req, res) {
    cors(res);
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (req.method !== "GET") { res.status(405).json({ error: "use GET" }); return; }
    const q = req.query || {};
    const r = await erc8412Status({ jobId: q.jobId, submitTx: q.submitTx },
      { publicClient: deps.publicClient ?? makePublicClient(), findSubmission: deps.findSubmission ?? findSubmission });
    res.status(r.status).json(r.body);
  }
}

export default createErc8412Handler();
