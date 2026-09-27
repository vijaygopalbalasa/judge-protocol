// Judge Protocol HTTP integration API. Zero new dependencies (node:http).
//
//   GET  /healthz            liveness + watcher state (cursor, last poll)
//   GET  /verdict/:jobId     on-chain verdict readback from JudgeEvaluator
//   GET  /evidence/:jobId    the committed evidence JSON for a judged job
//   POST /evaluate           DRY RUN: score criteria against an inline
//                            deliverable. No signing, no settlement; returns
//                            exactly the score/pass/evidenceHash a real run
//                            would produce for those bytes.
//
// Binds to 127.0.0.1 by default (config.httpHost). The read endpoints expose
// only public on-chain/evidence data; still, put a reverse proxy in front
// before exposing POST /evaluate to the open internet.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http as viemHttp, keccak256 } from "viem";
import { config } from "./config.js";
import { judgeAbi } from "./abi.js";
import { runAllChecks, InvalidCriteriaError } from "./checkers/index.js";
import { criteriaHash } from "./criteria.js";
import { evidenceHashOf } from "./evidence.js";

const MAX_BODY_BYTES = 1_048_576; // 1 MB, same ceiling as deliverable fetches

const jsonify = (obj) => JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v));

function parseJobId(s) {
  return typeof s === "string" && /^\d{1,20}$/.test(s) ? BigInt(s) : null;
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0, overflow = false;
    req.on("data", (c) => {
      if (overflow) return; // discard the rest so the 413 can be sent cleanly
      n += c.length;
      if (n > cap) {
        overflow = true;
        chunks.length = 0;
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => overflow
      ? reject(Object.assign(new Error("body too large"), { statusCode: 413 }))
      : resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Build the API server. deps (all optional, for tests):
 *   publicClient: viem public client for /verdict reads
 *   evidenceDir:  where committed evidence JSON lives
 *   getState:     () => watcher state merged into /healthz
 */
export function createJudgeApi(deps = {}) {
  const evidenceDir = deps.evidenceDir ?? config.evidenceDir;
  const getState = deps.getState ?? (() => ({}));
  let publicClient = deps.publicClient;
  const client = () =>
    (publicClient ??= createPublicClient({ chain: config.chain, transport: viemHttp(config.rpcUrl) }));

  return http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(jsonify(obj));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const [, route, param, extra] = url.pathname.split("/");

      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(200, {
          ok: true,
          chainId: config.chain.id,
          judge: config.judgeAddress || null,
          acp: config.acpAddress,
          ...getState(),
        });
      }

      if (req.method === "GET" && route === "verdict" && !extra) {
        const jobId = parseJobId(param);
        if (jobId === null) return send(400, { error: "jobId must be a positive integer" });
        if (!config.judgeAddress) return send(503, { error: "JUDGE_ADDRESS not configured" });
        const v = await client().readContract({
          address: config.judgeAddress, abi: judgeAbi, functionName: "getVerdict", args: [jobId],
        });
        const timestamp = Number(v.timestamp ?? v[7] ?? 0);
        if (timestamp === 0) return send(404, { error: `no verdict recorded for job ${jobId}` });
        return send(200, {
          jobId: v.jobId ?? v[0],
          criteriaHash: v.criteriaHash ?? v[1],
          deliverable: v.deliverable ?? v[2],
          score: Number(v.score ?? v[3]),
          threshold: Number(v.threshold ?? v[4]),
          pass: Boolean(v.pass ?? v[5]),
          evidenceHash: v.evidenceHash ?? v[6],
          timestamp,
        });
      }

      if (req.method === "GET" && route === "evidence" && !extra) {
        const jobId = parseJobId(param);
        if (jobId === null) return send(400, { error: "jobId must be a positive integer" });
        let files = [];
        try {
          files = fs.readdirSync(evidenceDir)
            .filter((f) => f.startsWith(`job-${jobId}-`) && f.endsWith(".json"));
        } catch { /* evidence dir absent → treated as no evidence */ }
        if (files.length === 0) return send(404, { error: `no evidence stored for job ${jobId}` });
        // Multiple files can exist if a job was re-run; serve the newest.
        const newest = files
          .map((f) => ({ f, mtime: fs.statSync(path.join(evidenceDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0].f;
        res.writeHead(200, { "content-type": "application/json", "x-evidence-file": newest });
        return res.end(fs.readFileSync(path.join(evidenceDir, newest)));
      }

      if (req.method === "POST" && url.pathname === "/evaluate") {
        const raw = await readBody(req, MAX_BODY_BYTES);
        let body;
        try {
          body = JSON.parse(raw.toString("utf8"));
        } catch {
          return send(400, { error: "body must be JSON" });
        }
        const { criteria, deliverable, deliverableBase64 } = body ?? {};
        if (!criteria || typeof criteria !== "object") {
          return send(400, { error: "missing `criteria` object" });
        }
        if (deliverable === undefined && deliverableBase64 === undefined) {
          return send(400, { error: "provide `deliverable` (utf-8 string) or `deliverableBase64`" });
        }
        const content = deliverableBase64 !== undefined
          ? Buffer.from(String(deliverableBase64), "base64")
          : Buffer.from(String(deliverable), "utf8");
        if (content.length > MAX_BODY_BYTES) return send(413, { error: "deliverable too large" });

        const { results, score, pass, threshold } = await runAllChecks(criteria, { content, source: "inline" });
        const cHash = criteriaHash(criteria);
        const commitment = keccak256(content);
        const evidenceHash = evidenceHashOf({
          jobId: String(body.jobId ?? "0"),
          criteriaHash: cHash,
          deliverable: commitment,
          criteria, results, score, threshold, pass,
        });
        return send(200, {
          dryRun: true,
          criteriaHash: cHash,
          deliverable: commitment,
          results, score, threshold, pass, evidenceHash,
        });
      }

      return send(404, {
        error: "not found",
        routes: ["GET /healthz", "GET /verdict/:jobId", "GET /evidence/:jobId", "POST /evaluate"],
      });
    } catch (e) {
      if (e instanceof InvalidCriteriaError) return send(422, { error: `invalid criteria: ${e.message}` });
      if (e.statusCode === 413) return send(413, { error: e.message });
      if (!res.headersSent) return send(500, { error: e.message });
    }
  });
}

// Standalone runner: `npm run api` (watcher not required; read endpoints and
// dry-run evaluation work with no keys configured).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srv = createJudgeApi();
  srv.listen(config.httpPort, config.httpHost, () => {
    console.log(`Judge HTTP API on http://${config.httpHost}:${config.httpPort}`);
  });
}
