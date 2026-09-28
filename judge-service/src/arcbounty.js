// ArcBounty (github.com/Sofiia7/ARC): bounties settle through an ERC-8183 escrow driven by ArcBounty's
// BountyAdapter, which holds the escrow's client, provider and evaluator roles itself. A bounty's description
// and each submission are files on IPFS (ipfs://Qm... links), and on submission the adapter commits
// keccak256(link) to the escrow.
//
// This module rules on a submission from chain data plus those two files, recomputing every link instead of
// trusting whoever served the bytes: the escrow's JobSubmitted commitment must equal keccak256(link), the
// link's CIDv0 must equal the CIDv0 of the bytes, and the criteria come from the description's one
// judge-criteria block. Scoring is the same deterministic run as every other ruling (dryRunEvaluate). It never
// signs a verdict or moves funds.
//
//   node src/arcbounty.js <jobId> [--network arc-mainnet] [--rpc URL] [--description FILE] [--submission FILE] [--out FILE]

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, parseAbi, parseAbiItem, stringToBytes } from "viem";
import { canonicalize } from "./criteria.js";
import { dryRunEvaluate } from "./evaluate.js";
import { safeFetch } from "./safe-fetch.js";

export const ARCBOUNTY_NETWORKS = {
  "arc-mainnet": {
    chainId: 5042,
    rpc: "https://rpc.mainnet.arc.io",
    adapter: "0x73c617e808ED5c7Ca41413DFC6EE940dDcBb0b8D", // BountyAdapter V4.7, per their contracts/DEPLOYMENTS.md
    escrow: "0x64cA39Fc57315D0D488acCaC07c37C6E841CD058",  // the ERC-8183 escrow the adapter drives
    fromBlock: 21153190n,                                  // the adapter's deployment block
  },
};

// IPFS splits a file larger than one chunk into several blocks under a parent node, and recomputing those
// needs the full DAG layout, so rulings cover single-block files. ArcBounty's files are all far smaller.
export const MAX_SINGLE_BLOCK = 262144;
const APPROVAL_TIMEOUT = 14n * 86400n; // BountyAdapter.APPROVAL_TIMEOUT

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const CIDV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

function base58(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do { const b = Number(v & 0x7fn); v >>= 7n; out.push(v ? b | 0x80 : b); } while (v);
  return Buffer.from(out);
}

// A protobuf field: wire type 0 carries a varint, wire type 2 a length-delimited payload.
function pbField(num, wire, payload) {
  const key = varint((num << 3) | wire);
  return wire === 2 ? Buffer.concat([key, varint(payload.length), payload]) : Buffer.concat([key, varint(payload)]);
}

/** The CIDv0 IPFS gives a file added with its defaults: one dag-pb block holding UnixFS{File, data, size}. */
export function cidV0(bytes) {
  const b = Buffer.from(bytes);
  if (b.length > MAX_SINGLE_BLOCK) {
    throw new Error(`a file of ${b.length} bytes: IPFS splits it into several blocks, which this recompute does not cover`);
  }
  const unixfs = Buffer.concat([pbField(1, 0, 2), b.length ? pbField(2, 2, b) : Buffer.alloc(0), pbField(3, 0, b.length)]);
  const block = pbField(1, 2, unixfs); // PBNode.Data; a single-block file has no links
  const digest = createHash("sha256").update(block).digest();
  return base58(Buffer.concat([Buffer.from([0x12, 0x20]), digest]));
}

/** ipfs://Qm... or a bare CIDv0, as ArcBounty stores links; anything else cannot be recomputed. */
export function parseIpfsLink(link) {
  if (typeof link !== "string" || !link) return { error: "no link" };
  const s = link.startsWith("ipfs://") ? link.slice("ipfs://".length) : link;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return { error: `${link.slice(0, 80)} is not content-addressed: only an IPFS file can be recomputed` };
  if (/^b[a-z2-7]{40,}$/.test(s)) return { error: `${s.slice(0, 20)}... is a CIDv1, and only CIDv0 (what ArcBounty pins) is recomputed here` };
  if (!CIDV0.test(s)) return { error: `${s.slice(0, 60)} is not a CIDv0` };
  return { cid: s };
}

/** What the adapter commits to the escrow on submission: keccak256(abi.encodePacked(link)), the link's characters. */
export function escrowCommitmentOf(link) {
  return keccak256(stringToBytes(link));
}

