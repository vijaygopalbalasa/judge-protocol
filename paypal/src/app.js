import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EscrowError, publicView, receiptOf } from "./escrow.js";
import { AiError } from "./ai.js";
import { PayPalError } from "./paypal.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MIME = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...headers,
  });
  res.end(text);
}

async function bodyJson(req, maxBytes) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > maxBytes) {
    req.resume();
    throw new HttpError(413, "the request is too large");
  }
  if (declared > 0 && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    req.resume();
    throw new HttpError(415, "send a JSON request body");
  }
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, "the request is too large");
  if (size === 0) return {};
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "send a JSON request body");
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object expected");
    return body;
  } catch {
    throw new HttpError(400, "the request body is not a valid JSON object");
  }
}

function jobId(path, match) {
  const id = match[1];
  if (!/^[0-9]{6,30}$/.test(id)) throw new HttpError(404, "no such job");
  return id;
}

/**
 * Caps model calls so a stranger on the hosted demo cannot spend the AI budget. The counters are in memory, so on a
 * serverless host each warm instance counts separately: the spend limit on the provider key is the hard backstop.
 */
export function aiLimiter({ perCallerPerHour = 20, perDay = 300, now = () => Date.now() } = {}) {
  const callers = new Map();
  let day = { start: now(), count: 0 };
  return function take(req) {
    const t = now();
    if (t - day.start >= 86_400_000) day = { start: t, count: 0 };
    // Vercel sets x-vercel-forwarded-for and x-real-ip itself; x-forwarded-for is a fallback for other proxies.
    const header = req.headers["x-vercel-forwarded-for"] ?? req.headers["x-real-ip"] ?? req.headers["x-forwarded-for"] ?? "";
    const caller = String(header).split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    let c = callers.get(caller);
    if (!c || t - c.start >= 3_600_000) { c = { start: t, count: 0 }; callers.set(caller, c); }
    if (callers.size > 10_000) callers.delete(callers.keys().next().value); // evict the oldest caller, keep the rest
    if (day.count >= perDay) throw new HttpError(429, "the demo's daily AI limit is reached; write the checks as JSON or try tomorrow");
    if (c.count >= perCallerPerHour) throw new HttpError(429, "AI limit reached for this hour; please try again later");
    c.count++; day.count++;
  };
}

