// Judge Protocol kit: plug a neutral, deterministic judge into an ERC-8183 job
// on Arc testnet. One file, one dependency (viem). It is not on npm: copy it
// into your project.
//
//   client:   createJudgedJob -> fundJob
//   provider: setBudget -> dryRun (optional self-check) -> submitDeliverable
//   anyone:   requestRuling (the judge settles the escrow) -> waitForRuling
//
// The ruling is a pure function of the criteria committed in the job and the
// deliverable the provider committed to on chain, so anyone can recompute it:
// https://judge-protocol-verifier.vercel.app
import { decodeEventLog, encodeAbiParameters, isAddress, keccak256, toHex } from "viem";

export const ARC_TESTNET = {
  chainId: 5042002,
  rpc: "https://rpc.testnet.arc.io",
  acp: "0x0747EEf0706327138c69792bF28Cd525089e4583",   // Circle's ERC-8183 (AgenticCommerce) on Arc testnet
  judge: "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD", // JudgeEvaluator
  usdc: "0x3600000000000000000000000000000000000000",  // USDC (ERC-20 view, 6 decimals)
  api: "https://judge-protocol-api.vercel.app",
  feeAddress: "0xf493CF092768a4B7a533359F28Db82B06D259Dc2", // where paid rulings (x402) are credited
  verifier: "https://judge-protocol-verifier.vercel.app",
  erc8412Registry: "0x48c3a1812F2dFc762a80dbD5c65e9C7B0BB25ae4", // ERC-8412 reference registry
  erc8412Attestor: "0x78E87A8E43e8E2784C12bF39eB6e2ea7C990fB15",             // JudgeAttestor, the verifier to name
};

const ZERO = "0x0000000000000000000000000000000000000000";
// Inline data: deliverables travel in calldata; keep them small. Larger work
// belongs at an https:// or ipfs:// URI the provider controls.
export const MAX_INLINE_BYTES = 48 * 1024;
// A hosted deliverable is fetched once by the judge: at most 1 MB, within 5
// seconds, no redirects, public addresses only.
export const MAX_HOSTED_BYTES = 1_000_000;
export const MIN_EXPIRY_SECONDS = 600;