/** Where the bounty stands in the adapter's lifecycle (reject, withdraw, challenge, finalize, dispute, approve). */
export function reviewerDecision(m, now = BigInt(Math.floor(Date.now() / 1000))) {
  if (!m?.submittedResultHash) return "no-submission";
  if (m.inDispute) return "in-dispute";
  const disputed = BigInt(m.disputeRaisedAt ?? 0) > 0n;
  const rejected = BigInt(m.rejectedAt ?? 0) > 0n;
  if (disputed && m.resolved) return "dispute-resolved";
  if (rejected) return m.resolved ? "rejected" : "rejection-pending"; // the poster can withdraw it, the worker challenge it
  if (m.resolved) return "approved";
  if (BigInt(now) > BigInt(m.submittedAt ?? 0) + APPROVAL_TIMEOUT) return "auto-approvable"; // only approval remains
  return "awaiting-review";
}

// One fenced block that opens and closes on its own lines. Stricter than the general extractor on purpose: a
// description that anyone can read must show exactly the criteria the ruling uses.
const FENCE = /^```judge-criteria[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/** The criteria from a bounty description: exactly one visible judge-criteria block, or an error saying why not. */
export function criteriaFromDescription(bytes) {
  const text = Buffer.from(bytes).toString("utf8");
  if (/^(````|~~~)/m.test(text)) {
    return { error: "the description has a longer code fence (```` or ~~~), and a judge-criteria block must not be nested in one" };
  }
  const blocks = [...text.matchAll(FENCE)];
  if (blocks.length === 0) return { error: "the description has no judge-criteria block (a line of ```judge-criteria, the JSON, then a line of ```)" };
  if (blocks.length > 1) return { error: `the description must hold exactly one judge-criteria block, and it holds ${blocks.length}` };
  const before = text.slice(0, blocks[0].index);
  if (before.lastIndexOf("<!--") > before.lastIndexOf("-->")) {
    return { error: "the judge-criteria block sits inside an HTML comment, where readers of the bounty would not see it" };
  }
  try { return { criteria: JSON.parse(blocks[0][1]) }; } catch { return { error: "the judge-criteria block's JSON does not parse" }; }
}

/** One hash over everything that identifies a ruling on chain, so no field of the document can change unnoticed. */
export function rulingHashOf(g) {
  return keccak256(stringToBytes(canonicalize({
    kind: g.kind, chainId: g.chainId, adapter: String(g.adapter).toLowerCase(), escrow: String(g.escrow).toLowerCase(),
    jobId: String(g.jobId), descriptionCid: g.description?.cid ?? null, submissionCid: g.submission?.cid ?? null,
    escrowCommitment: g.submission?.escrowCommitment ?? null, submittedBlock: g.submittedBlock ?? null, evidenceHash: g.evidenceHash,
  })));
}

const isBytes = (x) => Buffer.isBuffer(x) || x instanceof Uint8Array;
function cidOrError(bytes) {
  try { return { cid: cidV0(bytes) }; } catch (e) { return { error: e.message }; }
}

/**
 * Rule on one submission. Every input that came from outside is checked against the chain before it is used;
 * any link that does not hold means no ruling ("abstained"), never a ruling on other content.
 */
export async function ruleOnSubmission({ network, jobId, descriptionLink, descriptionBytes, submissionLink, submissionBytes,
  escrowCommitment, submittedBlock, decision } = {}) {
  const abstain = (reason) => ({ status: "abstained", reason });
  if (typeof network !== "string" || !Object.hasOwn(ARCBOUNTY_NETWORKS, network)) {
    return abstain(`unknown network "${network}" (known: ${Object.keys(ARCBOUNTY_NETWORKS).join(", ")})`);
  }
  const net = ARCBOUNTY_NETWORKS[network];
  if (!/^[0-9]{1,30}$/.test(String(jobId))) return abstain("jobId must be a positive integer");
  const id = BigInt(jobId).toString();

  const d = parseIpfsLink(descriptionLink);
  if (d.error) return abstain(`description: ${d.error}`);
  const s = parseIpfsLink(submissionLink);
  if (s.error) return abstain(`submission: ${s.error}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(escrowCommitment ?? ""))) {
    return abstain("the escrow shows no commitment for this submission (JobSubmitted not found)");
  }
  if (String(escrowCommitment).toLowerCase() !== escrowCommitmentOf(submissionLink)) {
    return abstain("the escrow's commitment is not keccak256 of the submission link");
  }
  if (!isBytes(descriptionBytes)) return abstain("the description file is missing");
  if (!isBytes(submissionBytes)) return abstain("the submission file is missing");
  const dc = cidOrError(descriptionBytes);
  if (dc.error || dc.cid !== d.cid) return abstain(`the description file does not match its CID${dc.error ? `: ${dc.error}` : ""}`);
  const sc = cidOrError(submissionBytes);
  if (sc.error || sc.cid !== s.cid) return abstain(`the submission file does not match its CID${sc.error ? `: ${sc.error}` : ""}`);

  const c = criteriaFromDescription(descriptionBytes);
  if (c.error) return abstain(c.error);
  const r = await dryRunEvaluate({ criteria: c.criteria, deliverableBase64: Buffer.from(submissionBytes).toString("base64"), jobId: id });
  if (r.status === 422) return abstain(`invalid criteria: ${r.body.reason}`);
  if (r.status !== 200) return abstain(`evaluation refused: ${r.body.error}`);
  if (r.body.score === null) {
    return abstain(`the criteria need a live network probe (${r.body.notRun.join(", ")}), which nobody could recompute later`);
  }
  const b = r.body;
  const ruling = {
    kind: "judge-protocol/arcbounty-ruling@1",
    network, chainId: net.chainId, adapter: net.adapter, escrow: net.escrow, jobId: id,
    submittedBlock: submittedBlock === undefined || submittedBlock === null ? null : String(submittedBlock),
    description: { link: descriptionLink, cid: d.cid, bytes: descriptionBytes.length },
    submission: { link: submissionLink, cid: s.cid, bytes: submissionBytes.length,
      escrowCommitment: String(escrowCommitment).toLowerCase(), contentKeccak: b.deliverable },
    criteria: c.criteria, criteriaHash: b.criteriaHash,
    results: b.results, score: b.score, threshold: b.threshold, pass: b.pass, evidenceHash: b.evidenceHash,
    reviewerDecision: decision ?? null,
    recompute: `node judge-service/src/arcbounty.js ${id} --network ${network}`,
  };
  ruling.rulingHash = rulingHashOf(ruling);
  return { status: "ruled", ruling };
}

