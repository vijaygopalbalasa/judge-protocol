// GET /api/openapi: the OpenAPI 3.1 description of this judge's public endpoints (src/openapi.js).
import { openapi } from "../src/openapi.js";
import { cors } from "../src/vercel-util.js";

export function createOpenapiHandler(opts = {}) {
  return async function handler(req, res) {
    cors(res);
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (req.method !== "GET") { res.status(405).json({ error: "use GET" }); return; }
    res.setHeader("cache-control", "public, max-age=300, s-maxage=300");
    res.status(200).json(openapi({ ...opts, host: opts.host ?? (req.headers || {}).host }));
  };
}

export default createOpenapiHandler();
