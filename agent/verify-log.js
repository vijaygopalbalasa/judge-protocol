// Check a paymaster decision log against the chain:
//   node verify-log.js runs/<project>.jsonl
// 1. The hash chain is intact (no entry edited, removed, inserted or moved).
// 2. Every job the log says it created exists on chain, and the log head the
//    job description carries is an earlier entry of this same log.
// 3. Every ruling the log records matches the verdict on chain.
import fs from "node:fs";
import { extractCriteria } from "../kit/judge-kit.js";
import { verifyLedger } from "./src/ledger.js";
import { livePorts } from "./src/ports.js";
import { generatePrivateKey } from "viem/accounts";

const entries = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const chainCheck = verifyLedger(entries);
console.log(chainCheck.ok ? `hash chain intact: ${entries.length} entries, head ${chainCheck.head}` : `BROKEN at entry ${chainCheck.badSeq}: ${chainCheck.reason}`);
if (!chainCheck.ok) process.exit(1);

// Read-only: a throwaway key, never used to sign anything.
const { chain } = livePorts({ paymasterKey: generatePrivateKey(), contractors: new Map() });
const bySeq = new Map(entries.map((e) => [e.hash, e.seq]));
let bad = 0;
for (const e of entries) {
  if (e.type === "job-created") {
    const job = await chain.readJob(e.data.jobId);
    const anchor = (job.description.match(/paymaster log (0x[0-9a-f]{64})/) || [])[1];
    const ok = anchor && bySeq.has(anchor) && bySeq.get(anchor) < e.seq && extractCriteria(job.description);
    console.log(`job ${e.data.jobId}: ${ok ? `anchored at entry ${bySeq.get(anchor)}` : "ANCHOR MISSING OR WRONG"}`);
    if (!ok) bad++;
  }
  if (e.type === "ruled") {
    const v = await chain.readVerdict(e.data.jobId);
    const ok = BigInt(v.timestamp) !== 0n && v.pass === e.data.pass;
    console.log(`job ${e.data.jobId}: log says ${e.data.pass ? "PASS" : "REJECT"}, chain says ${BigInt(v.timestamp) === 0n ? "no verdict" : v.pass ? "PASS" : "REJECT"}${ok ? "" : "  MISMATCH"}`);
    if (!ok) bad++;
  }
}
console.log(bad ? `${bad} problem(s)` : "log and chain agree");
process.exit(bad ? 1 : 0);
