import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { authorizationOf, baseUrlFor, createPayPal } from "../src/paypal.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
try { process.loadEnvFile(`${ROOT}/.env`); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (process.env.PAYPAL_ENV !== "sandbox") throw new Error("This runner is restricted to PAYPAL_ENV=sandbox");

const args = process.argv.slice(2);
const command = args[0] ?? "prepare";
if (!["prepare", "settle", "verify"].includes(command)) throw new Error("Use prepare, settle, or verify");
const base = (process.env.JUDGE_PAY_APP_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const baseUrl = new URL(base);
if (baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(baseUrl.hostname)) throw new Error("Use HTTPS for a hosted test");
const statePath = resolve(process.env.JUDGE_PAY_E2E_STATE ?? `${ROOT}/.data/sandbox-e2e.json`);
const paypal = createPayPal({ clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET, baseUrl: baseUrlFor(process.env) });
const open = promisify(execFile);
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const task = "Reconcile these three refund receipts: RCPT-1042 for 12.50 USD, RCPT-1048 for 7.50 USD, and RCPT-1051 for 5.00 USD. Return only JSON with report set to refund_reconciliation, currency, total_refunds, receipt_ids, and a short summary.";
const criteria = { version: 1, passThreshold: 100, checks: [
  { kind: "json", weight: 3, params: { shape: {
    type: "object", additionalProperties: false,
    required: ["report", "currency", "total_refunds", "receipt_ids", "summary"],
    properties: {
      report: { type: "string", enum: ["refund_reconciliation"] },
      currency: { type: "string", enum: ["USD"] },
      total_refunds: { type: "number", enum: [25] },
      receipt_ids: { type: "array", minItems: 3, maxItems: 3, uniqueItems: true, items: { type: "string", enum: ["RCPT-1042", "RCPT-1048", "RCPT-1051"] } },
      summary: { type: "string", minLength: 20, maxLength: 240 },
    },
  } } },
  { kind: "contains", params: { all: ["RCPT-1042", "RCPT-1048", "RCPT-1051"] }, weight: 1 },
  { kind: "length", params: { min: 100, max: 1000, unit: "chars" }, weight: 1 },
] };
const goodDelivery = JSON.stringify({ report: "refund_reconciliation", currency: "USD", total_refunds: 25,
  receipt_ids: ["RCPT-1042", "RCPT-1048", "RCPT-1051"], summary: "Three refunds totaling 25.00 USD are reconciled." }, null, 2);

async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? `App request failed with HTTP ${response.status}`);
  return data;
}

