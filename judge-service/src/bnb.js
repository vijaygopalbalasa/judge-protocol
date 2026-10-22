// BNB Chain (bnbagent-sdk): jobs on BNB's ERC-8183 kernel settle through a router that asks a policy for the verdict.
// With JudgeRouter and JudgeDeterministicPolicy (contracts/src/bnb, docs/BNB.md) the verdict is a signed Judge ruling
// passed as settle's evidence. This module produces that ruling from chain data plus the provider's manifest,
// recomputing every link instead of trusting whoever served the bytes:
//   - the job is Submitted, names the router as evaluator and hook, and the router bound it to the policy;
//   - the deliverable URL comes from the provider's own submit transaction (optParams {"deliverable_url": ...});
//   - the manifest's hash, computed exactly as the SDK computes it (keccak256 of Python-compatible canonical JSON
//     over the manifest's fields), equals the deliverable the kernel recorded, and it names this job and chain;
//   - the criteria come from the one judge-criteria block in the job description (the SDK stores a JSON
//     JobDescription; the block sits in its task or terms text).
// Scoring is the same deterministic run as every other ruling (dryRunEvaluate). Signing is a separate step, under
// the policy's own EIP-712 domain, and nothing here sends a transaction.
//
//   node src/bnb.js <jobId> --network bsc-testnet --router 0x... --policy 0x... [--rpc URL] [--manifest FILE]
//   (with BNB_SIGNER_KEY set, also prints the signed evidence for router.settle)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeFunctionData, encodeAbiParameters, getAddress, hexToString, http, isAddress,
  keccak256, parseAbi, parseAbiItem, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { criteriaBlockText } from "./criteria.js";
import { dryRunEvaluate } from "./evaluate.js";
import { safeFetch } from "./safe-fetch.js";
import { VERDICT_TYPES } from "./signer.js";

export const BNB_NETWORKS = {
  "bsc-mainnet": { chainId: 56, rpc: "https://bsc-dataseed.bnbchain.org", kernel: "0xea4daa3100a767e86fded867729ae7446476eba6" },
  "bsc-testnet": { chainId: 97, rpc: "https://data-seed-prebsc-1-s1.bnbchain.org:8545", kernel: "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de" },
};
const STATUS = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
export const MAX_MANIFEST_BYTES = 512 * 1024;

const kernelAbi = parseAbi([
  "struct Job { uint256 id; address client; address provider; address evaluator; string description; uint256 budget; uint256 expiredAt; uint8 status; address hook; uint256 submittedAt; bytes32 deliverable; }",
  "function getJob(uint256 jobId) view returns (Job)",
  "function submit(uint256 jobId, bytes32 deliverable, bytes optParams)",
]);
const routerAbi = parseAbi(["function jobPolicy(uint256 jobId) view returns (address)"]);
const jobSubmitted = parseAbiItem("event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)");

/**
 * The SDK's canonical JSON (bnbagent canonicalJson): byte-identical to Python's
 * json.dumps(x, sort_keys=True, separators=(",", ":")) with ensure_ascii, so every code point outside space..tilde is
 * escaped as lowercase \uXXXX. Non-finite numbers are refused, as the SDK refuses them.
 */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out = Object.create(null);
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError("canonicalJson: non-finite number");
    return v;
  };
  return JSON.stringify(sort(value)).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** The fields the SDK hashes (DeliverableManifest.toDict), from a manifest as it arrived on the wire. */
export function manifestCore(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("the manifest is not a JSON object");
  if (m.version !== 1) throw new Error(`unsupported manifest version ${JSON.stringify(m.version)}`);
  const r = m.response;
  if (!r || typeof r !== "object" || typeof r.content !== "string") throw new Error("the manifest's response.content is missing or not text");
  const response = { content: r.content };
  if (r.content_type !== undefined) response.content_type = r.content_type;
  return { version: m.version, job_id: m.job_id, chain_id: m.chain_id, contracts: m.contracts, response, metadata: m.metadata ?? {} };
}

/** keccak256 of the manifest exactly as bnbagent-sdk's manifestHash() computes it: the kernel's `deliverable`. */
export function manifestHash(m) {
  return keccak256(stringToBytes(canonicalJson(manifestCore(m))));
}

/** The judge-criteria block of a BNB job description: a JobDescription's task, then its terms (keys sorted), else
 *  the plain text. Exactly one block must be present across them, so the description cannot carry two bars. */
