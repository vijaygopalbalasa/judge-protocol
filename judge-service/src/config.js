// Judge service configuration. Chain-agnostic: everything Arc-specific lives here.
import { arcTestnet } from "viem/chains";

// ERC-8412's registry and JudgeAttestor exist on Arc testnet only; on any other chain they default to off.
const ON_ARC_TESTNET = Number(process.env.CHAIN_ID || arcTestnet.id) === arcTestnet.id;

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

  // Where paid rulings (x402 through Circle Gateway) are credited: the hosted
  // relayer's Gateway balance, which can be withdrawn to pay for verdict gas.
  feeAddress: process.env.JUDGE_FEE_ADDRESS || "0xf493CF092768a4B7a533359F28Db82B06D259Dc2",

  // ERC-8412 (docs/ERC-8412.md): the registry, and JudgeAttestor, the verifier a
  // client names when it preregisters a job's criteria. The judge attests every
  // ruling whose client preregistered it. ERC8412_ATTESTOR="" switches this off.
  erc8412Registry: process.env.ERC8412_REGISTRY || (ON_ARC_TESTNET ? "0x48c3a1812F2dFc762a80dbD5c65e9C7B0BB25ae4" : ""),
  erc8412Attestor: process.env.ERC8412_ATTESTOR ?? (ON_ARC_TESTNET ? "0x78E87A8E43e8E2784C12bF39eB6e2ea7C990fB15" : ""),

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
