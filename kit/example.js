// End to end on Arc testnet: a client posts a judged job, a provider does the
// work, and Judge Protocol settles the escrow. Run it:
//
//   CLIENT_KEY=0x... PROVIDER_KEY=0x... node example.js
//
// Both keys need a little testnet USDC (Arc uses USDC for gas): https://faucet.circle.com
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as kit from "./judge-kit.js";

const arc = defineChain({
  id: kit.ARC_TESTNET.chainId, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || kit.ARC_TESTNET.rpc] } },
});
const publicClient = createPublicClient({ chain: arc, transport: http() });
const wallet = (key) => createWalletClient({ account: privateKeyToAccount(key), chain: arc, transport: http() });
const client = wallet(process.env.CLIENT_KEY);
const provider = wallet(process.env.PROVIDER_KEY);

// 1. The client writes down what "done" means, before any work exists.
const criteria = { version: 1, passThreshold: 100, checks: [
  { kind: "length", params: { min: 20, max: 400 } },
  { kind: "contains", params: { all: ["ERC-8183", "USDC", "Arc"] } },
] };
const job = await kit.createJudgedJob({ walletClient: client, publicClient, provider: provider.account.address,
  criteria, title: "Explain ERC-8183 escrow in plain English.", expiresInSeconds: 24 * 3600 });
console.log(`job ${job.jobId} created, evaluator = Judge Protocol`);

// 2. The provider proposes a price; the client funds the escrow.
const amount = 100_000n; // 0.10 USDC
await kit.setBudget({ walletClient: provider, publicClient, jobId: job.jobId, amount });
await kit.fundJob({ walletClient: client, publicClient, jobId: job.jobId, amount });
console.log(`escrow funded: ${Number(amount) / 1e6} USDC`);

// 3. The provider checks its own work against the criteria before submitting.
const work = "ERC-8183 lets one agent hire another on Arc: the client locks USDC in escrow, the provider "
  + "delivers, and a neutral evaluator decides whether the work met the criteria written into the job. "
  + "Pass pays the provider; fail refunds the client.";
const check = await kit.dryRun({ criteria, content: work });
console.log(`dry run: score ${check.score}, pass ${check.pass}`);

// 4. Submit, then ask the judge to rule. The judge settles the escrow on chain.
const sub = await kit.submitDeliverable({ walletClient: provider, publicClient, jobId: job.jobId, content: work, mediaType: "text/plain" });
const ruling = await kit.requestRuling({ jobId: job.jobId, submitTx: sub.txHash });
console.log(`ruling: ${ruling.result} ${ruling.pass === undefined ? "" : ruling.pass ? "PASS" : "REJECT"} tx ${ruling.txHash || ""}`);
const final = await kit.waitForRuling({ jobId: job.jobId });
console.log(`on chain: ${final.verdict.pass ? "PASS, escrow released" : "REJECT, client refunded"}`);
console.log(`verify it yourself: ${kit.ARC_TESTNET.verifier} (job ${job.jobId})`);