export function criteriaFromBnbDescription(description) {
  const texts = [];
  let parsed = null;
  if (typeof description === "string" && description.trim().startsWith("{")) {
    try { parsed = JSON.parse(description); } catch { parsed = null; }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (typeof parsed.task === "string") texts.push(parsed.task);
    const walk = (v) => {
      if (typeof v === "string") texts.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const k of Object.keys(v).sort()) walk(v[k]);
    };
    walk(parsed.terms);
  } else if (typeof description === "string") {
    texts.push(description);
  }
  const blocks = texts.filter((t) => t.includes("```judge-criteria"));
  if (blocks.length === 0) return { error: "the job description has no judge-criteria block" };
  if (blocks.length > 1 || blocks[0].indexOf("```judge-criteria") !== blocks[0].lastIndexOf("```judge-criteria")) {
    return { error: "the job description has more than one judge-criteria block" };
  }
  const text = criteriaBlockText(blocks[0]);
  if (text === null) return { error: "the judge-criteria block is not closed" };
  try { return { criteria: JSON.parse(text) }; } catch { return { error: "the judge-criteria block is not valid JSON" }; }
}

/** The deliverable URL in the provider's submit optParams (the SDK sends {"deliverable_url": "..."} as UTF-8). */
export function deliverableUrlFromOptParams(optParams) {
  if (!optParams || optParams === "0x") return null;
  let s;
  try { s = hexToString(optParams); } catch { return null; }
  let o;
  try { o = JSON.parse(s); } catch { return null; }
  const u = o?.deliverable_url;
  return typeof u === "string" && /^https:\/\//.test(u) ? u : null;
}

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Rule on one submitted job. Every input from outside is checked against the chain before it is used; any link that
 * does not hold means no ruling ("abstained"), never a ruling on other content.
 */
