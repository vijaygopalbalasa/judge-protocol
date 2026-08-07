#!/usr/bin/env node
// judge verify <jobId> — independently RECOMPUTE a verdict and check it against
// the on-chain record. This is the point of the whole design: a third party who
// trusts nobody can re-derive the verdict from public inputs and confirm the
// judge did not lie. It uses only public data (the job description on the ACP,
// the deliverable the provider committed) — no access to the judge's server.
//
//   node src/verify.js <jobId> [--evidence path/to/job-*.json]
//
// It:
//   1. reads the job from the canonical ACP (criteria live in the description)
//   2. re-resolves the deliverable and checks it hashes to the committed bytes32
//   3. re-runs the deterministic checkers → recomputes score/pass/threshold
//   4. recomputes evidenceHash over the canonical core
//   5. reads the on-chain verdict and asserts recomputed == recorded

import { createPublicClient, http, keccak256 } from "viem";
import fs from "node:fs";
import { config } from "./config.js";
import { acpAbi, judgeAbi, STATUS } from "./abi.js";
import { extractCriteria, criteriaHash } from "./criteria.js";
import { extractDeliverableURI, resolveDeliverable, evidenceHashOf } from "./evidence.js";
import { runAllChecks } from "./checkers/index.js";

async function main() {
  const jobId = BigInt(process.argv[2] || 0);
  if (!jobId) { console.error("usage: node src/verify.js <jobId> [--evidence file]"); process.exit(2); }
  const evIdx = process.argv.indexOf("--evidence");
  const evFile = evIdx > -1 ? process.argv[evIdx + 1] : null;

  const pub = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
  const ok = (b) => (b ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m");
  let allPass = true;
  const check = (label, cond, extra = "") => { allPass = allPass && cond; console.log(`  ${ok(cond)} ${label}${extra ? "  " + extra : ""}`); };

  console.log(`\nVerifying job ${jobId} on ${config.rpcUrl}`);
  console.log(`  ACP=${config.acpAddress}\n  Judge=${config.judgeAddress}\n`);

  // 1. Read the job + on-chain verdict.
  const job = await pub.readContract({ address: config.acpAddress, abi: acpAbi, functionName: "getJob", args: [jobId] });
  const onchain = await pub.readContract({ address: config.judgeAddress, abi: judgeAbi, functionName: "getVerdict", args: [jobId] });
  if (onchain.timestamp === 0n) { console.error(`No on-chain verdict recorded for job ${jobId}.`); process.exit(1); }
  console.log(`Job status: ${STATUS[Number(job.status)]} · on-chain verdict: ${onchain.pass ? "PASS" : "REJECT"} score=${onchain.score} threshold=${onchain.threshold}\n`);

  // 2. Recompute criteriaHash from the (immutable) job description.
  const criteria = extractCriteria(job.description);
  if (!criteria) { console.error("No judge-criteria block in job description — cannot verify."); process.exit(1); }
  const cHash = criteriaHash(criteria);
  check("criteriaHash recomputed from description matches signed verdict", cHash.toLowerCase() === onchain.criteriaHash.toLowerCase(), `\n      recomputed=${cHash}\n      onchain   =${onchain.criteriaHash}`);

  // 3. Re-resolve deliverable and bind to the on-chain commitment.
  //    (Provider-authored deliverables live in submit optParams; for verification
  //    we accept an explicit --evidence file's URL or the description fallback.)
  let deliverable, resolvedFrom = "description";
  let uri = extractDeliverableURI(job.description);
  if (evFile && fs.existsSync(evFile)) {
    const ev = JSON.parse(fs.readFileSync(evFile, "utf8"));
    // A provider-authored deliverable lives in the submit calldata, recorded in
    // evidence as deliverableURI. The bytes32 commitment below is what makes
    // trusting the evidence file unnecessary: if the recorded URI's content does
    // not hash to the on-chain commitment, verification fails loudly.
    if (ev.deliverableURI) { uri = ev.deliverableURI; resolvedFrom = "evidence.deliverableURI"; }
    else if (ev.deliverableURL) { uri = ev.deliverableURL; resolvedFrom = "evidence.deliverableURL"; }
  }
  if (!uri) { console.error("No deliverable URI found (description or --evidence). Provide --evidence."); process.exit(1); }
  try { deliverable = await resolveDeliverable(uri); }
  catch (e) { console.error(`deliverable resolution failed: ${e.message}`); process.exit(1); }

  const contentHash = keccak256(deliverable.content);
  check(`deliverable content (${resolvedFrom}) hashes to the committed bytes32`, contentHash.toLowerCase() === onchain.deliverable.toLowerCase(), `\n      recomputed=${contentHash}\n      committed =${onchain.deliverable}`);

  // 4. Re-run checkers and recompute the verdict.
  const { results, score, pass, threshold } = await runAllChecks(criteria, deliverable);
  check(`score recomputed = on-chain score`, score === Number(onchain.score), `(recomputed ${score}, onchain ${onchain.score})`);
  check(`threshold recomputed = on-chain threshold`, threshold === Number(onchain.threshold), `(recomputed ${threshold}, onchain ${onchain.threshold})`);
  check(`pass/reject decision matches`, pass === onchain.pass, `(recomputed ${pass}, onchain ${onchain.pass})`);

  // 5. Recompute evidenceHash over the canonical core and compare on-chain.
  const recomputedEvidence = evidenceHashOf({
    jobId: jobId.toString(), criteriaHash: cHash, deliverable: onchain.deliverable,
    criteria, results, score, threshold, pass,
  });
  check("evidenceHash recomputed from inputs = on-chain evidenceHash", recomputedEvidence.toLowerCase() === onchain.evidenceHash.toLowerCase(), `\n      recomputed=${recomputedEvidence}\n      onchain   =${onchain.evidenceHash}`);

  console.log(`\n${allPass ? "\x1b[32mVERDICT VERIFIED — recomputed independently from public inputs.\x1b[0m" : "\x1b[31mVERIFICATION FAILED — recomputation does not match the on-chain record.\x1b[0m"}\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
