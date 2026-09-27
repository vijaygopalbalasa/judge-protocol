// EIP-712 verdict signing + on-chain submission.
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { judgeAbi } from "./abi.js";

export const VERDICT_TYPES = {
  Verdict: [
    { name: "jobId", type: "uint256" },
    { name: "criteriaHash", type: "bytes32" },
    { name: "deliverable", type: "bytes32" },
    { name: "score", type: "uint8" },
    { name: "threshold", type: "uint8" },
    { name: "pass", type: "bool" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

function domain() {
  return {
    name: "JudgeEvaluator",
    version: "1",
    chainId: config.chain.id,
    verifyingContract: config.judgeAddress,
  };
}

/** A read-only chain client: needs no keys, so status reads work on any deployment. */
export function makePublicClient() {
  return createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
}

export function makeClients() {
  const publicClient = makePublicClient();
  const signerAccount = privateKeyToAccount(config.signerKey);
  const relayerAccount = privateKeyToAccount(config.relayerKey);
  const relayerWallet = createWalletClient({
    account: relayerAccount,
    chain: config.chain,
    transport: http(config.rpcUrl),
  });
  return { publicClient, signerAccount, relayerWallet };
}

/** Sign a verdict with the judge's attestation key (EIP-712). */
export async function signVerdict(signerAccount, verdict) {
  const sig = await signerAccount.signTypedData({
    domain: domain(),
    types: VERDICT_TYPES,
    primaryType: "Verdict",
    message: {
      jobId: verdict.jobId,
      criteriaHash: verdict.criteriaHash,
      deliverable: verdict.deliverable,
      score: verdict.score,
      threshold: verdict.threshold,
      pass: verdict.pass,
      evidenceHash: verdict.evidenceHash,
      timestamp: verdict.timestamp,
    },
  });
  return sig;
}

/**
 * Submit the signed verdict on-chain via the relayer. Uses JudgeEvaluator's
 * permissionless relay(): the contract checks that the EIP-712 signature is
 * from an allowlisted signer, so the relayer (which only pays gas) can be a
 * separate key from the signer. submitVerdict() would additionally require
 * the SENDER to be a signer.
 */
export async function submitVerdictOnChain(relayerWallet, publicClient, verdict, sig) {
  const hash = await relayerWallet.writeContract({
    address: config.judgeAddress,
    abi: judgeAbi,
    functionName: "relay",
    args: [verdict, sig],
  });
  let receipt;
  try { receipt = await publicClient.waitForTransactionReceipt({ hash }); } catch (e) {
    throw Object.assign(e, { hash }); // sent, fate unknown: the caller checks the chain before resending
  }
  // viem resolves (does not throw) for a mined-but-reverted tx. A reverted
  // verdict tx recorded nothing, so it must never be reported as a ruling.
  if (receipt.status !== "success") {
    throw Object.assign(new Error(`verdict transaction ${hash} reverted on-chain`), { reverted: true, hash });
  }
  return { hash, receipt };
}