export async function ruleOnBnbJob({ chainId, jobId, job, router, policy, boundPolicy, manifestBytes, timestamp } = {}) {
  const abstain = (reason) => ({ status: "abstained", reason });
  if (!/^[0-9]{1,30}$/.test(String(jobId))) return abstain("jobId must be a positive integer");
  if (!isAddress(String(router)) || !isAddress(String(policy))) return abstain("router and policy must be addresses");
  if (!job || BigInt(job.id ?? 0) !== BigInt(jobId)) return abstain("no such job on the kernel");
  if (STATUS[Number(job.status)] !== "Submitted") return abstain(`the job is ${STATUS[Number(job.status)] ?? "unknown"}, not Submitted`);
  if (!same(job.evaluator, router) || !same(job.hook, router)) return abstain("the job's evaluator and hook are not this router");
  if (!same(boundPolicy, policy)) return abstain("the router has not bound this job to this policy");
  if (!(manifestBytes instanceof Uint8Array)) return abstain("the manifest is missing");
  if (manifestBytes.length > MAX_MANIFEST_BYTES) return abstain(`the manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);

  let m, mHash;
  try {
    m = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
    mHash = manifestHash(m);
  } catch (e) { return abstain(`the manifest is not a valid bnbagent manifest: ${e.message}`); }
  if (!same(mHash, job.deliverable)) return abstain("the manifest does not hash to the deliverable the kernel recorded");
  if (String(m.job_id) !== String(BigInt(jobId)) || Number(m.chain_id) !== Number(chainId)) {
    return abstain("the manifest names another job or chain");
  }

  const c = criteriaFromBnbDescription(job.description);
  if (c.error) return abstain(c.error);
  const content = Buffer.from(m.response.content, "utf8");
  const r = await dryRunEvaluate({ criteria: c.criteria, deliverableBase64: content.toString("base64"), jobId: String(BigInt(jobId)) });
  if (r.status === 422) return abstain(`invalid criteria: ${r.body.reason}`);
  if (r.status !== 200) return abstain(`evaluation refused: ${r.body.error}`);
  if (r.body.score === null) return abstain(`the criteria need a live network probe (${r.body.notRun.join(", ")}), which nobody could recompute later`);
  const b = r.body;
  const verdict = {
    jobId: BigInt(jobId), criteriaHash: b.criteriaHash, deliverable: mHash, score: b.score, threshold: b.threshold,
    pass: b.pass, evidenceHash: b.evidenceHash, timestamp: BigInt(timestamp ?? Math.floor(Date.now() / 1000)),
  };
  return {
    status: "ruled", verdict,
    ruling: {
      kind: "judge-protocol/bnb-ruling@1", chainId: Number(chainId), kernel: null, router: getAddress(router), policy: getAddress(policy),
      jobId: String(BigInt(jobId)), manifestHash: mHash, contentKeccak: b.deliverable, criteria: c.criteria, criteriaHash: b.criteriaHash,
      results: b.results, score: b.score, threshold: b.threshold, pass: b.pass, evidenceHash: b.evidenceHash,
    },
  };
}

/** The policy's EIP-712 domain: a signature is valid for one policy on one chain only. */
export function policyDomain(chainId, policy) {
  return { name: "JudgeDeterministicPolicy", version: "1", chainId: Number(chainId), verifyingContract: getAddress(policy) };
}

const VERDICT_TUPLE = { type: "tuple", components: VERDICT_TYPES.Verdict };

/** Sign a verdict for the policy and return the bytes to pass as router.settle(jobId, evidence). */
export async function signBnbEvidence(account, { chainId, policy, verdict }) {
  const signature = await account.signTypedData({ domain: policyDomain(chainId, policy), types: VERDICT_TYPES, primaryType: "Verdict", message: verdict });
  return { signature, evidence: encodeAbiParameters([VERDICT_TUPLE, { type: "bytes" }], [verdict, signature]) };
}

// ---------------------------------------------------------------------------------------------------- CLI

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** Everything a ruling needs from chain and storage: the job, the bound policy, the submit tx's deliverable URL. */
export async function readBnbJob(client, { kernel, router }, jobId, { fromBlock } = {}) {
  const job = await client.readContract({ address: kernel, abi: kernelAbi, functionName: "getJob", args: [BigInt(jobId)] });
  const boundPolicy = await client.readContract({ address: router, abi: routerAbi, functionName: "jobPolicy", args: [BigInt(jobId)] });
  let url = null;
  if (STATUS[Number(job.status)] === "Submitted" && job.submittedAt > 0n) {
    const head = await client.getBlockNumber();
    const logs = await client.getLogs({ address: kernel, event: jobSubmitted, args: { jobId: BigInt(jobId) },
      fromBlock: fromBlock ?? (head > 50_000n ? head - 50_000n : 0n), toBlock: head });
    const last = logs.at(-1);
    if (last) {
      const tx = await client.getTransaction({ hash: last.transactionHash });
      try {
        const { functionName, args } = decodeFunctionData({ abi: kernelAbi, data: tx.input });
        if (functionName === "submit" && args[0] === BigInt(jobId)) url = deliverableUrlFromOptParams(args[2]);
      } catch { url = null; } // submitted through a wallet or a batch: the URL is not in plain calldata
    }
  }
  return { job, boundPolicy, url };
}

export async function runCli(argv, { makeClient, fetchImpl, now = () => Math.floor(Date.now() / 1000), signerKey = process.env.BNB_SIGNER_KEY } = {}) {
  const jobId = argv.find((a) => /^[0-9]+$/.test(a));
  const network = arg(argv, "--network") ?? "bsc-testnet";
  const net = BNB_NETWORKS[network];
  if (!jobId || !net) return { status: "abstained", reason: `usage: bnb.js <jobId> --network ${Object.keys(BNB_NETWORKS).join("|")} --router 0x.. --policy 0x..` };
  const router = arg(argv, "--router"), policy = arg(argv, "--policy");
  if (!isAddress(String(router)) || !isAddress(String(policy))) return { status: "abstained", reason: "--router and --policy are required addresses" };
  const client = makeClient ? makeClient(net, arg(argv, "--rpc")) : createPublicClient({ transport: http(arg(argv, "--rpc") ?? net.rpc) });
  const { job, boundPolicy, url } = await readBnbJob(client, { kernel: net.kernel, router }, jobId);
  let manifestBytes;
  const file = arg(argv, "--manifest");
  if (file) manifestBytes = new Uint8Array(await readFile(file));
  else if (url) {
    try { manifestBytes = new Uint8Array((await safeFetch(url, { okOnly: true, maxBytes: MAX_MANIFEST_BYTES, ...(fetchImpl ? { fetchImpl } : {}) })).content); }
    catch (e) { return { status: "abstained", reason: `could not fetch the manifest at ${url}: ${e.message}` }; }
  } else return { status: "abstained", reason: "no deliverable URL in the provider's submit transaction; pass --manifest FILE" };
  const r = await ruleOnBnbJob({ chainId: net.chainId, jobId, job, router, policy, boundPolicy, manifestBytes, timestamp: now() });
  if (r.status !== "ruled") return r;
  r.ruling.kernel = net.kernel;
  r.ruling.manifestUrl = url ?? null;
  if (signerKey) r.settle = { router, ...(await signBnbEvidence(privateKeyToAccount(signerKey), { chainId: net.chainId, policy, verdict: r.verdict })) };
  return r;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = await runCli(process.argv.slice(2));
  console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.exit(out.status === "ruled" ? 0 : 2);
}
