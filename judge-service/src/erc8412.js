// ERC-8412 (Preregistered Acceptance Criteria) profile for Judge Protocol.
//
// A Judge job maps onto ERC-8412 one to one. The client's checks become typed
// obligations, frozen before the provider delivers; the judge's itemized
// result becomes the packed outcomes; and the judge's pass rule becomes the
// document's decisionRule, a standard rule wherever one gives the judge's
// answer for every combination of outcomes. See docs/ERC-8412.md.
//
// checkPackage() is an independent JavaScript port of the ERC's reference
// off-chain verifier (O1-O5 and document well-formedness). The tests run it
// against the ERC's own 23 conformance packages.
import { encodeAbiParameters, hashTypedData, keccak256, recoverAddress, toHex } from "viem";
import { criteriaHash } from "./criteria.js";
import { scoreOf, validateCriteria } from "./checkers/index.js";

/** Our reverse-DNS namespace (vijaygopalbalasa.github.io, reversed). */
export const NS = "io.github.vijaygopalbalasa.judge";
/** The judge's own weighted rule, used only when no standard rule is exact. */
export const WEIGHTED_RULE = `${NS}.weighted-threshold-v1`;
export const OUTCOMES = ["UNMET", "MET", "WAIVED", "NOT_APPLICABLE"];
export const ZERO32 = "0x" + "0".repeat(64);
const AT_LEAST = /^ALL_REQUIRED_AND_AT_LEAST\((\d+)\)$/;
const NAMESPACED = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const REQUIRED_CONSTRAINTS = { // §3
  PHOTO: ["captureMetadata"], VIDEO: ["captureMetadata"], GPS_TRACE: ["captureMetadata", "sampleIntervalSeconds"],
  HUMAN_SIGNATURE: ["signerBinding"], DOCUMENT: ["mediaType"], WITNESS_STATEMENT: ["signerBinding"],
  DEVICE_READING: ["deviceBinding", "captureMetadata"], AGENT_LOG: ["agentBinding"],
  GENERATED_ARTIFACT: ["modelBinding", "mediaType"],
};

export class ProfileError extends Error {}

/** RFC 8785 canonical JSON for the documents this ERC defines, which carry
 *  integers only: keys sorted by UTF-16 code units, no whitespace. */
export function jcs(value) {
  const ser = (v) => {
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new ProfileError(`${v} is not an integer; ERC-8412 documents carry integers only`);
      return String(v);
    }
    if (Array.isArray(v)) return `[${v.map(ser).join(",")}]`;
    if (typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${ser(v[k])}`).join(",")}}`;
    throw new ProfileError(`a ${typeof v} is not allowed in an ERC-8412 document`);
  };
  return ser(value);
}

/** keccak256 of the document's canonical JSON (criteriaDigest, bundleDigest, attestationDigest). */
export const docDigest = (doc) => keccak256(toHex(jcs(doc)));

/** Two bits per obligation, most significant first, zero padded (§5). */
export function pack(values) {
  const out = new Uint8Array(Math.ceil(values.length / 4));
  values.forEach((v, i) => { out[i >> 2] |= (v & 3) << (6 - 2 * (i % 4)); });
  return "0x" + Buffer.from(out).toString("hex");
}

export function unpack(hex, n) {
  const b = Buffer.from(String(hex).replace(/^0x/, ""), "hex");
  return Array.from({ length: n }, (_, i) => ((b[i >> 2] ?? 0) >> (6 - 2 * (i % 4))) & 3);
}

export const flagsOf = (obligations) => pack(obligations.map((o) => (o.required ? 1 : 0) | (o.waivable ? 2 : 0)));