export const ACP_ABI = [
  { name: "createJob", type: "function", stateMutability: "nonpayable", inputs: [{ name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "expiredAt", type: "uint256" }, { name: "description", type: "string" }, { name: "hook", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "setBudget", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "fund", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "submit", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "deliverable", type: "bytes32" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "getJob", type: "function", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [{ type: "tuple", components: [{ name: "id", type: "uint256" }, { name: "client", type: "address" }, { name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "description", type: "string" }, { name: "budget", type: "uint256" }, { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" }, { name: "hook", type: "address" }] }] },
  { name: "JobCreated", type: "event", anonymous: false, inputs: [{ indexed: true, name: "jobId", type: "uint256" }, { indexed: true, name: "client", type: "address" }, { indexed: true, name: "provider", type: "address" }, { indexed: false, name: "evaluator", type: "address" }, { indexed: false, name: "expiredAt", type: "uint256" }, { indexed: false, name: "hook", type: "address" }] },
];
const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
];

/* ------------------------------- criteria ---------------------------------- */

export const KNOWN_KINDS = ["checksum", "schema", "contains", "length", "http-endpoint"];

/** Bounds the judge enforces (judge-service/src/checkers/index.js LIMITS; a test keeps them equal). */
export const LIMITS = { checks: 64, probes: 4, depth: 12, terms: 256, termChars: 1024, urlChars: 2048, probeTimeoutMs: 10_000, weight: 1000 };
const TYPE_NAMES = ["string", "number", "boolean", "object"];
const has = (v) => v !== undefined && v !== null; // null params are treated as absent
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStringList = (v) => Array.isArray(v) && v.length <= LIMITS.terms
  && v.every((s) => typeof s === "string" && s.length <= LIMITS.termChars);
const isNumberIn = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** True if any object or array nests deeper than `limit` (the root is level 1), without recursion. */
function nestsDeeperThan(value, limit) {
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (d > limit) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return false;
}

/** What is wrong with one check's params, or null (the judge's own rules). */
const CHECK_FIELDS = ["kind", "params", "weight"];
const PARAM_NAMES = { length: ["min", "max", "unit"], contains: ["all", "wholeWords"], schema: ["required", "types"],
  checksum: ["sha256"], "http-endpoint": ["url", "expectStatus", "bodyIncludes", "timeoutMs"] };
function paramsProblem(kind, p) {
  for (const k of Object.keys(p)) {
    if (!(PARAM_NAMES[kind] || []).includes(k)) return `unknown param "${k}" (known: ${(PARAM_NAMES[kind] || []).join(", ")})`;
  }
  switch (kind) {
    case "length":
      for (const k of ["min", "max"]) if (has(p[k]) && !isNumberIn(p[k], 0, Infinity)) return `${k} must be a number >= 0`;
      if (has(p.min) && has(p.max) && p.min > p.max) return "min must not be above max";
      if (has(p.unit) && p.unit !== "chars" && p.unit !== "words") return 'unit must be "chars" or "words"';
      return null;
    case "contains":
      if (has(p.all) && !isStringList(p.all)) return `all must be a list of at most ${LIMITS.terms} strings of at most ${LIMITS.termChars} characters`;
      if (has(p.wholeWords) && typeof p.wholeWords !== "boolean") return "wholeWords must be true or false";
      return null;
    case "schema":
      if (has(p.required) && !isStringList(p.required)) return `required must be a list of at most ${LIMITS.terms} field names of at most ${LIMITS.termChars} characters`;
      if (has(p.types)) {
        if (!isPlainObject(p.types)) return "types must be an object of field: type";
        const entries = Object.entries(p.types);
        if (entries.length > LIMITS.terms) return `types may name at most ${LIMITS.terms} fields`;
        for (const [field, type] of entries) if (!TYPE_NAMES.includes(type)) return `types.${field} must be one of ${TYPE_NAMES.join(", ")}`;
      }
      return null;
    case "checksum":
      if (typeof p.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(p.sha256)) return "sha256 must be 64 hex characters (no 0x)";
      return null;
    case "http-endpoint":
      if (has(p.url) && (typeof p.url !== "string" || p.url.length > LIMITS.urlChars)) return `url must be a string of at most ${LIMITS.urlChars} characters`;
      if (has(p.expectStatus) && !(Number.isInteger(p.expectStatus) && p.expectStatus >= 100 && p.expectStatus <= 599)) return "expectStatus must be an integer from 100 to 599";
      if (has(p.bodyIncludes) && !isStringList(p.bodyIncludes)) return `bodyIncludes must be a list of at most ${LIMITS.terms} strings of at most ${LIMITS.termChars} characters`;
      if (has(p.timeoutMs) && !isNumberIn(p.timeoutMs, 1, LIMITS.probeTimeoutMs)) return `timeoutMs must be a number from 1 to ${LIMITS.probeTimeoutMs}`;
      return null;
    default:
      return null;
  }
}

/** True when any object inside the value has its own member named __proto__. */
function hasProtoMember(value) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, "__proto__")) return true;
    for (const k of Object.keys(v)) stack.push(v[k]);
  }
  return false;
}

/** The judge's own rules: criteria that break them are never scored (the judge abstains). */
export function validateCriteria(criteria) {
  if (!criteria || typeof criteria !== "object") return { valid: false, reason: "criteria is not an object" };
  if (nestsDeeperThan(criteria, LIMITS.depth)) return { valid: false, reason: `criteria nest deeper than ${LIMITS.depth} levels` };
  if (hasProtoMember(criteria)) return { valid: false, reason: "criteria must not contain a member named __proto__" };
  if (!Array.isArray(criteria.checks) || criteria.checks.length === 0) return { valid: false, reason: "criteria.checks must be a non-empty array" };
  if (criteria.checks.length > LIMITS.checks) return { valid: false, reason: `at most ${LIMITS.checks} checks` };
  if (criteria.passThreshold !== undefined) {
    const t = criteria.passThreshold;
    if (!Number.isInteger(t) || t < 0 || t > 100) return { valid: false, reason: `passThreshold must be an integer in [0,100], got ${t}` };
  }
  for (let i = 0; i < criteria.checks.length; i++) {
    const c = criteria.checks[i];
    if (!c || typeof c !== "object") return { valid: false, reason: `checks[${i}] is not an object` };
    const extra = Object.keys(c).find((k) => !CHECK_FIELDS.includes(k));
    if (extra !== undefined) return { valid: false, reason: `checks[${i}] unknown field "${extra}" (a check has only kind, params and weight)` };
    if (!KNOWN_KINDS.includes(c.kind)) return { valid: false, reason: `checks[${i}] unknown kind "${c.kind}" (known: ${KNOWN_KINDS.join(", ")})` };
    if (c.weight !== undefined && (typeof c.weight !== "number" || !Number.isFinite(c.weight) || c.weight <= 0 || c.weight > LIMITS.weight)) {
      return { valid: false, reason: `checks[${i}] weight must be a finite number > 0 and at most ${LIMITS.weight}, got ${c.weight}` };
    }
    if (has(c.params) && !isPlainObject(c.params)) return { valid: false, reason: `checks[${i}].params must be an object` };
    const problem = paramsProblem(c.kind, c.params ?? {});
    if (problem) return { valid: false, reason: `checks[${i}] (${c.kind}): ${problem}` };
  }
  if (criteria.checks.filter((c) => c.kind === "http-endpoint").length > LIMITS.probes) {
    return { valid: false, reason: `at most ${LIMITS.probes} http-endpoint checks` };
  }
  return { valid: true, reason: "ok" };
}

function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  // Null prototype: on a plain {} the key "__proto__" would hit the setter and vanish from the hash.
  if (x && typeof x === "object") return Object.keys(x).sort().reduce((a, k) => { a[k] = sortKeys(x[k]); return a; }, Object.create(null));
  return x;
}
export const canonicalize = (o) => JSON.stringify(sortKeys(o));
/** keccak256 of the canonical (sorted-key) JSON: what the judge commits to in its verdict. */
export const criteriaHash = (criteria) => keccak256(toHex(canonicalize(criteria)));

export function extractCriteria(description) {
  const m = (description || "").match(/```judge-criteria\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Build the job description: a title plus the fenced judge-criteria block. Throws on criteria the judge would refuse. */
export function criteriaBlock(criteria, { title = "Deliverable judged by Judge Protocol (deterministic, recomputable)." } = {}) {
  const v = validateCriteria(criteria);
  if (!v.valid) throw new Error(`invalid criteria: ${v.reason}`);
  if (String(title).includes("```")) throw new Error("title must not contain a code fence");
  // Backticks go in as \u0060 (still valid JSON, parses to the same string),
  // so a term that contains a code fence cannot close the block early.
  return `${title}\n\`\`\`judge-criteria\n${JSON.stringify(criteria).replace(/`/g, "\\u0060")}\n\`\`\``;
}

