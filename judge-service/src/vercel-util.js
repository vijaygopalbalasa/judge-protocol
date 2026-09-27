// Small helpers shared by the Vercel handlers in ../api (kept outside api/ so
// Vercel does not route them as functions).
import { nestsDeeperThan } from "./checkers/index.js";

export const MAX_BODY_BYTES = 4096;
const MAX_BODY_DEPTH = 64; // far above any real request; checked without recursion

export function cors(res) {
  // Public, credential-free API: any site or agent may call it.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("cache-control", "no-store");
}

/** Parse a JSON body up to `cap` bytes; returns { ok, value } or { ok: false, status, error }. */
export function readJsonBody(req, cap = MAX_BODY_BYTES) {
  const declared = Number((req.headers || {})["content-length"]);
  if (Number.isFinite(declared) && declared > cap) return { ok: false, status: 413, error: "request too large" };
  let b;
  try { b = req.body; } catch { return { ok: false, status: 400, error: "malformed JSON" }; }
  if (b === undefined || b === null || b === "") return { ok: true, value: {} };
  if (typeof b === "string") {
    if (Buffer.byteLength(b) > cap) return { ok: false, status: 413, error: "request too large" };
    try { b = JSON.parse(b); } catch { return { ok: false, status: 400, error: "malformed JSON" }; }
  }
  if (typeof b !== "object" || Array.isArray(b)) return { ok: false, status: 400, error: "expected a JSON object" };
  if (!Number.isFinite(declared)) {
    // No content-length (a chunked request): measure what the platform parsed.
    // Depth first, without recursion, so measuring can never overflow the stack
    // and the answer does not depend on the Node version.
    if (nestsDeeperThan(b, MAX_BODY_DEPTH)) return { ok: false, status: 400, error: "request nests too deeply" };
    if (Buffer.byteLength(JSON.stringify(b)) > cap) return { ok: false, status: 413, error: "request too large" };
  }
  return { ok: true, value: b };
}
