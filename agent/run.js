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

const here = path.dirname(fileURLToPath(import.meta.url));
const briefPath = process.argv[2] || path.join(here, "briefs/demo.json");
const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
const paymasterKey = process.env.PAYMASTER_KEY || process.env.CLIENT_KEY;
if (!paymasterKey) { console.error("set PAYMASTER_KEY (a funded Arc testnet key) first"); process.exit(1); }

const VERIFIER = "https://judge-protocol-verifier.vercel.app";
const say = (type, d) => {
  const job = d.jobId ? ` job ${d.jobId}` : "";
  const lines = {
    "project-started": () => `project "${d.project}": ${d.milestones} milestones, budget ${d.budget} USDC, contractors ${d.contractors.join(", ")}`,
    "criteria-drafted": () => d.complete ? `[${d.milestoneId}] criteria drafted: ${d.criteria.checks.map((c) => c.kind).join(", ")}` : `[${d.milestoneId}] cannot check: ${JSON.stringify(d.uncovered)}`,
    "contractor-chosen": () => `[${d.milestoneId}] chose ${d.contractor}: ${d.reason}`,
    "decided": () => `[${d.milestoneId}] policy: ${d.decision} (${d.reason})`,
    "job-created": () => `[${d.milestoneId}]${job} created for ${d.contractor} (tx ${d.txHash})`,
    "quoted": () => `[${d.milestoneId}]${job} quoted at the agreed price`,
    "quote-refused": () => `[${d.milestoneId}]${job} ${d.contractor} asked ${d.asked} USDC, agreed ${d.agreed}: not funded`,
    "no-quote": () => `[${d.milestoneId}]${job} ${d.contractor} never quoted: nothing funded`,
    "funded": () => `[${d.milestoneId}]${job} escrow funded`,
    "submitted": () => `[${d.milestoneId}]${job} work submitted`,
    "ruled": () => `[${d.milestoneId}]${job} judge ruled ${d.pass ? "PASS" : "REJECT"} (score ${d.score}); fee ${d.feeCharged ? "paid over x402" : "not charged"}; verify: ${VERIFIER}`,
    "paid": () => `[${d.milestoneId}]${job} escrow released to ${d.contractor}`,
    "refunded": () => `[${d.milestoneId}]${job} escrow refunded to the owner`,
    "reassigned": () => `[${d.milestoneId}] reassigning away from ${d.from}`,
    "verdict-mismatch": () => `STOP: ${d.reason}`,
    "project-finished": () => `done: ${JSON.stringify(d.outcomes)}; paid ${d.totals.paid}, refunded ${d.totals.refunded}, judge fees ${d.totals.fees} USDC`,
  };
  console.log((lines[type] || (() => `${type} ${JSON.stringify(d)}`))());
};

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
