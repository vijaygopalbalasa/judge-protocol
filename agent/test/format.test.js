// The CLI's one-line summaries: every log entry the paymaster can write must
// format without throwing (amounts are BigInt), and a broken logger must never
// be able to interrupt a payment flow.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { formatEntry } from "../src/format.js";

const TYPES = [...new Set([...fs.readFileSync(new URL("../src/paymaster.js", import.meta.url), "utf8").matchAll(/note\("([a-z-]+)"/g)].map((m) => m[1]))];

test("every entry type the paymaster writes has a readable line, BigInts included", () => {
  assert.ok(TYPES.length >= 15, `found ${TYPES.length} entry types`);
  const sample = { milestoneId: "m1", jobId: 186775n, amount: 20_000n, budget: 20_000n, contractor: "atlas", reason: "r", decision: "allow",
    complete: true, criteria: { checks: [{ kind: "length" }] }, uncovered: [], pass: true, score: 100, feeCharged: true, from: "birch",
    status: "Open", action: "a", project: "p", milestones: 1, contractors: ["atlas"], budgetUSDC: "0.1", totals: { paid: "0", refunded: "0", fees: "0" },
    outcomes: [["m1", "paid"]], asked: "0.1", agreed: "0.05", txHash: "0x" + "1".repeat(64), error: "e" };
  for (const t of TYPES) {
    let line;
    assert.doesNotThrow(() => { line = formatEntry(t, sample); }, t);
    assert.equal(typeof line, "string", t);
    assert.ok(!/\[object Object\]/.test(line), `${t}: ${line}`);
  }
  assert.doesNotThrow(() => formatEntry("some-future-type", { amount: 1n }));
});