/* ------------------------------ deliverables ------------------------------- */

const toBytes = (content) => (typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content));
const base64 = (bytes) => {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
};

/**
 * Encode a deliverable for submit(): returns the provider's commitment
 * (keccak256 of the exact bytes) and the optParams carrying it as a data: URI,
 * or, with `uri`, pointing at where those same bytes are hosted.
 */
export function deliverable(content, { mediaType = "application/octet-stream", uri } = {}) {
  const bytes = toBytes(content);
  if (bytes.length === 0) throw new Error("deliverable is empty");
  if (uri !== undefined) {
    // The judge loads only these exact lowercase schemes, reads the URI up to
    // the first whitespace, and never sends credentials.
    if (typeof uri !== "string" || !/^(https?|ipfs):\/\/\S+$/.test(uri)) {
      throw new Error("uri must be an https://, http:// or ipfs:// URI with no spaces");
    }
    if (/^https?:/.test(uri)) {
      let u;
      try { u = new URL(uri); } catch { throw new Error("uri is not a valid URL"); }
      if (u.username || u.password) throw new Error("uri must not include credentials: the judge never sends them");
    }
    if (bytes.length > MAX_HOSTED_BYTES) {
      throw new Error(`a hosted deliverable can be at most ${MAX_HOSTED_BYTES} bytes (1 MB); the judge fetches no more`);
    }
    return { uri, optParams: toHex(`deliverableURI: ${uri}`), deliverableHash: keccak256(bytes), bytes };
  }
  if (bytes.length > MAX_INLINE_BYTES) {
    throw new Error(`deliverable is too large to inline (${bytes.length} > ${MAX_INLINE_BYTES} bytes); host it at an https:// or ipfs:// URI and pass it as uri`);
  }
  if (/[,;\s]/.test(mediaType)) throw new Error("mediaType must be a bare type like text/plain");
  const dataUri = `data:${mediaType};base64,${base64(bytes)}`;
  return { uri: dataUri, optParams: toHex(`deliverableURI: ${dataUri}`), deliverableHash: keccak256(bytes), bytes };
}

/* --------------------------- on-chain (viem) ------------------------------- */

