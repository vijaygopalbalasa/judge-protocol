import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadCursor, saveCursor } from "../src/cursor.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-")), "cursor.json");

test("cursor round-trips a BigInt block number", () => {
  const file = tmp();
  saveCursor(file, 123456789012345678901n);
  assert.equal(loadCursor(file), 123456789012345678901n);
});

test("save overwrites atomically (no .tmp left behind)", () => {
  const file = tmp();
  saveCursor(file, 1n);
  saveCursor(file, 2n);
  assert.equal(loadCursor(file), 2n);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test("missing cursor file loads as null", () => {
  assert.equal(loadCursor(path.join(os.tmpdir(), "nonexistent", "cursor.json")), null);
});

test("corrupt cursor file loads as null (never throws)", () => {
  const file = tmp();
  fs.writeFileSync(file, "{not json");
  assert.equal(loadCursor(file), null);
  fs.writeFileSync(file, JSON.stringify({ block: "-5" }));
  assert.equal(loadCursor(file), null);
  fs.writeFileSync(file, JSON.stringify({ block: 42 })); // number, not string
  assert.equal(loadCursor(file), null);
});
