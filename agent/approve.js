// Record a human approval for a milestone above the approval line.
//   node approve.js briefs/demo.json <milestoneId> --by "<name>" [--note "<why>"]
// The approval is an entry in the same hash-chained log the paymaster reads.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logPathFor, openLog } from "./src/logfile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const [briefPath, milestoneId] = process.argv.slice(2);
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
if (!brief.milestones.some((m) => m.id === milestoneId)) { console.error(`no milestone ${milestoneId} in ${briefPath}`); process.exit(1); }
if (!arg("by")) { console.error('say who approves: --by "<name>"'); process.exit(1); }
const ledger = openLog(logPathFor(brief, path.join(here, "runs")));
const e = ledger.append("approved", { milestoneId, by: arg("by"), note: arg("note") ?? "" });
console.log(`approved ${milestoneId} (entry ${e.seq}, hash ${e.hash})`);
