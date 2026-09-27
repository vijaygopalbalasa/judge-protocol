// The decision log on disk keeps a high-water mark beside it, so a log that
// lost its tail (a truncation or a rollback) is refused instead of trusted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLog } from "../src/logfile.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paymaster-log-")), "p.jsonl");

test("a log that lost its tail is refused", () => {
  const file = tmp();
  const l = openLog(file);
  for (let i = 0; i < 5; i++) l.append("step", { i });
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  fs.writeFileSync(file, lines.slice(0, 3).join("\n") + "\n");
  assert.throws(() => openLog(file), /truncated|rolled back/);
});

test("a log rolled back to a different history of the same length is refused", () => {
  const file = tmp();
  const l = openLog(file);
  l.append("a", { v: 1 }); l.append("b", { v: 2 });
  const other = path.join(path.dirname(file), "other.jsonl");
  const o = openLog(other);
  o.append("a", { v: 1 }); o.append("b", { v: 3 });
  fs.copyFileSync(other, file);
  assert.throws(() => openLog(file), /truncated|rolled back/);
});

test("an intact log reopens and keeps growing", () => {
  const file = tmp();
  const l = openLog(file);
  l.append("a", {}); l.append("b", {});
  const again = openLog(file);
  again.append("c", {});
  assert.equal(openLog(file).entries.length, 3);
});

test("a log belongs to the paymaster that wrote it: another paymaster is refused before anything runs", async () => {
  const { checkLogOwner } = await import("../src/logfile.js");
  const A = "0x5e14c9E5278ee370D764d03d314e92B3d9fFC04F", B = "0xF14F72Ca02c396e4BEbE366b158B7c4418572447";
  const entries = [{ type: "project-started", data: {} }, { type: "job-created", data: { jobId: "186764" } }];
  const readJob = async (id) => { assert.equal(String(id), "186764"); return { client: A }; };
  await assert.rejects(() => checkLogOwner(entries, { readJob, paymaster: B, file: "runs/x.jsonl" }), /runs\/x\.jsonl belongs to paymaster .*own "project" name/);
  await checkLogOwner(entries, { readJob, paymaster: A.toLowerCase(), file: "runs/x.jsonl" }); // the owner, any case
  await checkLogOwner([{ type: "project-started", data: {} }], { readJob: async () => { throw new Error("no read expected"); }, paymaster: B, file: "f" }); // no jobs yet
});