/** The first block whose timestamp is at or after `timestamp`, by binary search over [lo, hi]. */
export async function blockAtOrAfter(client, timestamp, lo, hi) {
  let a = BigInt(lo), b = BigInt(hi);
  const t = BigInt(timestamp);
  while (a < b) {
    const mid = (a + b) / 2n;
    const blk = await client.getBlock({ blockNumber: mid });
    if (BigInt(blk.timestamp) < t) a = mid + 1n; else b = mid;
  }
  return a;
}

const ADAPTER_ABI = parseAbi([
  "struct BountyMeta { uint256 jobId; address poster; uint256 reward; uint256 deadline; string ipfsDescHash; string category; string[] tags; uint256 agentId; bool agentOnly; bool humanOnly; address whitelistedProvider; address assignedProvider; string submittedResultHash; uint256 submittedAt; bool isTaken; uint256 rejectedAt; string rejectionReasonHash; bool inDispute; bool resolved; address disputeInitiator; uint256 disputeRaisedAt; string disputeReasonHash; string disputeResponseHash; string disputeRulingHash; bool requireWorkerBond; uint256 workerBond; }",
  "function bounties(uint256 jobId) view returns (BountyMeta)",
]);
const JOB_SUBMITTED = parseAbiItem("event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)");
const WINDOW = 2000n; // blocks either side of the submission time; Arc's public RPC takes up to 10,000

/**
 * The adapter's record for a bounty and the escrow's commitment for its submission, read from the escrow's own
 * JobSubmitted event near the submission time. Only logs from the escrow for this job count; none or more than
 * one gives null (no ruling).
 */
export async function readBounty(client, { adapter, escrow, fromBlock }, jobId) {
  const id = BigInt(jobId);
  const meta = await client.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "bounties", args: [id] });
  let escrowCommitment = null, submittedBlock = null;
  if (meta.submittedResultHash && BigInt(meta.submittedAt ?? 0) > 0n) {
    const head = await client.getBlockNumber();
    const at = await blockAtOrAfter(client, meta.submittedAt, fromBlock, head);
    const logs = (await client.getLogs({ address: escrow, event: JOB_SUBMITTED, args: { jobId: id },
      fromBlock: at > WINDOW ? at - WINDOW : 0n, toBlock: at + WINDOW > head ? head : at + WINDOW }))
      .filter((l) => String(l.address).toLowerCase() === String(escrow).toLowerCase() && BigInt(l.args?.jobId ?? -1n) === id);
    if (logs.length === 1) {
      escrowCommitment = String(logs[0].args.deliverable).toLowerCase();
      submittedBlock = logs[0].blockNumber ?? null;
    }
  }
  return { meta, escrowCommitment, submittedBlock };
}

