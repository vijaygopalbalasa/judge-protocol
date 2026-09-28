// What the hosted judge deploys and serves. Static exposure is an allowlist:
// only public/ is served as files; functions live in api/ and bundle their own
// imports, so the source tree is not browsable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("vercel.json serves only public/ as static files", () => {
  const v = JSON.parse(read("vercel.json"));
  assert.equal(v.outputDirectory, "public");
  const files = fs.readdirSync(new URL("../public/", import.meta.url));
  assert.deepEqual(files.sort(), ["index.html", "mainnet.html"]); // the Arc testnet and Arc mainnet landing pages, nothing else
});

test("the daily cron is configured and points at the sweep", () => {
  const v = JSON.parse(read("vercel.json"));
  assert.ok(v.crons.some((c) => c.path === "/api/cron/sweep"));
});

test("the deploy never uploads tests, logs, evidence, state or env files", () => {
  const ignore = read(".vercelignore").split("\n").map((l) => l.trim());
  for (const p of ["test/", "evidence/", "state/", "*.log", ".env"]) assert.ok(ignore.includes(p), `${p} missing from .vercelignore`);
});

test("the ERC-8412 registry and attestor are real addresses, and health tells integrators which to name", async () => {
  const { config } = await import("../src/config.js");
  assert.match(config.erc8412Registry, /^0x[0-9a-fA-F]{40}$/);
  assert.match(config.erc8412Attestor, /^0x[0-9a-fA-F]{40}$/, "never a placeholder");
  const { createHealthHandler } = await import("../api/health.js");
  const res = { code: 0, payload: undefined, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { this.payload = o; return this; }, end() { return this; } };
  await createHealthHandler({ makeClients: () => { throw new Error("no keys here"); } })({ method: "GET", headers: {} }, res);
  assert.deepEqual(res.payload.erc8412, { registry: config.erc8412Registry, attestor: config.erc8412Attestor });
});

test("ERC-8412 attestation defaults on only for Arc testnet, where its registry and attestor exist", async () => {
  const { spawnSync } = await import("node:child_process");
  const load = (env) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e",
    "const { config } = await import('./src/config.js'); console.log(JSON.stringify({ r: config.erc8412Registry, a: config.erc8412Attestor, chain: config.chain.id }))"],
    { cwd: new URL("..", import.meta.url), env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }).stdout);
  const testnet = load({});
  assert.equal(testnet.chain, 5042002);
  assert.match(testnet.a, /^0x78E87A8E/, "testnet keeps its attestor");
  const mainnet = load({ CHAIN_ID: "5042", ARC_RPC_URL: "https://rpc.mainnet.arc.io" });
  assert.equal(mainnet.chain, 5042);
  assert.equal(mainnet.a, "", "no attestor on a chain where JudgeAttestor is not deployed");
  assert.equal(mainnet.r, "");
  const explicit = load({ CHAIN_ID: "5042", ARC_RPC_URL: "https://rpc.mainnet.arc.io", ERC8412_ATTESTOR: "0x0000000000000000000000000000000000000001" });
  assert.equal(explicit.a, "0x0000000000000000000000000000000000000001", "an explicit setting still wins");
});
