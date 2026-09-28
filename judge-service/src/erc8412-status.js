// GET /api/erc8412?jobId=N (docs/ERC-8412.md). For the job's client: the exact
// preregister() arguments for the job's ERC-8412 criteria document, to send
// before the provider submits. For anyone, once the judge has attested: the
// whole package (chain state and the three documents), rebuilt from chain data
// alone, with our checker's verdict on it. Read-only; needs no keys.
import { config } from "./config.js";
import { acpAbi, judgeAbi } from "./abi.js";
import { extractCriteria } from "./criteria.js";
import { resolveDeliverableSource } from "./engine.js";
import { ProfileError, OUTCOMES, attestationFor, checkPackage, criteriaDocument, evidenceBundle, preregistrationIdOf, unpack } from "./erc8412.js";
import { REGISTRY_ABI } from "./erc8412-attest.js";

const VERDICTS = ["None", "Satisfied", "NotSatisfied", "Indeterminate", "ExpiredUnresolved"];
const reply = (status, body) => ({ status, body });
const isZero = (x) => BigInt(x ?? 0) === 0n;
const jsonable = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

/**
 * @param input { jobId, submitTx? }  submitTx: the provider's submit transaction, when the
 *              submission is older than the search window
 * @param deps  { publicClient, findSubmission(publicClient, jobId, submitTx) }
 */
export async function erc8412Status(input, { publicClient, findSubmission }) {
  const jobId = /^[0-9]{1,30}$/.test(String(input.jobId ?? "")) && BigInt(input.jobId) > 0n ? BigInt(input.jobId) : null;
  if (jobId === null) return reply(400, { error: "jobId must be a positive integer" });
  if (input.submitTx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(String(input.submitTx))) {
    return reply(400, { error: "submitTx must be a 32-byte transaction hash" });
  }
  if (!config.erc8412Attestor) return reply(404, { error: "ERC-8412 attestation is switched off on this deployment" });
  const read = (address, abi, functionName, args) => publicClient.readContract({ address, abi, functionName, args });

  const job = await read(config.acpAddress, acpAbi, "getJob", [jobId]);
  const client = job.client ?? job[1];
  if (isZero(client)) return reply(404, { result: "not-found", error: "no such job on the ACP contract" });
  if (String(job.evaluator ?? job[3]).toLowerCase() !== config.judgeAddress.toLowerCase()) {
    return reply(200, { result: "not-ours", jobId: jobId.toString(), evaluator: job.evaluator ?? job[3] });
  }
  const description = job.description ?? job[4];
  const criteria = extractCriteria(description);
  if (!criteria) return reply(422, { result: "no-criteria", error: "no judge-criteria block in the job description" });
  let c;
  try {
    c = criteriaDocument(criteria, { chainId: config.chain.id, acp: config.acpAddress, jobId, verifier: config.erc8412Attestor, expiry: job.expiredAt ?? job[6] });
  } catch (e) {
    if (e instanceof ProfileError) return reply(422, { result: "unsupported", error: e.message });
    throw e;
  }
  const preregistrationId = preregistrationIdOf({ chainId: config.chain.id, registry: config.erc8412Registry, author: client,
    criteriaDigest: c.criteriaDigest, taskRef: c.taskRef });
  const body = {
    jobId: jobId.toString(), chainId: config.chain.id, registry: config.erc8412Registry, attestor: config.erc8412Attestor,
    client, preregistrationId,
    preregister: { criteriaDigest: c.criteriaDigest, taskRef: c.taskRef, obligationCount: c.obligationCount,
      obligationFlags: c.obligationFlags, expiry: c.doc.expiry, verifier: config.erc8412Attestor, supersedes: "0x" + "0".repeat(64) },
    criteriaDocument: c.doc,
  };

  const [author, , , count, flags, expiry, registeredAt, verifier, supersedes, supersededBy] =
    await read(config.erc8412Registry, REGISTRY_ABI, "getPreregistration", [preregistrationId]);
  if (isZero(author)) return reply(200, { ...body, status: "not-preregistered", note: "the job's client sends registry.preregister(...) with these arguments, before the provider submits" });
  if (!isZero(supersededBy)) return reply(200, { ...body, status: "superseded" });
  const [attVerifier, bundleDigest, attestationDigest, verdictIndex, obligationOutcomes, attestedAt] =
    await read(config.erc8412Registry, REGISTRY_ABI, "getAttestation", [preregistrationId]);
  const verdict = VERDICTS[Number(verdictIndex)] ?? `Unknown(${verdictIndex})`;
  if (verdict === "None") return reply(200, { ...body, status: "preregistered", note: "the judge attests after it rules" });
  if (verdict === "ExpiredUnresolved") return reply(200, { ...body, status: "expired-unresolved" });

  // Attested: rebuild the bundle and the attestation from chain data, so anyone can check the digests.
  const chain = { chainId: config.chain.id, registry: config.erc8412Registry, preregistrationId, author, criteriaDigest: c.criteriaDigest,
    taskRef: c.taskRef, obligationCount: Number(count), obligationFlags: flags, expiry: Number(expiry), registeredAt: Number(registeredAt),
    verifier, supersedes,
    attestation: { verifier: attVerifier, bundleDigest, attestationDigest, verdict, obligationOutcomes, attestedAt: Number(attestedAt) } };
  const onChainVerdict = await read(config.judgeAddress, judgeAbi, "getVerdict", [jobId]);
  const sub = await findSubmission(publicClient, jobId, input.submitTx);
  if (!sub) {
    return reply(200, { ...body, status: "attested", chain: jsonable(chain), package: null,
      note: "the provider's submission is outside the search window; pass submitTx to rebuild the documents" });
  }
  const { uri } = await resolveDeliverableSource(publicClient, sub.txHash, description);
  const receipt = await publicClient.getTransactionReceipt({ hash: sub.txHash });
  const submittedAt = Number((await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  const outcomes = unpack(obligationOutcomes, c.obligationCount).map((x) => OUTCOMES[x]);
  const results = criteria.checks.map((check, i) => ({ kind: check.kind, weight: check.weight ?? 1, pass: outcomes[i] === "MET" }));
  const judgedAt = Number(onChainVerdict.timestamp ?? onChainVerdict[7]);
  const b = evidenceBundle({ preregistrationId, criteria, deliverable: { digest: onChainVerdict.deliverable ?? onChainVerdict[2], uri, submittedAt }, results, judgedAt });
  let a;
  try {
    a = attestationFor({ preregistrationId, criteriaDoc: c.doc, bundleDigest: b.bundleDigest, results, pass: !!(onChainVerdict.pass ?? onChainVerdict[5]) });
  } catch (e) {
    if (!(e instanceof ProfileError)) throw e;
    return reply(200, { ...body, status: "attested", chain: jsonable(chain), package: null, error: `the chain records disagree: ${e.message}` });
  }
  const pkg = jsonable({ chain, criteria: c.doc, bundle: b.bundle, attestation: a.attestation });
  const check = await checkPackage(pkg);
  return reply(200, { ...body, status: "attested", package: pkg, check });
}
