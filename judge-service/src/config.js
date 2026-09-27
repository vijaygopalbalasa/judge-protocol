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

  // The deployed JudgeEvaluator on Arc testnet (public, like the ACP address).
  judgeAddress: process.env.JUDGE_ADDRESS || "0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD",

  // Attestation signer for EIP-712 verdicts (the judge's hot key).
  signerKey: process.env.JUDGE_SIGNER_KEY || "",

  // Relayer that submits signed verdicts on-chain (may equal signer in v1).
  relayerKey: process.env.JUDGE_RELAYER_KEY || process.env.JUDGE_SIGNER_KEY || "",

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 4000),
  slaSeconds: Number(process.env.SLA_SECONDS || 300),
  evidenceDir: process.env.EVIDENCE_DIR || "./evidence",

  // Watcher cursor persistence (survives restarts; see cursor.js).
  cursorFile: process.env.CURSOR_FILE || "./state/cursor.json",

  // HTTP integration API. Binds to loopback by default; put a reverse proxy
  // in front before exposing it publicly.
  httpPort: Number(process.env.HTTP_PORT || 8788),
  httpHost: process.env.HTTP_HOST || "127.0.0.1",
};

export const USDC_DECIMALS = 6; // Arc ERC-20 view (never mix with 18-dec native)