// Where the files are read from. Any source will do: the bytes are kept only if they recompute to the CID.
// (ipfs.io answers 429 since its Sep 2026 sunset, as evidence.js notes.)
export const IPFS_SOURCES = ["https://arcbounty.app/api/ipfs/read/", "https://gateway.pinata.cloud/ipfs/", "https://ipfs.filebase.io/ipfs/"];
const defaultFetch = (url) => safeFetch(url, { okOnly: true, maxBytes: MAX_SINGLE_BLOCK, timeoutMs: 20000 });

export async function fetchVerified(cid, { sources = IPFS_SOURCES, fetchImpl = defaultFetch } = {}) {
  const tried = [];
  for (const src of sources) {
    try {
      const { content } = await fetchImpl(src + cid);
      if (cidOrError(content).cid === cid) return { bytes: Buffer.from(content), source: src };
      tried.push(`${src}: other bytes`);
    } catch (e) {
      tried.push(`${src}: ${e.message}`);
    }
  }
  throw new Error(`no source served bytes matching ${cid} (${tried.join("; ")})`);
}

const USAGE = "usage: node src/arcbounty.js <jobId> [--network arc-mainnet] [--rpc URL] [--description FILE] [--submission FILE] [--out FILE]";
const OPTIONS = new Set(["--network", "--rpc", "--description", "--submission", "--out"]);

function defaultClient(rpc, chainId, network) {
  return createPublicClient({
    chain: { id: chainId, name: network, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } },
    transport: http(rpc, { retryCount: 3, retryDelay: 1500 }),
  });
}

/** The command line, with its chain client, file source and clock injectable for tests. */
export async function runCli(argv, { makeClient = defaultClient, fetchImpl = defaultFetch, now = () => BigInt(Math.floor(Date.now() / 1000)) } = {}) {
  const opts = { network: "arc-mainnet" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!OPTIONS.has(a)) throw new Error(`unknown option ${a}\n${USAGE}`);
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value\n${USAGE}`);
      opts[a.slice(2)] = argv[++i];
    } else rest.push(a);
  }
  if (rest.length !== 1 || !/^[0-9]{1,30}$/.test(rest[0])) throw new Error(USAGE);
  const jobId = BigInt(rest[0]).toString();
  if (!Object.hasOwn(ARCBOUNTY_NETWORKS, opts.network)) {
    throw new Error(`unknown network "${opts.network}" (known: ${Object.keys(ARCBOUNTY_NETWORKS).join(", ")})`);
  }
  const net = ARCBOUNTY_NETWORKS[opts.network];
  const client = makeClient(opts.rpc || net.rpc, net.chainId, opts.network);
  const chain = Number(await client.getChainId());
  if (chain !== net.chainId) throw new Error(`the RPC serves chain ${chain}, not ${opts.network} (${net.chainId})`);

  const { meta, escrowCommitment, submittedBlock } = await readBounty(client, net, jobId);
  if (/^0x0{40}$/i.test(String(meta.poster))) throw new Error(`job ${jobId} is not an ArcBounty bounty on ${opts.network}`);
  const head = { jobId, network: opts.network };
  const decision = reviewerDecision(meta, now());
  if (decision === "no-submission") return { exitCode: 0, opts, result: { status: "no-submission", ...head } };

  let result;
  try {
    const bytesFor = async (file, link) => {
      if (file) return readFile(file);
      const p = parseIpfsLink(link);
      return p.cid ? (await fetchVerified(p.cid, { fetchImpl })).bytes : Buffer.alloc(0);
    };
    result = await ruleOnSubmission({
      network: opts.network, jobId, decision, escrowCommitment, submittedBlock,
      descriptionLink: meta.ipfsDescHash, descriptionBytes: await bytesFor(opts.description, meta.ipfsDescHash),
      submissionLink: meta.submittedResultHash, submissionBytes: await bytesFor(opts.submission, meta.submittedResultHash),
    });
  } catch (e) {
    result = { status: "abstained", reason: e.message };
  }
  return { exitCode: 0, opts, result: { status: result.status, ...head, ...result } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv.slice(2)).then(async ({ exitCode, opts, result }) => {
    const json = JSON.stringify(result, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
    if (opts.out) await writeFile(opts.out, json + "\n");
    console.log(json);
    process.exitCode = exitCode;
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
