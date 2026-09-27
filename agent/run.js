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
import { scriptedContractor, checkDemoKeys } from "./src/contractors.js";
import { logPathFor, openLog, checkLogOwner } from "./src/logfile.js";
import { privateKeyToAccount } from "viem/accounts";
import * as kit from "../kit/judge-kit.js";
import { formatEntry } from "./src/format.js";
import { draftWithModel, modelFromEnv } from "./src/llm-drafter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const briefPath = process.argv[2] || path.join(here, "briefs/demo.json");
const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
const paymasterKey = process.env.PAYMASTER_KEY || process.env.CLIENT_KEY;
if (!paymasterKey) { console.error("set PAYMASTER_KEY (a funded Arc testnet key) first"); process.exit(1); }

const say = (type, d) => console.log(formatEntry(type, d));

const publicClient = makePublicClient();
const contractors = new Map();
let demo;
try { demo = checkDemoKeys(brief); } catch (e) { console.error(e.message); process.exit(1); }
for (const { contractor: c, key } of demo) {
  contractors.set(c.address.toLowerCase(), scriptedContractor({ name: c.name, style: c.demo.style, wallet: makeWallet(key), publicClient, log: (m) => console.log(`    ${m}`) }));
}

const logFile = logPathFor(brief, path.join(here, "runs"));
const ledger = openLog(logFile);
try {
  await checkLogOwner(ledger.entries, { file: path.relative(process.cwd(), logFile), paymaster: privateKeyToAccount(paymasterKey).address,
    readJob: (jobId) => publicClient.readContract({ address: kit.ARC_TESTNET.acp, abi: kit.ACP_ABI, functionName: "getJob", args: [BigInt(jobId)] }) });
} catch (e) { console.error(e.message); process.exit(1); }
const ports = livePorts({ paymasterKey, contractors, publicClient });
const llm = modelFromEnv();
console.log(llm ? `criteria: rules first, then ${llm.name} (${llm.model}) for sentences the rules cannot read` : "criteria: rules only (set GEMINI_API_KEY, GROQ_API_KEY or AI_GATEWAY_API_KEY to add a model)");
const draft = llm ? (text) => draftWithModel(text, { chat: llm.chat, model: llm.model }) : undefined;
const out = await runProject({ brief, ports, ledger, history: brief.historyJobIds ?? [], log: say, ...(draft ? { draft } : {}) });
console.log(`log head ${out.ledgerHead} (${ledger.entries.length} entries)`);
if (out.halted) process.exit(2);
