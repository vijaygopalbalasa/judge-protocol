#!/usr/bin/env node
// Independently recompute a Judge Protocol verdict from public chain data.
//
//   node judge-service/src/verify.js <jobId> [--deliverable <file>] [--evidence <file>] [--rpc <url>] [--probe]
//
// This is a command-line front end over the SAME verification code the
// in-browser verifier runs (web/app.js), so the page and the CLI can never
// disagree. It needs no keys, no .env and no access to the judge's server:
//   1. reads the job and the signed verdict from chain
//   2. checks the criteria are well-formed and hash to the verdict's criteriaHash
//   3. finds the provider's own JobSubmitted log and binds the verdict to the
//      provider's on-chain commitment
//   4. loads the deliverable (provider calldata, else the job description, else
//      --deliverable / --evidence) and checks it hashes to that commitment
//   5. re-runs the deterministic checkers and recomputes score, decision and
//      evidenceHash, and compares them with the on-chain verdict
//
// --deliverable <file>  raw bytes of the deliverable (for https/ipfs deliverables)
// --evidence <file>     a judge evidence JSON; only its deliverableURI is used, as a hint
// --rpc <url>           JSON-RPC endpoint (default: ARC_RPC_URL or https://rpc.testnet.arc.io)
// --network <name>     arc-mainnet: the Arc mainnet judge, the escrow it serves and the public RPC
//                       (default: Arc testnet); --rpc, --judge and --acp still override it
// --judge <address>     the JudgeEvaluator to check against (default: the Arc testnet deployment)
// --acp <address>       the ERC-8183 escrow the job lives on (default: Circle's Arc testnet contract)
// --probe               re-run any http-endpoint probe NOW (the endpoint as it is today,
//                       not as the judge saw it, so it can differ from the verdict)
//
// Exit codes: 0 verified, 1 mismatch or error, 2 usage, 3 incomplete or not replayable.
import fs from "node:fs";

const app = await import(new URL("../../web/app.js", import.meta.url).href);
const { present } = await import(new URL("../../web/present.js", import.meta.url).href);

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : null; };
const jobId = app.parseJobId(argv[0] ?? "");
if (jobId === null) {
  console.error("usage: node judge-service/src/verify.js <jobId> [--deliverable file] [--evidence file] [--rpc url] [--probe]");
  process.exit(2);
}
// Deployments other than the default (Arc testnet). Arc mainnet: JudgeEvaluator (source-verified on
// Sourcify) serving the ERC-8183 reference escrow ArcBounty runs there.
const NETWORKS = {
  "arc-mainnet": { rpc: "https://rpc.mainnet.arc.io", judge: "0xC9de51A6b440D834D05e22d0D500F41Df1B56321",
    acp: "0x64cA39Fc57315D0D488acCaC07c37C6E841CD058" },
};
const network = opt("--network");
if (network !== null && !Object.hasOwn(NETWORKS, network)) {
  console.error(`unknown --network ${network} (known: ${Object.keys(NETWORKS).join(", ")})`);
  process.exit(2);
}
const preset = network === null ? {} : NETWORKS[network];
app.CFG.rpc = opt("--rpc") || preset.rpc || process.env.ARC_RPC_URL || app.CFG.directRpc;
if (preset.judge) app.CFG.judge = preset.judge;
if (preset.acp) app.CFG.acp = preset.acp;
for (const [flag, key] of [["--judge", "judge"], ["--acp", "acp"]]) {
  const value = opt(flag);
  if (value === null) continue;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) { console.error(`${flag} must be an address`); process.exit(2); }
  app.CFG[key] = value;
}

const color = { ok: "\x1b[32m", bad: "\x1b[31m", warn: "\x1b[33m", dim: "\x1b[2m", off: "\x1b[0m" };
const tint = (c, s) => (process.stdout.isTTY ? color[c] + s + color.off : s);

async function deliverableFromArgs() {
  const file = opt("--deliverable");
  if (file) return new Uint8Array(fs.readFileSync(file));
  const ev = opt("--evidence");
  if (!ev) return undefined;
  const uri = JSON.parse(fs.readFileSync(ev, "utf8")).deliverableURI;
  if (!uri) return undefined;
  if (uri.startsWith("data:")) return app.resolveDataUri(uri);
  // A remote URI from an evidence file is only a hint: whatever it returns must
  // still hash to the provider's on-chain commitment to count.
  const { resolveDeliverable } = await import("./evidence.js");
  return new Uint8Array((await resolveDeliverable(uri)).content);
}

async function main() {
  console.log(`\nVerifying job ${jobId}\n  rpc   ${app.CFG.rpc}\n  judge ${app.CFG.judge}\n  acp   ${app.CFG.acp}\n`);
  const r = await app.verifyJob(jobId, await deliverableFromArgs());
  const p = present(r);
  if (p.state === "error") {
    console.log(tint("bad", `ERROR: ${r.error}`));
    return 1;
  }
  const v = r.verdict;
  console.log(`On-chain verdict: ${p.pill}, score ${v.score} / threshold ${v.threshold}\n`);
  for (const c of r.checks) {
    console.log(`  ${c.ok ? tint("ok", "✓") : tint("bad", "✗")} ${c.label}`);
    if (c.got && c.want && c.got !== c.want) console.log(tint("dim", `      recomputed ${c.got}\n      on-chain   ${c.want}`));
  }
  for (const x of r.results || []) {
    console.log(tint("dim", `  ${x.kind}: ${x.unsupported ? "not replayable" : x.pass ? "pass" : "fail"}, ${x.detail}`));
  }
  if (p.sourceText) console.log(`\n${p.sourceText}.`);
  if (p.incompleteText) console.log(`\n${p.incompleteText}`);

  if (argv.includes("--probe") && r.unsupported) {
    const { runCheck } = await import("./checkers/index.js");
    console.log(tint("warn", "\nRe-running the live probe NOW (today's endpoint, not what the judge saw):"));
    for (const c of r.criteria.checks.filter((k) => k.kind === "http-endpoint")) {
      const res = await runCheck(c, { content: Buffer.from(r.deliverable || "", "utf8") });
      console.log(`  http-endpoint: ${res.pass ? "pass" : "fail"}, ${res.detail}`);
    }
  }

  const tone = p.state === "verified" ? "ok" : p.state === "mismatch" ? "bad" : "warn";
  console.log(`\n${tint(tone, p.headline)}: ${p.note}\n`);
  return p.state === "verified" ? 0 : p.state === "mismatch" ? 1 : 3;
}

main().then((code) => process.exit(code), (e) => { console.error(tint("bad", `ERROR: ${e.message}`)); process.exit(1); });
