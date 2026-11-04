import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CRITERIA = { version: 1, passThreshold: 100, checks: [{ kind: "length", params: { min: 1, max: 20 } }] };

test("the credential-free preview starts and its simulator accepts the browser client's credentials", async (t) => {
  const port = 32_000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ["scripts/local-demo.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 50 && !healthy; attempt++) {
    if (child.exitCode !== null) assert.fail(`preview exited: ${output}`);
    try { healthy = (await fetch(`${base}/api/health`)).ok; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.equal(healthy, true, output);

  const post = async (path, body) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    assert.equal(res.ok, true, JSON.stringify(data));
    return data;
  };
  const job = await post("/api/jobs", { title: "Smoke check", task: "A short delivery", criteria: CRITERIA, price: "1.00", workerEmail: "worker@personal.example.com" });
  const order = await post(`/api/jobs/${job.id}/order`, {});
  const funded = await post(`/api/local/jobs/${job.id}/approve`, { orderId: order.orderId });
  assert.equal(funded.status, "funded");
  assert.ok(funded.paypal.authorizationId);
});
