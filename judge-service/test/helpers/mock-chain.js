// A small in-memory stand-in for the viem clients the judge uses, so the
// on-demand judge and the sweep can be tested end to end without a network.
// Jobs, verdicts, submissions and relay behaviour are all configurable.
import { encodeFunctionData, encodeEventTopics, parseAbiItem, keccak256, toHex, stringToHex, padHex, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ACP = "0x0747EEf0706327138c69792bF28Cd525089e4583";
export const JUDGE = "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD";
export const PROVIDER = "0x5e14c9E5278ee370D764d03d314e92B3d9fFC04F";
export const CLIENT = "0xA3f1b2503838fc061af842eD2C719559E12ad973";
// Throwaway test keys derived at runtime (no key material in the source, so
// the secret scanner has nothing to flag). Never used on any network.
export const TEST_SIGNER = privateKeyToAccount(keccak256(toHex("judge-protocol mock-chain test signer")));
export const TEST_RELAYER = privateKeyToAccount(keccak256(toHex("judge-protocol mock-chain test relayer")));

export const JOB_SUBMITTED = parseAbiItem("event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)");
const submitAbi = [{ name: "submit", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "jobId", type: "uint256" }, { name: "deliverable", type: "bytes32" }, { name: "optParams", type: "bytes" }], outputs: [] }];

export const TEXT = "This analysis covers ERC-8183 escrow mechanics and USDC settlement on Arc testnet in sufficient detail to satisfy the acceptance criteria.";
export const CRITERIA = { version: 1, jobType: "doc", passThreshold: 100, checks: [
  { kind: "length", params: { min: 10, max: 5000 }, weight: 1 },
  { kind: "contains", params: { all: ["ERC-8183", "USDC"] }, weight: 1 },
] };
export const describe = (criteria = CRITERIA) => ["Analyze ERC-8183 escrow on Arc.", "```judge-criteria", JSON.stringify(criteria), "```"].join("\n");
export const dataUri = (text) => `data:text/plain;base64,${Buffer.from(text).toString("base64")}`;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const STATUS = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 };
const EMPTY_VERDICT = { jobId: 0n, criteriaHash: padHex("0x0"), deliverable: padHex("0x0"), score: 0, threshold: 0, pass: false, evidenceHash: padHex("0x0"), timestamp: 0n };

/**
 * @param {object} o
 * @param {Array<object>} o.jobs  each: { id, evaluator?, status?, budget?, description?, content?, block?, submitted? (default true), txHash? }
 * @param {bigint} [o.latest]
 * @param {"ok"|"revert-then-judged"|"revert"|"mined-revert"|"mined-revert-then-judged"|"transient-then-ok"|"transient"|"receipt-timeout-landed"} [o.relay]
 *        mined-revert*: the tx is accepted and mined but reverts (the receipt says so)
 *        transient: every send fails before reaching the chain (an RPC outage)
 * @param {boolean} [o.paused] JudgeEvaluator.paused() (default false); a paused contract reverts every verdict
 * @param {Object<string,string>} [o.registeredCriteria] jobId -> JudgeEvaluator.jobCriteria(jobId)
 * @param {Object<string,number>} [o.failReads] functionName -> how many reads throw a transport error first
 * @param {bigint} [o.balance] relayer native balance (18 decimals)
 * @param {boolean} [o.signerAuthorized] whether JudgeEvaluator.isSigner(TEST_SIGNER) is true (default true)
 * @param {boolean} [o.sameKey] relayer uses the signer's key (default: a separate relayer key)
 */