/** The task an ERC-8183 job is: its chain, its escrow contract and its id. */
export const taskRefOf = ({ chainId, acp, jobId }) => keccak256(encodeAbiParameters(
  [{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [BigInt(chainId), acp, BigInt(jobId)]));

/** §6: keccak256(abi.encode(block.chainid, address(this), msg.sender, criteriaDigest, taskRef)). */
export const preregistrationIdOf = ({ chainId, registry, author, criteriaDigest, taskRef }) => keccak256(encodeAbiParameters(
  [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
  [BigInt(chainId), registry, author, criteriaDigest, taskRef]));

/**
 * The decision rule and the required flags for a Judge criteria block. A check
 * is required when failing it alone fails the job. The score only falls as
 * checks fail, so a required check failing always fails the job (E4 holds),
 * and ALL_REQUIRED is exact when every required check passing is enough.
 * With integer weights and equal optional weights, any k optional passes
 * score the same, so ALL_REQUIRED_AND_AT_LEAST(k) is exact. Otherwise the
 * judge's own weighted rule is named.
 */
export function decisionRuleFor(criteria) {
  const weights = criteria.checks.map((c) => c.weight ?? 1);
  const threshold = criteria.passThreshold ?? 100;
  const passes = (flags) => scoreOf(flags.map((pass, i) => ({ pass, weight: weights[i] })), threshold).pass;
  const required = weights.map((_, i) => !passes(weights.map((__, j) => j !== i)));
  if (passes(required)) return { rule: "ALL_REQUIRED", required };
  const optional = weights.filter((_, i) => !required[i]);
  if (weights.every(Number.isInteger) && optional.every((w) => w === optional[0])) {
    const flags = [...required];
    let k = 0;
    for (let i = 0; i < flags.length && !passes(flags); i++) if (!required[i]) { flags[i] = true; k++; }
    return { rule: `ALL_REQUIRED_AND_AT_LEAST(${k})`, required };
  }
  return { rule: WEIGHTED_RULE, required };
}

/**
 * Apply a criteria document's decision rule to outcome names (by obligation
 * index): the standard rules of §2, and our weighted rule, under which a check
 * passes when its outcome is MET or WAIVED. null for anyone else's custom rule.
 */
export function applyRule(doc, outcomes) {
  const obligations = doc.obligations ?? [];
  const ok = (o) => outcomes[o.index] === "MET" || outcomes[o.index] === "WAIVED";
  const requiredOk = obligations.every((o) => !o.required || ok(o));
  const rule = doc.decisionRule;
  if (rule === "ALL_REQUIRED") return requiredOk ? "Satisfied" : "NotSatisfied";
  const m = AT_LEAST.exec(rule ?? "");
  if (m) {
    const met = obligations.filter((o) => !o.required && outcomes[o.index] === "MET").length;
    return requiredOk && met >= Number(m[1]) ? "Satisfied" : "NotSatisfied";
  }
  if (rule === WEIGHTED_RULE) {
    const results = obligations.map((o) => ({ pass: ok(o), weight: o.constraints?.[`${NS}.check`]?.weight ?? 1 }));
    return scoreOf(results, doc[`${NS}.passThreshold`] ?? 100).pass ? "Satisfied" : "NotSatisfied";
  }
  return null;
}

function hasNonInteger(value) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "number" && !Number.isSafeInteger(v)) return true;
    if (v && typeof v === "object") stack.push(...Object.values(v));
  }
  return false;
}

/**
 * The criteria document for a Judge job: one obligation per check, in order.
 * A deterministic check's evidence is the delivered bytes (DOCUMENT); a live
 * http-endpoint probe's evidence is the judge's own record of it (AGENT_LOG).
 */
export function criteriaDocument(criteria, { chainId, acp, jobId, verifier, expiry }) {
  const v = validateCriteria(criteria);
  if (!v.valid) throw new ProfileError(`invalid criteria: ${v.reason}`);
  if (hasNonInteger(criteria.checks) || hasNonInteger(criteria.passThreshold ?? 100)) {
    throw new ProfileError("ERC-8412 documents carry integers only; use integer weights and params for this profile");
  }
  const { rule, required } = decisionRuleFor(criteria);
  const taskRef = taskRefOf({ chainId, acp, jobId });
  const obligations = criteria.checks.map((check, index) => {
    const own = { [`${NS}.check`]: structuredClone(check) };
    return check.kind === "http-endpoint"
      ? { index, type: "AGENT_LOG", required: required[index], waivable: false, constraints: { agentBinding: verifier, mediaType: "application/json", ...own } }
      : { index, type: "DOCUMENT", required: required[index], waivable: false, constraints: { mediaType: "application/octet-stream", ...own } };
  });
  const doc = {
    version: "1", taskRef, supersedes: null, decisionRule: rule, obligations, waiverAuthority: null,
    verifier, expiry: Number(expiry), terminalOnExpiry: "REFUND_WITH_RECORD",
    [`${NS}.criteriaHash`]: criteriaHash(criteria),
    ...(rule === WEIGHTED_RULE ? { [`${NS}.passThreshold`]: criteria.passThreshold ?? 100 } : {}),
  };
  return { doc, taskRef, criteriaDigest: docDigest(doc), obligationCount: obligations.length, obligationFlags: flagsOf(obligations) };
}