async function send(walletClient, publicClient, req) {
  const hash = await walletClient.writeContract({ account: walletClient.account, ...req });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${req.functionName} transaction ${hash} reverted`);
  return { hash, receipt };
}

/** Client: create a job on Circle's ERC-8183 contract with Judge Protocol as the evaluator. */
export async function createJudgedJob({ walletClient, publicClient, provider, criteria, title, expiresInSeconds = 3 * 24 * 3600, config = ARC_TESTNET }) {
  if (!isAddress(provider) || provider.toLowerCase() === ZERO) throw new Error("provider must be a non-zero address");
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < MIN_EXPIRY_SECONDS) {
    throw new Error(`expiresInSeconds must be at least ${MIN_EXPIRY_SECONDS} so the judge has time to rule`);
  }
  const description = criteriaBlock(criteria, title ? { title } : undefined); // throws before any tx
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + expiresInSeconds);
  const { hash, receipt } = await send(walletClient, publicClient, {
    address: config.acp, abi: ACP_ABI, functionName: "createJob", args: [provider, config.judge, expiredAt, description, ZERO],
  });
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== config.acp.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: ACP_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === "JobCreated") return { jobId: ev.args.jobId, txHash: hash, description, expiredAt };
    } catch { /* another event */ }
  }
  throw new Error(`createJob ${hash} succeeded but no JobCreated event was found`);
}

/** Provider: propose the price (USDC, 6 decimals). */
export async function setBudget({ walletClient, publicClient, jobId, amount, config = ARC_TESTNET }) {
  if (!(typeof amount === "bigint" && amount > 0n)) throw new Error("amount must be a positive bigint (USDC, 6 decimals)");
  return send(walletClient, publicClient, { address: config.acp, abi: ACP_ABI, functionName: "setBudget", args: [BigInt(jobId), amount, "0x"] });
}

/** Client: approve USDC and fund the escrow. */
export async function fundJob({ walletClient, publicClient, jobId, amount, config = ARC_TESTNET }) {
  if (!(typeof amount === "bigint" && amount > 0n)) throw new Error("amount must be a positive bigint (USDC, 6 decimals)");
  await send(walletClient, publicClient, { address: config.usdc, abi: ERC20_ABI, functionName: "approve", args: [config.acp, amount] });
  return send(walletClient, publicClient, { address: config.acp, abi: ACP_ABI, functionName: "fund", args: [BigInt(jobId), "0x"] });
}

/** Provider: submit the deliverable. The commitment and the content travel together. */
export async function submitDeliverable({ walletClient, publicClient, jobId, content, mediaType, uri, config = ARC_TESTNET }) {
  const d = deliverable(content, { ...(mediaType ? { mediaType } : {}), ...(uri !== undefined ? { uri } : {}) });
  const { hash } = await send(walletClient, publicClient, {
    address: config.acp, abi: ACP_ABI, functionName: "submit", args: [BigInt(jobId), d.deliverableHash, d.optParams],
  });
  return { txHash: hash, deliverableHash: d.deliverableHash };
}

/* ------------------------------ judge API ---------------------------------- */

const idString = (jobId) => {
  const s = String(jobId);
  if (!/^[0-9]{1,30}$/.test(s) || BigInt(s) === 0n) throw new Error("jobId must be a positive integer");
  return s;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the judge to rule now. Retries a temporary failure; an abstention is an error with the judge's reason. */
export async function requestRuling({ jobId, submitTx, api = ARC_TESTNET.api, fetchImpl = fetch, retries = 3, retryDelayMs = 2000 }) {
  const body = { jobId: idString(jobId) };
  if (submitTx !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(submitTx)) throw new Error("submitTx must be a 32-byte transaction hash");
    body.submitTx = submitTx;
  }
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${api}/api/judge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      last = e; await sleep(retryDelayMs * (attempt + 1)); continue;
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 503 || res.status === 502) { last = new Error(out.reason || out.error || `HTTP ${res.status}`); await sleep(retryDelayMs * (attempt + 1)); continue; }
    if (res.status === 422) throw new Error(`the judge abstained: ${out.reason}`);
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
  }
  throw new Error(`the judge could not rule yet: ${last && last.message}`);
}

/** Poll the read-only status until the verdict is on chain. A network blip or
 *  a temporary error just means another poll; only a final answer ends it. */
export async function waitForRuling({ jobId, api = ARC_TESTNET.api, fetchImpl = fetch, intervalMs = 4000, timeoutMs = 180_000 }) {
  const id = idString(jobId);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let out = {};
    try {
      const res = await fetchImpl(`${api}/api/judge?jobId=${id}`);
      out = await res.json().catch(() => ({}));
    } catch { /* try again on the next poll */ }
    if (out.result === "judged") return out;
    if (["expired", "closed", "not-ours", "not-found"].includes(out.result)) throw new Error(`job ${id} will not be judged: ${out.result}`);
    if (Date.now() + intervalMs > deadline) throw new Error(`timed out waiting for a ruling on job ${id}`);
    await sleep(intervalMs);
  }
}

/** Run the judge's checks on a deliverable without any job (never signs, never settles). */
export async function dryRun({ criteria, content, jobId, api = ARC_TESTNET.api, fetchImpl = fetch }) {
  const payload = { criteria, deliverableBase64: base64(toBytes(content)) };
  if (jobId !== undefined) payload.jobId = idString(jobId);
  const res = await fetchImpl(`${api}/api/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.reason || out.error || `HTTP ${res.status}`);
  return out;
}

