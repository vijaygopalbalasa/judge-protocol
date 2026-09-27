// POST /api/evaluate  { "criteria": {...}, "deliverable": "text" | "deliverableBase64": "...", "jobId"?: "N" }
//   Dry run: the exact deterministic checks the judge would run, the score and
//   decision, and the evidenceHash it would sign. Never signs, never settles,
//   never makes a network request (http-endpoint checks are reported as not run).
import { dryRunEvaluate, MAX_DELIVERABLE_BYTES } from "../src/evaluate.js";
import { cors, readJsonBody } from "../src/vercel-util.js";

const MAX_REQUEST_BYTES = Math.ceil(MAX_DELIVERABLE_BYTES * 1.4) + 16 * 1024; // base64 + criteria

export function createEvaluateHandler() {
  return async function handler(req, res) {
    try { await handle(req, res); } catch (e) {
      if (!res.headersSent) res.status(503).json({ error: "temporary failure; try again shortly" });
    }
  };
  async function handle(req, res) {
    cors(res);
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "use POST" }); return; }
    const body = readJsonBody(req, MAX_REQUEST_BYTES);
    if (!body.ok) { res.status(body.status).json({ error: body.error }); return; }
    const r = await dryRunEvaluate(body.value, { allowLiveProbes: false });
    res.status(r.status).json(r.body);
  }
}

export default createEvaluateHandler();