/** The evidence bundle: the provider's committed deliverable for every
 *  deterministic check, and the judge's record for every live probe. Every
 *  field comes from chain data (the probe's pass bit is in the attestation),
 *  so anyone can rebuild the bundle and check its digest. */
export function evidenceBundle({ preregistrationId, criteria, deliverable, results, judgedAt }) {
  const items = criteria.checks.map((check, i) => {
    if (check.kind === "http-endpoint") {
      const record = { check: i, kind: check.kind, pass: !!results[i].pass, judgedAt: Number(judgedAt) };
      return { obligationIndex: i, preregistrationId, digest: docDigest(record), mediaType: "application/json",
        locator: `#${NS}.probe`, captureMetadata: { timestamp: Number(judgedAt) }, [`${NS}.probe`]: record };
    }
    return { obligationIndex: i, preregistrationId, digest: deliverable.digest, mediaType: "application/octet-stream",
      locator: deliverable.uri, captureMetadata: { timestamp: Number(deliverable.submittedAt) } };
  });
  const bundle = { version: "1", preregistrationId, items };
  return { bundle, bundleDigest: docDigest(bundle) };
}

/** The attestation for a Judge verdict. Refuses a verdict its own documents contradict. */
export function attestationFor({ preregistrationId, criteriaDoc, bundleDigest, results, pass }) {
  if (results.length !== criteriaDoc.obligations.length) throw new ProfileError("one result per check is required");
  const names = results.map((r) => (r.pass ? "MET" : "UNMET"));
  const verdict = pass ? "Satisfied" : "NotSatisfied";
  const ruled = applyRule(criteriaDoc, names);
  if (ruled !== verdict) throw new ProfileError(`the verdict ${verdict} contradicts the documents: ${criteriaDoc.decisionRule} over these outcomes gives ${ruled}`);
  const obligationOutcomes = pack(names.map((n) => OUTCOMES.indexOf(n)));
  const attestation = { version: "1", preregistrationId, bundleDigest, verdict, obligationOutcomes, waivers: [], undecided: [] };
  return { attestation, attestationDigest: docDigest(attestation), verdict, obligationOutcomes };
}

/** Everything for one ruling, in the reference vectors' package format. */
export function packageFor({ criteria, chainId, acp, jobId, verifier, expiry, registry, author, registeredAt, deliverable, results, pass, judgedAt, attestedAt }) {
  const c = criteriaDocument(criteria, { chainId, acp, jobId, verifier, expiry });
  const preregistrationId = preregistrationIdOf({ chainId, registry, author, criteriaDigest: c.criteriaDigest, taskRef: c.taskRef });
  const b = evidenceBundle({ preregistrationId, criteria, deliverable, results, judgedAt });
  const a = attestationFor({ preregistrationId, criteriaDoc: c.doc, bundleDigest: b.bundleDigest, results, pass });
  return {
    chain: {
      chainId: Number(chainId), registry, preregistrationId, author, criteriaDigest: c.criteriaDigest, taskRef: c.taskRef,
      obligationCount: c.obligationCount, obligationFlags: c.obligationFlags, expiry: Number(expiry),
      registeredAt: Number(registeredAt), verifier, supersedes: ZERO32,
      attestation: { verifier, bundleDigest: b.bundleDigest, attestationDigest: a.attestationDigest, verdict: a.verdict,
        obligationOutcomes: a.obligationOutcomes, attestedAt: Number(attestedAt) },
    },
    criteria: c.doc, bundle: b.bundle, attestation: a.attestation,
  };
}

