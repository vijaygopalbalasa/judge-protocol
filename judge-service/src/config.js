// Judge service configuration. Chain-agnostic: everything Arc-specific lives here.
import { arcTestnet } from "viem/chains";

export const config = {
  chain: process.env.ARC_RPC_URL
    ? { ...arcTestnet, id: Number(process.env.CHAIN_ID || arcTestnet.id), rpcUrls: { default: { http: [process.env.ARC_RPC_URL] } } }
    : arcTestnet,
  rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io",

  // Circle's canonical ERC-8183 (AgenticCommerce) deployment on Arc testnet.
  acpAddress: (process.env.ACP_ADDRESS ||
    "0x0747EEf0706327138c69792bF28Cd525089e4583"),

  // Our deployed JudgeEvaluator (set after deploy).
  judgeAddress: process.env.JUDGE_ADDRESS || "",

  // Attestation signer for EIP-712 verdicts (the judge's hot key).
  signerKey: process.env.JUDGE_SIGNER_KEY || "",

  // Relayer that submits signed verdicts on-chain (may equal signer in v1).
  relayerKey: process.env.JUDGE_RELAYER_KEY || process.env.JUDGE_SIGNER_KEY || "",

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 4000),
  slaSeconds: Number(process.env.SLA_SECONDS || 300),
  evidenceDir: process.env.EVIDENCE_DIR || "./evidence",
};

export const USDC_DECIMALS = 6; // Arc ERC-20 view (never mix with 18-dec native)
