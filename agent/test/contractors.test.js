// The scripted demo contractors: a careful one checks its own draft with the
// judge's dry run and revises before submitting; a sloppy one does not check.
import test from "node:test";
import assert from "node:assert/strict";
import { scriptedContractor } from "../src/contractors.js";
import { dryRunEvaluate } from "../../judge-service/src/evaluate.js";

const criteria = { version: 1, checks: [{ kind: "contains", params: { all: ["ERC-8183", "USDC", "Arc"] } }] };
const milestone = { id: "m1", demoWork: { draft: "ERC-8183 escrow holds USDC.", good: "ERC-8183 escrow on Arc holds USDC.", bad: "Escrow holds money." } };
const localDryRun = async ({ criteria: c, content }) => (await dryRunEvaluate({ criteria: c, deliverable: content })).body;

function fakeKit() {
  const done = [];
  return { done, setBudget: async (a) => done.push(["setBudget", a.amount]), submitDeliverable: async (a) => done.push(["submit", a.content]) };
}

test("careful: a failing draft is revised after the dry run, and only passing work is submitted", async () => {
  const k = fakeKit(), notes = [];
  const c = scriptedContractor({ name: "atlas", style: "careful", wallet: {}, publicClient: {}, dryRun: localDryRun, kit: k, log: (...a) => notes.push(a.join(" ")) });
  const next = await c.onOffer({ jobId: 1n, amount: 50_000n, criteria, milestone });
  await next();
  assert.deepEqual(k.done, [["setBudget", 50_000n], ["submit", milestone.demoWork.good]]);
  assert.ok(notes.some((n) => /dry run failed/.test(n)) && notes.some((n) => /dry run passed/.test(n)), notes.join(" | "));
});

test("careful: if no version passes its own dry run, it does not submit at all", async () => {
  const k = fakeKit();
  const c = scriptedContractor({ name: "atlas", style: "careful", wallet: {}, publicClient: {}, dryRun: localDryRun, kit: k });
  const next = await c.onOffer({ jobId: 1n, amount: 50_000n, criteria, milestone: { id: "m", demoWork: { draft: "nope", good: "still nope" } } });
  await next();
  assert.deepEqual(k.done, [["setBudget", 50_000n]]);
});

test("sloppy: submits the weak version without checking", async () => {
  const k = fakeKit();
  let dryRuns = 0;
  const c = scriptedContractor({ name: "birch", style: "sloppy", wallet: {}, publicClient: {}, dryRun: async () => { dryRuns++; return { pass: true }; }, kit: k });
  const next = await c.onOffer({ jobId: 1n, amount: 50_000n, criteria, milestone });
  await next();
  assert.deepEqual(k.done, [["setBudget", 50_000n], ["submit", milestone.demoWork.bad]]);
  assert.equal(dryRuns, 0);
});