const WAIVER_TYPES = { Waiver: [
  { name: "preregistrationId", type: "bytes32" }, { name: "obligationIndex", type: "uint16" }, { name: "reasonDigest", type: "bytes32" }] };

async function waiverSigner(chainId, registry, preregistrationId, obligationIndex, reasonDigest, signature) {
  try {
    const hash = hashTypedData({ domain: { name: "ERC-8412", version: "1", chainId, verifyingContract: registry },
      types: WAIVER_TYPES, primaryType: "Waiver", message: { preregistrationId, obligationIndex, reasonDigest } });
    return await recoverAddress({ hash, signature });
  } catch {
    return null;
  }
}

/**
 * Check one published package against its chain state (§8): document
 * well-formedness (W) and O1-O5, reporting each violation by rule. A port of
 * the ERC's reference verifier; anyone else's custom decision rule is
 * reported as unchecked, never as passing.
 */
export async function checkPackage({ chain, criteria, bundle, attestation }) {
  const v = [], unchecked = [];
  const bad = (rule, detail) => v.push({ rule, detail });
  const lc = (x) => String(x ?? "").toLowerCase();
  const own = (o, k) => o !== null && typeof o === "object" && Object.hasOwn(o, k);
  const pid = chain.preregistrationId, att = chain.attestation, n = chain.obligationCount;
  const obligations = criteria.obligations ?? [];

  // W: criteria document well-formedness (§2, §3)
  if (obligations.some((o, i) => o.index !== i)) bad("W", "obligations must be dense and ordered by index from 0");
  if (obligations.some((o) => o.waivable) && !criteria.waiverAuthority) bad("W", "waiverAuthority must be non-null when any obligation is waivable");
  for (const o of obligations) {
    const t = o.type ?? "";
    if (own(REQUIRED_CONSTRAINTS, t)) {
      const missing = REQUIRED_CONSTRAINTS[t].filter((k) => !own(o.constraints, k));
      if (missing.length) bad("W", `obligation ${o.index} (${t}) missing required constraints ${missing.join(", ")}`);
    } else if (!NAMESPACED.test(t)) bad("W", `obligation ${o.index}: unknown unnamespaced type ${JSON.stringify(t)}`);
  }
  const rule = criteria.decisionRule ?? "";
  if (rule !== "ALL_REQUIRED" && !AT_LEAST.test(rule) && !NAMESPACED.test(rule)) bad("W", `decisionRule ${JSON.stringify(rule)} is neither a standard rule nor namespaced`);

  // O5: the published documents match the chain
  const digest = (d) => { try { return docDigest(d); } catch { return null; } };
  if (digest(criteria) !== lc(chain.criteriaDigest)) bad("O5", "criteria document does not hash to the registered criteriaDigest");
  if (digest(bundle) !== lc(att.bundleDigest)) bad("O5", "bundle does not hash to the attested bundleDigest");
  if (digest(attestation) !== lc(att.attestationDigest)) bad("O5", "attestation document does not hash to the attested attestationDigest");
  for (const f of ["taskRef", "expiry", "verifier"]) if (lc(criteria[f]) !== lc(chain[f])) bad("O5", `criteria.${f} != on-chain ${f}`);
  const docSup = criteria.supersedes ?? null;
  if ((docSup === null) !== (BigInt(chain.supersedes) === 0n) || (docSup !== null && lc(docSup) !== lc(chain.supersedes))) {
    bad("O5", "criteria.supersedes does not match on-chain supersedes");
  }
  if (obligations.length !== n) bad("O5", "number of obligations != on-chain obligationCount");
  else if (flagsOf(obligations) !== lc(chain.obligationFlags)) bad("O5", "on-chain obligationFlags do not match required/waivable in the document");
  const allowed = criteria.verifierConstraint?.allowed;
  if (allowed != null && !allowed.map(lc).includes(lc(chain.verifier))) bad("O5", "on-chain verifier is not in verifierConstraint.allowed");
  if (lc(attestation.preregistrationId) !== lc(pid)) bad("O5", "attestation document names a different preregistrationId");
  if (attestation.verdict !== att.verdict) bad("O5", "attestation document verdict != on-chain verdict");
  if (lc(attestation.obligationOutcomes) !== lc(att.obligationOutcomes)) bad("O5", "attestation document outcomes != on-chain obligationOutcomes");
  if (lc(attestation.bundleDigest) !== lc(att.bundleDigest)) bad("O5", "attestation document bundleDigest != on-chain bundleDigest");

  const outcomes = unpack(att.obligationOutcomes, n).map((x) => OUTCOMES[x]);

  // O1: evidence does not predate the criteria, and every item binds the id
  if (lc(bundle.preregistrationId) !== lc(pid)) bad("O1", "bundle does not bind this preregistrationId");
  (bundle.items ?? []).forEach((it, k) => {
    if (lc(it.preregistrationId) !== lc(pid)) bad("O1", `bundle item ${k} does not bind this preregistrationId`);
    const ts = it.captureMetadata?.timestamp;
    if (!Number.isInteger(ts) || ts < chain.registeredAt) bad("O1", `bundle item ${k} captured at ${ts}, before registeredAt ${chain.registeredAt}`);
  });

  // O2: every MET obligation is covered, and its checkable constraints hold
  const byIndex = new Map();
  for (const it of bundle.items ?? []) byIndex.set(it.obligationIndex, [...(byIndex.get(it.obligationIndex) ?? []), it]);
  for (const o of obligations) {
    if (outcomes[o.index] !== "MET") continue;
    const c = o.constraints ?? {};
    const satisfies = (it) => {
      const meta = it.captureMetadata ?? {};
      if ((c.captureMetadata ?? []).some((key) => !own(meta, key))) return false;
      if (own(c, "notBefore") && (meta.timestamp ?? -1) < c.notBefore) return false;
      if (own(c, "mediaType") && it.mediaType !== c.mediaType) return false;
      return true;
    };
    const items = byIndex.get(o.index) ?? [];
    if (!items.length) bad("O2", `obligation ${o.index} is MET but no bundle item covers it`);
    else if (!items.some(satisfies)) bad("O2", `obligation ${o.index} is MET but no covering item satisfies its constraints`);
  }

  // O3: every WAIVED outcome carries one waiver signed by the waiverAuthority
  const waivers = new Map();
  for (const w of attestation.waivers ?? []) waivers.set(w.obligationIndex, [...(waivers.get(w.obligationIndex) ?? []), w]);
  for (let i = 0; i < n; i++) {
    const ws = waivers.get(i) ?? [];
    if (outcomes[i] === "WAIVED") {
      if (ws.length !== 1) { bad("O3", `obligation ${i} is WAIVED but has ${ws.length} waiver records`); continue; }
      const signer = await waiverSigner(chain.chainId, chain.registry, pid, i, ws[0].reasonDigest, ws[0].signature);
      if (!criteria.waiverAuthority || !signer || lc(signer) !== lc(criteria.waiverAuthority)) bad("O3", `waiver for obligation ${i} is not signed by waiverAuthority`);
    } else if (ws.length) bad("O3", `waiver record present for obligation ${i}, which is ${outcomes[i]}, not WAIVED`);
  }

  // O4: the verdict follows the decision rule
  const verdict = att.verdict;
  const undecided = attestation.undecided ?? [];
  const r = obligations.length ? applyRule(criteria, outcomes) : null;
  if (r === null) unchecked.push("O4: custom decisionRule not implemented by this verifier");
  else if (verdict === "Satisfied" || verdict === "NotSatisfied") {
    if (verdict !== r) bad("O4", `decisionRule yields ${r}, verdict is ${verdict}`);
    if (undecided.length) bad("O4", "undecided must be empty unless the verdict is Indeterminate");
  } else if (verdict === "Indeterminate") {
    if (r === "Satisfied") bad("O4", "Indeterminate recorded although the decision rule is already Satisfied");
    if (!undecided.length) bad("O4", "Indeterminate requires a non-empty undecided list");
    for (const i of undecided) if (outcomes[i] !== "UNMET") bad("O4", `undecided obligation ${i} must be encoded UNMET, is ${outcomes[i]}`);
  }
  return { valid: v.length === 0, violations: v, unchecked };
}
