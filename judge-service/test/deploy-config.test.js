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
  assert.deepEqual(files.sort(), ["index.html"]);
});

test("the daily cron is configured and points at the sweep", () => {
  const v = JSON.parse(read("vercel.json"));
  assert.ok(v.crons.some((c) => c.path === "/api/cron/sweep"));
});

test("the deploy never uploads tests, logs, evidence, state or env files", () => {
  const ignore = read(".vercelignore").split("\n").map((l) => l.trim());
  for (const p of ["test/", "evidence/", "state/", "*.log", ".env"]) assert.ok(ignore.includes(p), `${p} missing from .vercelignore`);
});
