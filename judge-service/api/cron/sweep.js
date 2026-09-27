// GET /api/cron/sweep: the daily safety net (Vercel cron). Rules on every
// pending job that names this judge in about the last 58 hours of blocks.
// Only callable with the CRON_SECRET that Vercel's scheduler sends.
import { sweepRecent, SWEEP_LOOKBACK_BLOCKS } from "../../src/judge-now.js";

export function createSweepHandler(deps = {}) {
  const secret = deps.cronSecret !== undefined ? deps.cronSecret : process.env.CRON_SECRET || "";
  return async function handler(req, res) {
    const auth = String((req.headers || {}).authorization || "");
    if (!secret || auth !== `Bearer ${secret}`) { res.status(401).json({ error: "unauthorized" }); return; }
    try {
      const s = await sweepRecent(deps, { lookbackBlocks: SWEEP_LOOKBACK_BLOCKS });
      res.status(200).json(s);
    } catch (e) {
      res.status(502).json({ error: String(e.message || e).slice(0, 300) });
    }
  };
}

export default createSweepHandler();