/* ------------------------------ ERC-8412 (optional) ------------------------------ */

const PREREGISTER_ABI = [{ name: "preregister", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "criteriaDigest", type: "bytes32" }, { name: "taskRef", type: "bytes32" }, { name: "obligationCount", type: "uint16" },
    { name: "obligationFlags", type: "bytes" }, { name: "expiry", type: "uint64" }, { name: "verifier", type: "address" },
    { name: "supersedes", type: "bytes32" }], outputs: [{ type: "bytes32" }] }];

/** RFC 8785 canonical JSON for the integer-only documents ERC-8412 defines. */
function jcs(v) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`;
  throw new Error("ERC-8412 documents carry integers only");
}
const packFlags = (obligations) => {
  const out = new Uint8Array(Math.ceil(obligations.length / 4));
  obligations.forEach((o, i) => { out[i >> 2] |= ((o.required ? 1 : 0) | (o.waivable ? 2 : 0)) << (6 - 2 * (i % 4)); });
  return "0x" + Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Optional: record the job's criteria on the ERC-8412 registry, so the judge
 * also attests its ruling check by check (docs/ERC-8412.md). Call it as the
 * job's client, after createJudgedJob and before the provider submits. The
 * document comes from the judge's API, and the kit checks it before sending
 * anything: it must name YOUR criteria, hash to the digest being registered,
 * and use the known registry and verifier, so the API cannot slip in others.
 */
export async function preregisterErc8412({ walletClient, publicClient, jobId, criteria, api = ARC_TESTNET.api, fetchImpl = fetch, config = ARC_TESTNET }) {
  const id = idString(jobId);
  const res = await fetchImpl(`${api}/api/erc8412?jobId=${id}`);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  if (out.status !== "not-preregistered") return { preregistrationId: out.preregistrationId, status: out.status };
  const doc = out.criteriaDocument, a = out.preregister;
  const same = (x, y) => String(x).toLowerCase() === String(y).toLowerCase();
  if (doc?.["io.github.vijaygopalbalasa.judge.criteriaHash"] !== criteriaHash(criteria)) throw new Error("the ERC-8412 document does not name these criteria");
  if (keccak256(toHex(jcs(doc))) !== a.criteriaDigest) throw new Error("the ERC-8412 document does not hash to the digest it would register");
  if (!same(out.registry, config.erc8412Registry) || !same(a.verifier, config.erc8412Attestor) || !same(doc.verifier, a.verifier)) {
    throw new Error("unexpected ERC-8412 registry or verifier");
  }
  const taskRef = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [BigInt(config.chainId), config.acp, BigInt(id)]));
  if (a.taskRef !== taskRef || doc.taskRef !== taskRef) throw new Error("the ERC-8412 taskRef is not this job's");
  if (a.obligationCount !== doc.obligations.length || a.obligationFlags !== packFlags(doc.obligations) || a.expiry !== doc.expiry || !/^0x0{64}$/.test(a.supersedes)) {
    throw new Error("the ERC-8412 arguments disagree with the document");
  }
  if (!same(walletClient.account.address, out.client)) throw new Error("only the job's client can preregister its criteria");
  const hash = await walletClient.writeContract({ address: config.erc8412Registry, abi: PREREGISTER_ABI, functionName: "preregister",
    args: [a.criteriaDigest, a.taskRef, a.obligationCount, a.obligationFlags, BigInt(a.expiry), a.verifier, a.supersedes] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`preregister reverted: ${hash}`);
  return { preregistrationId: out.preregistrationId, status: "preregistered", txHash: hash };
}
