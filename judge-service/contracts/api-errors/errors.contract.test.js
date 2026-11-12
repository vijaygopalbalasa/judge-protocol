// Contracts for spec api-errors, Requirement 1 (.kiro/specs/api-errors/requirements.md).
// Real HTTP on an ephemeral port, stubbed chain client, no real RPC or key.
// Run: node --test contracts/api-errors/*.contract.test.js
import test from "node:test";
import assert from "node:assert/strict";

// config.js reads env at import time; fix the address so /verdict is reachable.
process.env.JUDGE_ADDRESS = "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD";

const { createJudgeApi } = await import("../../src/http.js");

const SECRET_KEY = "k3y-SECRET-9f8e7d6c";
const SECRET_HOST = "rpc-private.example-provider.test";
const SECRET_URL = `https://${SECRET_HOST}/v2/${SECRET_KEY}`;

async function withApi(deps, fn) {
  const server = createJudgeApi(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// A chain client whose read fails the way viem does: the message carries the RPC URL.
const failingChain = {
  readContract: async () => {
    throw new Error(`HTTP request failed.\n\nURL: ${SECRET_URL}\nRequest body: {"method":"eth_call"}`);
  },
};

// Capture everything written to stderr while fn runs (covers console.error too).
async function captureStderr(fn) {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = function (chunk, ...rest) {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const cb = rest.find((a) => typeof a === "function");
    if (cb) cb();
    return true;
  };
  try {
    const result = await fn();
    return { result, stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

const throwingState = () => {
  throw new Error(`boom talking to ${SECRET_URL}`);
};

test("R1.1 a failing chain read on GET /verdict answers 502 with the fixed body and no upstream detail", async () => {
  await withApi({ publicClient: failingChain }, async (base) => {
    const r = await fetch(`${base}/verdict/7`);
    const text = await r.text();
    assert.equal(r.status, 502);
    assert.deepEqual(JSON.parse(text), { error: "upstream chain read failed" });
    assert.equal(text.includes(SECRET_KEY), false, "response leaks the RPC key");
    assert.equal(text.includes(SECRET_HOST), false, "response leaks the RPC host");
    assert.equal(text.includes("https://"), false, "response leaks a URL");
    assert.equal(text.includes("eth_call"), false, "response leaks upstream error text");
  });
});

test("R1.2 any other unexpected error answers 500 with the fixed body and no error text", async () => {
  await withApi({ getState: throwingState }, async (base) => {
    const r = await fetch(`${base}/healthz`);
    const text = await r.text();
    assert.equal(r.status, 500);
    assert.deepEqual(JSON.parse(text), { error: "internal error" });
    assert.equal(text.includes("boom"), false, "response leaks the error message");
    assert.equal(text.includes(SECRET_KEY), false, "response leaks the RPC key");
  });
});

test("R1.3 both the 502 and the 500 write the full error to stderr", async () => {
  await withApi({ publicClient: failingChain, getState: throwingState }, async (base) => {
    const chain = await captureStderr(async () => {
      const r = await fetch(`${base}/verdict/7`);
      await r.text();
      return r.status;
    });
    assert.ok(chain.stderr.includes(SECRET_URL), "chain read failure did not log the full upstream error to stderr");
    assert.equal(chain.result, 502);

    const internal = await captureStderr(async () => {
      const r = await fetch(`${base}/healthz`);
      await r.text();
      return r.status;
    });
    assert.ok(internal.stderr.includes(`boom talking to ${SECRET_URL}`), "unexpected error was not logged in full to stderr");
    assert.equal(internal.result, 500);
  });
});

test("R1.4 deliberate errors keep their status and message (422, 413, 400)", async () => {
  await withApi({ publicClient: failingChain }, async (base) => {
    const post = (body) =>
      fetch(`${base}/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body });

    // 422: invalid criteria (empty checks)
    let r = await post(JSON.stringify({ criteria: { checks: [] }, deliverable: "x" }));
    assert.equal(r.status, 422);
    let b = await r.json();
    assert.match(b.error, /^invalid criteria: .+/);

    // 413: body over the 1 MB ceiling
    r = await post(Buffer.alloc(1_200_000, "a"));
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: "body too large" });

    // 400: body is not JSON
    r = await post("{not json");
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "body must be JSON" });

    // 400: junk job id (the chain client is never reached)
    r = await fetch(`${base}/verdict/abc`);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "jobId must be a positive integer" });
  });
});
