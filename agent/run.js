// Run a project brief on Arc testnet.
//   node run.js briefs/demo.json
// Keys come from the environment: PAYMASTER_KEY (or CLIENT_KEY) for the
// paymaster; demo contractors name their own key variable in the brief.
// The decision log is kept in runs/<project>.jsonl; running again resumes it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProject } from "./src/paymaster.js";
import { livePorts, makePublicClient, makeWallet } from "./src/ports.js";
import { scriptedContractor } from "./src/contractors.js";
import { logPathFor, openLog } from "./src/logfile.js";
import { formatEntry } from "./src/format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const briefPath = process.argv[2] || path.join(here, "briefs/demo.json");
const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
const paymasterKey = process.env.PAYMASTER_KEY || process.env.CLIENT_KEY;
if (!paymasterKey) { console.error("set PAYMASTER_KEY (a funded Arc testnet key) first"); process.exit(1); }

const say = (type, d) => console.log(formatEntry(type, d));

const publicClient = makePublicClient();
const contractors = new Map();
for (const c of brief.contractors) {
  if (!c.demo) continue;
  const key = process.env[c.demo.keyEnv];
  if (!key) { console.error(`demo contractor ${c.name} needs ${c.demo.keyEnv}`); process.exit(1); }
  contractors.set(c.address.toLowerCase(), scriptedContractor({ name: c.name, style: c.demo.style, wallet: makeWallet(key), publicClient, log: (m) => console.log(`    ${m}`) }));
}

const ledger = openLog(logPathFor(brief, path.join(here, "runs")));
const ports = livePorts({ paymasterKey, contractors, publicClient });
const out = await runProject({ brief, ports, ledger, history: brief.historyJobIds ?? [], log: say });
console.log(`log head ${out.ledgerHead} (${ledger.entries.length} entries)`);
if (out.halted) process.exit(2);
