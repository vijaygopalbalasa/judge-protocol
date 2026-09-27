// The live judge port against the real x402 handler over HTTP (with an
// in-memory chain and Gateway): it pays exactly the judge's price, refuses to
// sign anything else, and is not charged when the job is already judged.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

process.env.EVIDENCE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ports-"));
const { mockChain } = await import("../../judge-service/test/helpers/mock-chain.js");
const { fakeGateway } = await import("../../judge-service/test/helpers/fake-gateway.js");
const { createX402JudgeHandler } = await import("../../judge-service/api/x402/judge.js");
const { livePorts } = await import("../src/ports.js");

const KEY = keccak256(toHex("judge-protocol agent ports test payer"));
const PAYER = privateKeyToAccount(KEY);

function serve(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const vreq = { method: req.method, headers: req.headers, query: {}, body: raw ? JSON.parse(raw) : undefined };
    const vres = { status(c) { res.statusCode = c; return vres; }, json(o) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); return vres; },
      end() { res.end(); return vres; }, setHeader(k, v) { res.setHeader(k, v); } };
    await handler(vreq, vres);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
const judgePort = (api) => livePorts({ paymasterKey: KEY, contractors: new Map(), api, publicClient: {} }).judge;

test("the paymaster pays exactly 0.01 USDC through Gateway and gets the ruling", async () => {
  const m = mockChain({ jobs: [{ id: 501 }, { id: 502, status: "Completed", verdict: { jobId: 502n, criteriaHash: "0x" + "1".repeat(64), deliverable: "0x" + "2".repeat(64), score: 100, threshold: 100, pass: true, evidenceHash: "0x" + "3".repeat(64), timestamp: 9n } }] });
  const gw = fakeGateway({ balances: { [PAYER.address]: 1_000_000n } });
  const { server, url } = await serve(createX402JudgeHandler({ facilitator: gw.facilitator, balanceOf: gw.balanceOf, payTo: "0xf493CF092768a4B7a533359F28Db82B06D259Dc2", deps: { clients: m.clients } }));
  try {
    const judge = judgePort(url);
    const r = await judge.rule({ jobId: 501n });
    assert.equal(r.result, "judged");
    assert.equal(r.pass, true);
    assert.equal(r.payment.charged, true);
    assert.equal(gw.balance(PAYER.address), 990_000n);
    const again = await judge.rule({ jobId: 502n });
    assert.equal(again.result, "already-judged");
    assert.equal(again.payment.charged, false);
    assert.equal(gw.calls.settle.length, 1, "the already-judged job cost nothing");
  } finally { server.close(); }
});

test("a server asking for more than the judge's price gets nothing signed", async () => {
  let paidAttempts = 0;
  const { server, url } = await serve(async (req, res) => {
    if (req.headers["payment-signature"]) { paidAttempts++; res.status(200).json({ result: "judged", pass: true }); return; }
    const terms = { x402Version: 2, resource: { url: "x", mimeType: "application/json", description: "overpriced" }, accepts: [{
      scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "20000",
      payTo: "0xf493CF092768a4B7a533359F28Db82B06D259Dc2", maxTimeoutSeconds: 604900,
      extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" } }] };
    res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(terms)).toString("base64"));
    res.status(402).json({});
  });
  try {
    await assert.rejects(judgePort(url).rule({ jobId: 1n }), /refusing a judge fee of 20000/);
    assert.equal(paidAttempts, 0, "no payment was ever sent");
  } finally { server.close(); }
});
