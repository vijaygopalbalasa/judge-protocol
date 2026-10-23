// The example files the pages load are generated, never hand-edited: they must match scripts/make-examples.js, the
// example receipt must verify against the example delivery, and the sample jobs must hold only public fields.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildExamples, FILES, serialize } from "../scripts/make-examples.js";
import { checkReceipt } from "../public/receipt/check.js";
import { toRows, summarize } from "../public/dashboard/rows.js";
import { publicView } from "../src/escrow.js";

const ex = await buildExamples();

test("the committed example files are exactly what the generator writes (run node scripts/make-examples.js)", () => {
  assert.equal(readFileSync(FILES.receipt, "utf8"), serialize(ex.receipt));
  assert.equal(readFileSync(FILES.delivery, "utf8"), ex.delivery);
  assert.equal(readFileSync(FILES.jobs, "utf8"), serialize(ex.jobs));
});

test("the example receipt verifies in the browser checker against the example delivery", async () => {
  const receipt = JSON.parse(readFileSync(FILES.receipt, "utf8"));
  const out = await checkReceipt(receipt, readFileSync(FILES.delivery));
  assert.equal(out.verified, true, JSON.stringify(out.steps, null, 1));
});

test("the sample jobs cover every state the dashboard shows and carry no private field", () => {
  const jobs = JSON.parse(readFileSync(FILES.jobs, "utf8"));
  assert.deepEqual(jobs.map((j) => j.status), ["paid", "refunded", "captured", "funded", "funding", "posted", "failed"]);
  const text = JSON.stringify(jobs);
  for (const secret of ["personal.example.com", "base64", "worker"]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(jobs.map((j) => Object.keys(j).sort()), jobs.map((j) => Object.keys(publicView(j)).sort()));
  assert.deepEqual(summarize(toRows(jobs)), { jobs: 7, paid: 1, refunded: 1, open: 4, needsAttention: 1, judged: 4, passed: 3, paidOut: "4.75", currency: "USD" });
});
