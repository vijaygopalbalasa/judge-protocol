#!/usr/bin/env node
// Live check of the MCP server over stdio, as an MCP client launches it, against Arc itself.
// Read-only apart from one ruling request for a job that is already judged (the judge answers
// "already-judged" or "closed" and does nothing). Not part of `npm test`: it needs the network.
//   cd mcp && node live-check.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "judge-live-check", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./server.js", import.meta.url))] }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const results = [];
const check = async (label, fn, ok) => {
  try {
    const v = await fn();
    results.push([ok(v), label, JSON.stringify(v).slice(0, 140)]);
  } catch (e) {
    results.push([false, label, e.message.slice(0, 140)]);
  }
};

await check("five tools listed", async () => (await client.listTools()).tools.map((t) => t.name), (v) => v.length === 5);
await check("mainnet ruling 16 verifies", () => call("judge_verify_ruling", { network: "arc-mainnet", jobId: "16" }), (v) => v.outcome === "verified" && v.verdict.pass === true);
await check("mainnet ruling 17 verifies (a REJECT)", () => call("judge_verify_ruling", { network: "arc-mainnet", jobId: "17" }), (v) => v.outcome === "verified" && v.verdict.pass === false);
await check("testnet ruling 186819 verifies", () => call("judge_verify_ruling", { network: "arc-testnet", jobId: "186819" }), (v) => v.outcome === "verified");
await check("mainnet job 16 status", () => call("judge_job_status", { network: "arc-mainnet", jobId: 16 }), (v) => v.found && v.judgeIsEvaluator && v.status === "Completed");
await check("mainnet job 18 names ArcBounty's adapter, not this judge", () => call("judge_job_status", { network: "arc-mainnet", jobId: "18" }), (v) => v.found && v.judgeIsEvaluator === false);
await check("build + dry run", async () => {
  const b = await call("judge_build_checklist", { template: "text", answers: { minWords: 3, terms: ["USDC"] } });
  return call("judge_check_delivery", { jobDescription: b.jobDescription, deliverable: "USDC moves through escrow" });
}, (v) => v.final && v.pass === true);
await check("ruling request on an already-judged testnet job changes nothing", () => call("judge_request_ruling", { jobId: "186819" }), (v) => ["already-judged", "closed"].includes(v.result));

await client.close();
for (const [ok, label, info] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  :: ${info}`}`);
process.exit(results.every(([ok]) => ok) ? 0 : 1);
