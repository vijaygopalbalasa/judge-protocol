// POST /api/judge  { "jobId": "123", "submitTx": "0x..." (optional) }
//   Ask the judge to rule now on a Submitted job that names it as evaluator.
// GET  /api/judge?jobId=123
//   Read-only status: pending, judged (with the on-chain verdict), or not ours.
import { judgeNow, jobStatus } from "../src/judge-now.js";
import { cors, readJsonBody } from "../src/vercel-util.js";

export function createJudgeHandler(deps = {}) {
  return async function handler(req, res) {
    try { await handle(req, res); } catch (e) {
      // Defense in depth: every known failure is answered above; nothing unexpected becomes a 500.
      if (!res.headersSent) res.status(503).json({ result: "retry-later", error: "temporary failure; try again shortly" });
    }
  };
  async function handle(req, res) {
    cors(res);
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (req.method === "GET") {
      const r = await jobStatus({ jobId: (req.query || {}).jobId }, deps);
      res.status(r.status).json(r.body);
      return;
    }
    if (req.method !== "POST") { res.status(405).json({ error: "use POST to request a ruling, GET to read status" }); return; }
    const body = readJsonBody(req);
    if (!body.ok) { res.status(body.status).json({ error: body.error }); return; }
    const r = await judgeNow({ jobId: body.value.jobId, submitTx: body.value.submitTx }, deps);
    res.status(r.status).json(r.body);
  }
}

export default createJudgeHandler();