export function mockChain(o) {
  const latest = o.latest ?? 64_000_000n;
  const jobs = new Map();
  const verdicts = new Map();
  const txs = new Map();
  const logs = [];
  const calls = { writeContract: [], getLogs: [] };
  const attestations = new Map(); // ERC-8412: preregistrationId -> getAttestation row
  for (const j of o.jobs) {
    const content = j.content ?? TEXT;
    const committed = keccak256(stringToHex(content));
    const job = {
      id: BigInt(j.id), client: CLIENT, provider: PROVIDER, evaluator: j.evaluator ?? JUDGE,
      description: j.description ?? describe(j.criteria), budget: j.budget ?? 1_000_000n,
      expiredAt: j.expiredAt ?? 0n, status: STATUS[j.status ?? "Submitted"], hook: "0x0000000000000000000000000000000000000000",
    };
    jobs.set(job.id, job);
    if (j.verdict) verdicts.set(job.id, j.verdict);
    if (j.submitted === false) continue;
    const hash = j.txHash ?? keccak256(toHex(`submit-${j.id}`));
    const input = encodeFunctionData({ abi: submitAbi, functionName: "submit",
      args: [job.id, committed, stringToHex(`deliverableURI: ${j.uri ?? dataUri(content)}`)] });
    const block = j.block ?? latest - 50n;
    txs.set(hash, { hash, to: ACP, from: PROVIDER, input, blockNumber: block });
    const topics = encodeEventTopics({ abi: [JOB_SUBMITTED], eventName: "JobSubmitted", args: { jobId: job.id, provider: PROVIDER } });
    logs.push({ address: ACP, blockNumber: block, transactionHash: hash, topics, data: j.logDeliverable ?? committed,
      args: { jobId: job.id, provider: PROVIDER, deliverable: j.logDeliverable ?? committed } });
  }

  const publicClient = {
    getBlockNumber: async () => latest,
    getBlock: async ({ blockNumber }) => ({ number: BigInt(blockNumber), timestamp: blockTime(blockNumber) }),
    getLogs: async ({ address, fromBlock, toBlock, args }) => {
      calls.getLogs.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1n > 10_000n) throw new Error("requested range too large");
      return logs.filter((l) => l.address.toLowerCase() === String(address).toLowerCase()
        && l.blockNumber >= fromBlock && l.blockNumber <= toBlock
        && (!args || args.jobId === undefined || l.args.jobId === BigInt(args.jobId)));
    },
    readContract: async ({ address, abi, functionName, args }) => {
      // Like viem: a function missing from the ABI is an error, not a silent success.
      if (!Array.isArray(abi) || !abi.some((x) => x.type === "function" && x.name === functionName)) {
        throw new Error(`Function "${functionName}" not found on ABI`);
      }
      if (o.failReads?.[functionName] > 0) {
        o.failReads[functionName]--;
        throw new Error("HTTP request failed. Status: 429 URL: https://rpc.testnet.arc.io Details: rate limit exceeded");
      }
      if (functionName === "paused") return !!o.paused;
      if (functionName === "jobCriteria") return o.registeredCriteria?.[String(args[0])] ?? padHex("0x0");
      if (functionName === "getJob") {
        const j = jobs.get(BigInt(args[0]));
        // Like Circle's contract: an unknown id is not a revert, it is an all-zero job.
        if (!j) return { id: 0n, client: ZERO_ADDR, provider: ZERO_ADDR, evaluator: ZERO_ADDR, description: "", budget: 0n, expiredAt: 0n, status: 0, hook: ZERO_ADDR };
        return j;
      }
      if (functionName === "getVerdict") return verdicts.get(BigInt(args[0])) ?? EMPTY_VERDICT;
      // ERC-8412 registry: nothing is preregistered unless a test says so.
      if (functionName === "getPreregistration") return o.preregistrations?.[args[0]] ?? [ZERO_ADDR, padHex("0x0"), padHex("0x0"), 0, "0x", 0n, 0n, ZERO_ADDR, padHex("0x0"), padHex("0x0")];
      if (functionName === "getAttestation") return attestations.get(args[0]) ?? [ZERO_ADDR, padHex("0x0"), padHex("0x0"), 0, "0x", 0n];
      if (functionName === "isSigner") return (o.signerAuthorized ?? true) && String(args[0]).toLowerCase() === TEST_SIGNER.address.toLowerCase();
      throw new Error(`mock: unexpected readContract ${functionName} on ${address}`);
    },
    getTransaction: async ({ hash }) => {
      const t = txs.get(hash);
      if (!t) throw new Error("transaction not found");
      return t;
    },
    getTransactionReceipt: async ({ hash }) => {
      const t = txs.get(hash);
      if (!t) throw new Error("receipt not found");
      return { status: "success", transactionHash: hash, blockNumber: t.blockNumber,
        logs: logs.filter((l) => l.transactionHash === hash).map(({ address, topics, data, blockNumber, transactionHash }) => ({ address, topics, data, blockNumber, transactionHash })) };
    },
    waitForTransactionReceipt: async ({ hash }) => {
      if (receiptTimeouts.has(hash)) throw new Error(`Timed out while waiting for transaction with hash "${hash}" to be confirmed.`);
      return { status: minedReverts.has(hash) ? "reverted" : "success", transactionHash: hash };
    },
    getBalance: async () => o.balance ?? 3_000_000_000_000_000_000n,
  };

  const minedReverts = new Set();
  const receiptTimeouts = new Set();
  const relayState = { failedOnce: false };
  const relayerWallet = {
    account: o.sameKey ? TEST_SIGNER : TEST_RELAYER,
    writeContract: async ({ address, abi, functionName, args }) => {
      calls.writeContract.push({ functionName, args });
      // Like viem + the real JudgeEvaluator: the function must exist in the ABI,
      // and submitVerdict() only accepts a transaction SENT by an allowlisted
      // signer (relay() is the permissionless path for a separate relayer).
      if (!Array.isArray(abi) || !abi.some((x) => x.type === "function" && x.name === functionName)) {
        throw new Error(`Function "${functionName}" not found on ABI`);
      }
      if (functionName === "attest") return attest(address, args);
      if (functionName === "submitVerdict" && relayerWallet.account.address !== TEST_SIGNER.address) {
        throw new Error('The contract function "submitVerdict" reverted with the following signature: 0xa1b035c8 (NotSigner)');
      }
      const mode = o.relay ?? "ok";
      const [v] = args;
      if (o.paused) throw new Error("execution reverted: Paused_()");
      if (mode === "transient") {
        throw new Error("HTTP request failed. Status: 503 URL: https://rpc.testnet.arc.io Details: internal error (-32603)");
      }
      if (mode === "revert-then-judged") {
        // Another invocation won the race: the verdict is on-chain now.
        verdicts.set(BigInt(v.jobId), { ...v });
        jobs.get(BigInt(v.jobId)).status = v.pass ? STATUS.Completed : STATUS.Rejected;
        throw new Error("execution reverted: AlreadyResolved");
      }
      if (mode === "revert") throw new Error("execution reverted: BadSigner");
      if (mode === "transient-then-ok" && !relayState.failedOnce) {
        // The RPC hiccups once (as Arc testnet does under load); nothing was sent.
        relayState.failedOnce = true;
        throw new Error("HTTP request failed. Status: 503 URL: https://rpc.testnet.arc.io Details: internal error (-32603)");
      }
      if (mode === "receipt-timeout-landed") {
        // The transaction is sent and lands, but the receipt never comes back in time.
        verdicts.set(BigInt(v.jobId), { ...v });
        jobs.get(BigInt(v.jobId)).status = v.pass ? STATUS.Completed : STATUS.Rejected;
        const h = keccak256(toHex(`verdict-${v.jobId}`));
        receiptTimeouts.add(h);
        return h;
      }
      if (mode === "mined-revert" || mode === "mined-revert-then-judged") {
        const h = keccak256(toHex(`reverted-${v.jobId}`));
        minedReverts.add(h);
        if (mode === "mined-revert-then-judged") {
          verdicts.set(BigInt(v.jobId), { ...v });
          jobs.get(BigInt(v.jobId)).status = v.pass ? STATUS.Completed : STATUS.Rejected;
        }
        return h; // accepted, mined, reverted: no verdict recorded by THIS tx
      }
      verdicts.set(BigInt(v.jobId), { ...v });
      jobs.get(BigInt(v.jobId)).status = v.pass ? STATUS.Completed : STATUS.Rejected;
      return keccak256(toHex(`verdict-${v.jobId}`));
    },
  };

  /** JudgeAttestor + the ERC-8412 registry, as far as the judge relies on them:
   *  the signature must recover to the judge's key, the preregistration must
   *  exist and name this attestor, and there is one attestation per record. */
  async function attest(attestor, [id, bundleDigest, attestationDigest, verdict, outcomes, signature]) {
    const signer = await recoverTypedDataAddress({
      domain: { name: "JudgeAttestor", version: "1", chainId: 5042002, verifyingContract: attestor },
      types: { Attestation: [{ name: "preregistrationId", type: "bytes32" }, { name: "bundleDigest", type: "bytes32" },
        { name: "attestationDigest", type: "bytes32" }, { name: "verdict", type: "uint8" }, { name: "obligationOutcomes", type: "bytes" }] },
      primaryType: "Attestation", message: { preregistrationId: id, bundleDigest, attestationDigest, verdict, obligationOutcomes: outcomes }, signature });
    if (signer.toLowerCase() !== TEST_SIGNER.address.toLowerCase()) throw new Error("execution reverted: BadSignature()");
    const row = o.preregistrations?.[id];
    if (!row || String(row[7]).toLowerCase() !== String(attestor).toLowerCase()) throw new Error("execution reverted: E3");
    if (attestations.has(id)) throw new Error("execution reverted: E3");
    attestations.set(id, [attestor, bundleDigest, attestationDigest, verdict, outcomes, blockTime(latest)]);
    return keccak256(toHex(`attest-${id}`));
  }

  return { clients: { publicClient, signerAccount: TEST_SIGNER, relayerWallet }, calls, jobs, verdicts, logs, latest, attestations, blockTime };
}

/** Block timestamps: one second per block, ending near the present. */
export const blockTime = (n) => 1_790_000_000n + (BigInt(n) - 64_000_000n);