export function createApp({
  escrow, ai = null, clientId = null, environment = "sandbox", local = null,
  publicDir = PUBLIC_DIR, maxBodyBytes = 400_000, logger = console, aiLimits = {}, demoWorkerEmail = null,
} = {}) {
  const takeAi = aiLimiter(aiLimits);
  if (!escrow) throw new Error("createApp needs an escrow");
  const root = resolve(publicDir);

  async function api(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    if (method === "GET" && path === "/api/health") {
      return send(res, 200, { ok: true, service: "judge-pay", environment: local ? "local-preview" : environment, paypal: local ? "simulator" : "rest", ai: Boolean(ai) });
    }
    if (method === "GET" && path === "/api/config") {
      return send(res, 200, {
        clientId, environment, localMode: Boolean(local), demoWorkerEmail,
        ai: Boolean(ai), assistant: local ? "preview" : ai ? (ai.provider ?? "anthropic") : "unconfigured", model: local ? null : ai?.model ?? null,
      });
    }
    if (method === "POST" && path === "/api/ai/draft") {
      if (!ai) throw new HttpError(503, "AI is not configured. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY, or write the checks as JSON.");
      const body = await bodyJson(req, maxBodyBytes);
      takeAi(req);
      return send(res, 200, await ai.draftCriteria(body));
    }
    if (method === "POST" && path === "/api/jobs") {
      const job = await escrow.postJob(await bodyJson(req, maxBodyBytes));
      return send(res, 201, { ...publicView(job), workerAccess: { key: job.deliveryKey } });
    }
    if (method === "GET" && path === "/api/jobs") {
      const jobs = await escrow.list();
      const views = [];
      for (const job of jobs) views.push(publicView(await escrow.sweep(job.id)));
      return send(res, 200, views);
    }

    let match = path.match(/^\/api\/local\/jobs\/([0-9]+)\/approve$/);
    if (local && method === "POST" && match) {
      const id = jobId(path, match);
      const { orderId } = await bodyJson(req, maxBodyBytes);
      local.approve(orderId);
      return send(res, 200, publicView(await escrow.authorize(id, orderId)));
    }

    match = path.match(/^\/api\/jobs\/([0-9]+)\/order$/);
    if (method === "POST" && match) return send(res, 200, await escrow.createOrder(jobId(path, match)));
    match = path.match(/^\/api\/jobs\/([0-9]+)\/authorize$/);
    if (method === "POST" && match) {
      const { orderId } = await bodyJson(req, maxBodyBytes);
      return send(res, 200, publicView(await escrow.authorize(jobId(path, match), orderId)));
    }
    match = path.match(/^\/api\/jobs\/([0-9]+)\/deliver$/);
    if (method === "POST" && match) {
      return send(res, 200, publicView(await escrow.deliver(jobId(path, match), await bodyJson(req, maxBodyBytes))));
    }
    match = path.match(/^\/api\/jobs\/([0-9]+)\/ai-work$/);
    if (method === "POST" && match) {
      if (!ai) throw new HttpError(503, "AI is not configured. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY, or deliver the work manually.");
      const id = jobId(path, match);
      const { workerKey } = await bodyJson(req, maxBodyBytes);
      const job = await escrow.requireDeliveryWorker(id, workerKey);
      takeAi(req);
      const work = await ai.work({ task: job.task, criteria: job.criteria, jobId: job.id });
      if (!work.passed) {
        return send(res, 422, { error: "The AI worker did not pass every agreed check. Nothing was delivered and no money moved.", trace: work.trace, content: work.content, job: publicView(await escrow.get(id)) });
      }
      const done = await escrow.deliver(id, { workerKey, content: work.content });
      return send(res, 200, { job: publicView(done), trace: work.trace });
    }
    match = path.match(/^\/api\/jobs\/([0-9]+)\/delivery$/);
    if (method === "POST" && match) {
      return send(res, 200, await escrow.downloadDelivery(jobId(path, match), await bodyJson(req, maxBodyBytes)));
    }
    match = path.match(/^\/api\/jobs\/([0-9]+)\/receipt$/);
    if (method === "GET" && match) {
      const job = await escrow.sweep(jobId(path, match));
      const receipt = receiptOf(job);
      if (!receipt) throw new HttpError(409, "a receipt exists after the work is judged");
      return send(res, 200, receipt);
    }
    match = path.match(/^\/api\/jobs\/([0-9]+)\/payout-review$/);
    if (method === "POST" && match) {
      return send(res, 200, publicView(await escrow.resolvePayoutReview(jobId(path, match), await bodyJson(req, maxBodyBytes))));
    }
    match = path.match(/^\/api\/jobs\/([0-9]+)$/);
    if (method === "GET" && match) return send(res, 200, publicView(await escrow.sweep(jobId(path, match))));
    throw new HttpError(404, "no such API route");
  }

  async function staticFile(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, "bad URL"); }
    if (pathname === "/") pathname = "/index.html";
    if (pathname === "/job") pathname = "/job.html";
    if (pathname === "/worker") pathname = "/worker.html";
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403, "forbidden");
    let info;
    try { info = await stat(file); } catch { throw new HttpError(404, "not found"); }
    if (!info.isFile()) throw new HttpError(404, "not found");
    const bytes = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream", "content-length": bytes.length,
      "cache-control": extname(file) === ".html" ? "no-store" : "public, max-age=300",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  }

  return async function app(req, res) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    res.setHeader("x-frame-options", "DENY");
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin) {
          let origin;
          try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, "bad request origin"); }
          if (origin.host !== req.headers.host) throw new HttpError(403, "cross-origin API writes are not allowed");
        }
        await api(req, res, url);
      } else await staticFile(req, res, url);
    } catch (error) {
      if (res.headersSent) return res.end();
      const known = error instanceof HttpError || error instanceof EscrowError || error instanceof AiError || error instanceof PayPalError;
      const status = known ? error.status ?? 500 : 500;
      if (!known) logger.error(error);
      send(res, status, { error: known ? error.message : "the server could not complete the request" });
    }
  };
}
