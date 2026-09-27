// The decision log is hash-chained, so any edit, deletion or reordering is
// detectable; its head is written into each job description on chain.
import test from "node:test";
import assert from "node:assert/strict";
import { createLedger, verifyLedger } from "../src/ledger.js";

let t = 0;
const clock = () => `2026-09-27T12:00:${String(t++).padStart(2, "0")}Z`;

function sample() {
  t = 0;
  const l = createLedger({ clock });
  l.append("criteria-drafted", { milestoneId: "m1", checks: 2 });
  l.append("funded", { milestoneId: "m1", jobId: 186770n, amount: 50_000n });
  l.append("ruled", { milestoneId: "m1", pass: true, score: 100 });
  return l;
}

test("entries chain by hash and verify", () => {
  const l = sample();
  assert.equal(l.entries.length, 3);
  assert.equal(l.entries[0].prev, "0x" + "0".repeat(64));
  assert.equal(l.entries[1].prev, l.entries[0].hash);
  assert.equal(l.head(), l.entries[2].hash);
  assert.deepEqual(verifyLedger(l.entries), { ok: true, head: l.head() });
  assert.equal(l.entries[1].data.jobId, "186770", "bigints are stored as strings");
});

test("the same history always gives the same head", () => {
  assert.equal(sample().head(), sample().head());
});

test("any edit, deletion, insertion or reordering is detected", () => {
  const edits = {
    "changed amount": (e) => { e[1] = { ...e[1], data: { ...e[1].data, amount: "5000000" } }; },
    "deleted entry": (e) => { e.splice(1, 1); },
    "reordered": (e) => { [e[1], e[2]] = [e[2], e[1]]; },
    "rewritten hash": (e) => { e[2] = { ...e[2], data: { pass: false }, hash: "0x" + "ab".repeat(32) }; },
    "inserted entry": (e) => { e.splice(1, 0, { ...e[1] }); },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const entries = sample().entries.map((x) => ({ ...x }));
    edit(entries);
    const v = verifyLedger(entries);
    assert.equal(v.ok, false, name);
  }
});

test("a log can be restored from its entries and keeps appending", () => {
  const l = sample();
  const again = createLedger({ entries: JSON.parse(JSON.stringify(l.entries)), clock });
  again.append("summary", { paid: 1 });
  assert.equal(verifyLedger(again.entries).ok, true);
  assert.equal(again.entries[3].prev, l.head());
  assert.throws(() => createLedger({ entries: [{ ...l.entries[0], hash: "0x00" }] }), /tampered/);
});
