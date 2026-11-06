// JudgeEvaluatorBaseLayout.sol must be JudgeEvaluator.sol line for line, except the job read. JudgeEvaluator.sol stays
// byte-identical to the deployed, Sourcify-verified contracts, so the layout variant is a copy, and this test makes
// sure the copy never drifts: undo the documented differences and the two files must match exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "src");
const original = fs.readFileSync(path.join(SRC, "JudgeEvaluator.sol"), "utf8");
const variant = fs.readFileSync(path.join(SRC, "JudgeEvaluatorBaseLayout.sol"), "utf8");

function undo(s) {
  const noteStart = s.indexOf("\n/// @dev    JudgeEvaluatorBaseLayout:");
  const noteEnd = s.indexOf("\ncontract JudgeEvaluatorBaseLayout is ");
  assert.ok(noteStart > 0 && noteEnd > noteStart, "the variant's header note is where it should be");
  s = s.slice(0, noteStart) + s.slice(noteEnd);
  s = s.replace("\ncontract JudgeEvaluatorBaseLayout is ", "\ncontract JudgeEvaluator is ");
  const readerStart = s.indexOf("\n    /*//////////////////////////////////////////////////////////////\n                    JOB READ (erc-8183/base-contracts layout)");
  assert.ok(readerStart > 0, "the variant's job reader block is present");
  const close = s.lastIndexOf("}");
  s = s.slice(0, readerStart) + s.slice(close);
  const pairs = [
    ["        (IACP.JobStatus status, address evaluator) = _jobState(jobId);\n        if (evaluator != address(this)) revert NotThisJudge();\n        if (uint8(status) >= uint8(IACP.JobStatus.Submitted)) revert NotOpen();",
     "        IACP.Job memory job = acp.getJob(jobId);\n        if (job.evaluator != address(this)) revert NotThisJudge();\n        if (uint8(job.status) >= uint8(IACP.JobStatus.Submitted)) revert NotOpen();"],
    ["        (IACP.JobStatus status, address evaluator) = _jobState(v.jobId);",
     "        IACP.Job memory job = acp.getJob(v.jobId);"],
    ["        if (status != IACP.JobStatus.Submitted) revert JobNotSubmitted();\n        if (evaluator != address(this)) revert JobNotSubmitted();",
     "        if (job.status != IACP.JobStatus.Submitted) revert JobNotSubmitted();\n        if (job.evaluator != address(this)) revert JobNotSubmitted();"],
  ];
  for (const [from, to] of pairs) {
    assert.equal(s.split(from).length, 2, `exactly one changed read: ${from.split("\n")[0].trim()}`);
    s = s.replace(from, to);
  }
  return s;
}

test("JudgeEvaluatorBaseLayout differs from JudgeEvaluator only in how it reads a job", () => {
  assert.equal(undo(variant).trimEnd(), original.trimEnd());
});

test("the original JudgeEvaluator still reads the published 9-field layout", () => {
  assert.equal(original.split("acp.getJob(").length - 1, 2);
  assert.ok(!original.includes("_jobState"));
});
