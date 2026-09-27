// The agent's README must describe the code as it is.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const here = (p) => new URL(`../${p}`, import.meta.url);
const README = fs.readFileSync(here("README.md"), "utf8");

test("the README quotes the real test count and points at files that exist", () => {
  const count = fs.readdirSync(here("test")).filter((f) => f.endsWith(".test.js"))
    .reduce((n, f) => n + (fs.readFileSync(here(`test/${f}`), "utf8").match(/^test\(/gm) || []).length, 0);
  assert.match(README, new RegExp(`# ${count} tests, no network`), `README must say ${count} tests`);
  for (const f of README.matchAll(/`((?:src\/)?[a-z-]+\.js)`/g)) assert.ok(fs.existsSync(here(f[1])), `${f[1]} is referenced but missing`);
  assert.ok(fs.existsSync(here("runs/arc-docs-sprint-demo.jsonl")), "the recorded run is in the repo");
  assert.ok(!README.includes("\u2014"), "no em dashes");
});

test("the demo brief is what the README describes, and its contractors are plain testnet addresses", () => {
  const brief = JSON.parse(fs.readFileSync(here("briefs/demo.json"), "utf8"));
  for (const m of brief.milestones) assert.ok(README.includes(m.id), m.id);
  for (const c of brief.contractors) {
    assert.match(c.address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(!JSON.stringify(c).match(/0x[0-9a-fA-F]{64}/), "no key material in the brief");
  }
});