async function loadState() {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function saveState(state) {
  await mkdir(resolve(statePath, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, statePath);
  await chmod(statePath, 0o600);
}

function printable(run, job = null) {
  return {
    kind: run.kind, jobId: run.jobId, orderId: run.orderId,
    status: job?.status ?? "waiting-for-buyer-approval",
    score: job?.verdict?.score,
    authorizationId: job?.paypal?.authorizationId,
    captureId: job?.paypal?.captureId,
    payoutBatchId: job?.paypal?.payoutBatchId,
    payoutStatus: job?.paypal?.payoutItemStatus ?? job?.paypal?.payoutStatus,
    voided: job?.paypal?.voided,
  };
}

async function prepare() {
  let state = await loadState();
  if (args.includes("--new") && state) {
    await rename(statePath, statePath.replace(/\.json$/, `-${Date.now()}-previous.json`));
    state = null;
  }
  const requestedWorker = args.find((arg) => arg.startsWith("--worker="))?.slice("--worker=".length)
    ?? process.env.JUDGE_PAY_WORKER_EMAIL;
  if (!state && !requestedWorker) throw new Error("Provide --worker=YOUR_SANDBOX_WORKER_EMAIL or set JUDGE_PAY_WORKER_EMAIL");
  if (state && requestedWorker && requestedWorker !== state.workerEmail) throw new Error("This run already has a worker. Use --new for a different worker");
  state ??= { version: 1, createdAt: new Date().toISOString(), workerEmail: requestedWorker, jobs: [] };
  if (args.includes("--ai-draft") && state.jobs.length && !state.aiDraft) throw new Error("This run uses fixed checks. Use --new --ai-draft for an AI-drafted run");
  if (args.includes("--ai-draft") && !state.aiDraft) {
    const draft = await api("/api/ai/draft", { request: task });
    state.aiDraft = { model: draft.model, title: draft.title, criteria: draft.criteria };
    await saveState(state);
    console.log(JSON.stringify({ aiDraft: { model: draft.model, title: draft.title, checks: draft.criteria.checks.map((check) => check.kind) } }, null, 2));
  }
  for (const kind of ["pass", "fail"]) {
    let run = state.jobs.find((candidate) => candidate.kind === kind);
    if (!run) {
      const job = await api("/api/jobs", { title: state.aiDraft?.title ?? "Refund reconciliation report", task, criteria: state.aiDraft?.criteria ?? criteria, price: "5.00", workerEmail: state.workerEmail });
      run = { kind, jobId: job.id, workerKey: job.workerAccess.key, orderId: null, approveUrl: null };
      state.jobs.push(run);
      await saveState(state);
    }
    if (!run.orderId) {
      const order = await api(`/api/jobs/${run.jobId}/order`, {});
      run.orderId = order.orderId;
      run.approveUrl = order.approveUrl;
      await saveState(state);
    }
    console.log(JSON.stringify({ kind, jobId: run.jobId, orderId: run.orderId, buyerApprovalUrl: run.approveUrl }, null, 2));
    if (args.includes("--open") && run.approveUrl) await open("open", [run.approveUrl]);
  }
  console.log("Approve both orders with the sandbox buyer. Then run: npm run sandbox:e2e -- settle");
}

async function settle() {
  const state = await loadState();
  if (!state) throw new Error("Run prepare first");
  const useAi = args.includes("--ai");
  if (useAi && !process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) throw new Error("--ai needs OPENROUTER_API_KEY or ANTHROPIC_API_KEY");
  for (const run of state.jobs) {
    let job = await api(`/api/jobs/${run.jobId}`);
    if (["posted", "funding", "funded"].includes(job.status)) {
      const order = await paypal.getOrder(run.orderId);
      if (order.status !== "APPROVED" && !authorizationOf(order)) {
        console.log(JSON.stringify({ ...printable(run, job), buyerApprovalUrl: run.approveUrl }, null, 2));
        continue;
      }
      job = await api(`/api/jobs/${run.jobId}/authorize`, { orderId: run.orderId });
      if (run.kind === "pass" && useAi) {
        const result = await api(`/api/jobs/${run.jobId}/ai-work`, { workerKey: run.workerKey });
        job = result.job;
      } else {
        job = await api(`/api/jobs/${run.jobId}/deliver`, {
          workerKey: run.workerKey,
          content: run.kind === "pass" ? goodDelivery : "This intentionally incorrect delivery does not meet the agreed JSON reconciliation checks.",
        });
      }
    }
    for (let attempt = 0; attempt < 10 && !["paid", "refunded", "failed"].includes(job.status); attempt++) {
      await delay(1000);
      job = await api(`/api/jobs/${run.jobId}`);
    }
    console.log(JSON.stringify(printable(run, job), null, 2));
  }
  console.log("Run independent PayPal checks with: npm run sandbox:e2e -- verify");
}

async function verify() {
  const state = await loadState();
  if (!state) throw new Error("Run prepare first");
  for (const run of state.jobs) {
    const job = await api(`/api/jobs/${run.jobId}`);
    const order = await paypal.getOrder(run.orderId);
    const unit = order.purchase_units?.[0];
    assert.equal(order.intent, "AUTHORIZE");
    assert.equal(unit.reference_id, job.id);
    assert.equal(unit.custom_id, job.criteriaHash);
    assert.equal(unit.amount.value, job.price.value);
    const authorization = await paypal.getAuthorization(job.paypal.authorizationId);
    const receipt = await api(`/api/jobs/${run.jobId}/receipt`);
    if (run.kind === "pass") {
      assert.equal(job.status, "paid");
      assert.equal(authorization.status, "CAPTURED");
      assert.ok(job.paypal.captureId);
      assert.ok(unit.payments?.captures?.some((capture) => capture.id === job.paypal.captureId));
      const payout = await paypal.getPayout(job.paypal.payoutBatchId);
      assert.equal(payout.items?.[0]?.transaction_status, "SUCCESS");
      assert.equal(payout.items?.[0]?.payout_item?.receiver, state.workerEmail);
      assert.equal(payout.items?.[0]?.payout_item?.amount?.value, job.payout.value);
      assert.equal(receipt.decision, "release");
    } else {
      assert.equal(job.status, "refunded");
      assert.equal(authorization.status, "VOIDED");
      assert.equal(job.paypal.captureId, null);
      assert.equal(job.paypal.payoutBatchId, null);
      assert.equal(unit.payments?.captures?.length ?? 0, 0);
      assert.equal(receipt.decision, "refund");
    }
    console.log(JSON.stringify({ ...printable(run, job), verified: true, receiptHash: receipt.receiptHash }, null, 2));
  }
}

try {
  const health = await api("/api/health");
  if (health.environment !== "sandbox" || health.paypal !== "rest") throw new Error("Start the real sandbox server with npm run dev, not the simulator");
  if (command === "prepare") await prepare();
  else if (command === "settle") await settle();
  else await verify();
} catch (error) {
  console.error(`Sandbox test stopped: ${error.message}`);
  process.exitCode = 1;
}
