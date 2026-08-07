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

export function makeClients() {
  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
  });
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

/** Submit the signed verdict on-chain via the relayer. */
export async function submitVerdictOnChain(relayerWallet, publicClient, verdict, sig) {
  const hash = await relayerWallet.writeContract({
    address: config.judgeAddress,
    abi: judgeAbi,
    functionName: "submitVerdict",
    args: [verdict, sig],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}
