// Attest a Judge ruling on ERC-8412 (docs/ERC-8412.md) when, and only when,
// the job's client preregistered the criteria document this profile defines
// for the job, naming JudgeAttestor as the verifier. The judge's key signs the
// attestation (EIP-712); the relayer submits it through JudgeAttestor, which
// accepts it only from a key JudgeEvaluator trusts. If the relay fails, the
// signed attestation is returned, and anyone can submit it later.
//
// Nothing is signed that the published record could refute: a preregistration
// whose chain fields disagree with the document (O5), evidence older than the
// preregistration (O1), and a verdict the document's rule contradicts (O4) are
// all left unattested, with the reason.
import { ProfileError, attestationFor, criteriaDocument, evidenceBundle, preregistrationIdOf } from "./erc8412.js";

export const REGISTRY_ABI = [
  { name: "preregister", type: "function", stateMutability: "nonpayable", inputs: [{ name: "criteriaDigest", type: "bytes32" }, { name: "taskRef", type: "bytes32" }, { name: "obligationCount", type: "uint16" }, { name: "obligationFlags", type: "bytes" }, { name: "expiry", type: "uint64" }, { name: "verifier", type: "address" }, { name: "supersedes", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { name: "getPreregistration", type: "function", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "author", type: "address" }, { name: "criteriaDigest", type: "bytes32" }, { name: "taskRef", type: "bytes32" }, { name: "obligationCount", type: "uint16" }, { name: "obligationFlags", type: "bytes" }, { name: "expiry", type: "uint64" }, { name: "registeredAt", type: "uint64" }, { name: "verifier", type: "address" }, { name: "supersedes", type: "bytes32" }, { name: "supersededBy", type: "bytes32" }] },
  { name: "getAttestation", type: "function", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "verifier", type: "address" }, { name: "bundleDigest", type: "bytes32" }, { name: "attestationDigest", type: "bytes32" }, { name: "verdict", type: "uint8" }, { name: "obligationOutcomes", type: "bytes" }, { name: "attestedAt", type: "uint64" }] },
];

export const ATTESTOR_ABI = [
  { name: "attest", type: "function", stateMutability: "nonpayable", inputs: [{ name: "preregistrationId", type: "bytes32" }, { name: "bundleDigest", type: "bytes32" }, { name: "attestationDigest", type: "bytes32" }, { name: "verdict", type: "uint8" }, { name: "obligationOutcomes", type: "bytes" }, { name: "sig", type: "bytes" }], outputs: [] },
];

/** EIP-712 types JudgeAttestor verifies (domain: "JudgeAttestor", version "1"). */
export const ATTESTATION_TYPES = { Attestation: [
  { name: "preregistrationId", type: "bytes32" }, { name: "bundleDigest", type: "bytes32" },
  { name: "attestationDigest", type: "bytes32" }, { name: "verdict", type: "uint8" }, { name: "obligationOutcomes", type: "bytes" },
] };

const VERDICT = { Satisfied: 1, NotSatisfied: 2 };
const isZero = (x) => BigInt(x ?? 0) === 0n;

/**
 * @param ruling { jobId, client, expiredAt, criteria, results, pass, deliverable: { digest, uri, submitTx }, judgedAt }
 * @param deps   { publicClient, signerAccount, relayerWallet, chainId, acp, registry, attestor, now }
 * @returns      { status, preregistrationId?, reason?, txHash?, relay?, documents? }
 */
export async function attestRuling(ruling, { publicClient, signerAccount, relayerWallet, chainId, acp, registry, attestor, now = () => Math.floor(Date.now() / 1000) }) {
  const { jobId, client, expiredAt, criteria, results, pass, deliverable, judgedAt } = ruling;
  let c;
  try {
    c = criteriaDocument(criteria, { chainId, acp, jobId, verifier: attestor, expiry: expiredAt });
  } catch (e) {
    if (e instanceof ProfileError) return { status: "unsupported", reason: e.message };
    throw e;
  }
  const preregistrationId = preregistrationIdOf({ chainId, registry, author: client, criteriaDigest: c.criteriaDigest, taskRef: c.taskRef });
  const out = (status, extra = {}) => ({ status, preregistrationId, ...extra });
  const read = (functionName) => publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName, args: [preregistrationId] });

  const [author, , , count, flags, expiry, registeredAt, verifier, supersedes, supersededBy] = await read("getPreregistration");
  if (isZero(author)) return out("not-preregistered");
  if (!isZero(supersededBy)) return out("superseded");
  const mismatch = [
    String(verifier).toLowerCase() !== String(attestor).toLowerCase() && "verifier",
    Number(count) !== c.obligationCount && "obligationCount",
    String(flags).toLowerCase() !== c.obligationFlags && "obligationFlags",
    Number(expiry) !== c.doc.expiry && "expiry",
    !isZero(supersedes) && "supersedes",
  ].filter(Boolean);
  if (mismatch.length) return out("mismatch", { reason: `the preregistration's ${mismatch.join(", ")} differ from the criteria document` });
  const [, , , recorded] = await read("getAttestation");
  if (Number(recorded) !== 0) return out("already-attested");
  if (now() > Number(expiry)) return out("expired");

  const receipt = await publicClient.getTransactionReceipt({ hash: deliverable.submitTx });
  const submittedAt = Number((await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  if (submittedAt < Number(registeredAt)) return out("evidence-predates-criteria");

  const b = evidenceBundle({ preregistrationId, criteria, deliverable: { digest: deliverable.digest, uri: deliverable.uri, submittedAt }, results, judgedAt });
  let a;
  try {
    a = attestationFor({ preregistrationId, criteriaDoc: c.doc, bundleDigest: b.bundleDigest, results, pass });
  } catch (e) {
    if (e instanceof ProfileError) return out("refused", { reason: e.message });
    throw e;
  }
  const message = { preregistrationId, bundleDigest: b.bundleDigest, attestationDigest: a.attestationDigest,
    verdict: VERDICT[a.verdict], obligationOutcomes: a.obligationOutcomes };
  const signature = await signerAccount.signTypedData({
    domain: { name: "JudgeAttestor", version: "1", chainId, verifyingContract: attestor },
    types: ATTESTATION_TYPES, primaryType: "Attestation", message });
  const args = [preregistrationId, message.bundleDigest, message.attestationDigest, message.verdict, message.obligationOutcomes, signature];
  const documents = { criteria: c.doc, bundle: b.bundle, attestation: a.attestation };
  try {
    const txHash = await relayerWallet.writeContract({ address: attestor, abi: ATTESTOR_ABI, functionName: "attest", args });
    const r = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (r.status !== "success") throw new Error(`the attest transaction reverted: ${txHash}`);
    return out("attested", { txHash, documents });
  } catch (e) {
    return out("signed-not-relayed", { reason: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300), relay: { attestor, args }, documents });
  }
}
