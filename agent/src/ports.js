// Live wiring on Arc testnet: viem clients, the paymaster's guarded wallet,
// the judge paid per ruling over x402 through Circle Gateway, and chain polling.
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import * as kit from "../../kit/judge-kit.js";
import { judgeAbi } from "../../judge-service/src/abi.js";
import { guardWallet } from "./guard.js";
import { usdc } from "./policy.js";

export const arc = defineChain({
  id: kit.ARC_TESTNET.chainId, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || kit.ARC_TESTNET.rpc] } },
});
const transport = () => http(undefined, { retryCount: 6, retryDelay: 700 });
export const makePublicClient = () => createPublicClient({ chain: arc, transport: transport() });
export const makeWallet = (key) => createWalletClient({ account: privateKeyToAccount(key), chain: arc, transport: transport() });

export const JUDGE_PRICE = usdc("0.01");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function livePorts({ paymasterKey, contractors, api = kit.ARC_TESTNET.api, publicClient = makePublicClient(), pollMs = 3000, timeoutMs = 180_000, expiresInSeconds = 24 * 3600 }) {
  const gate = guardWallet(makeWallet(paymasterKey), { publicClient, acp: kit.ARC_TESTNET.acp, usdc: kit.ARC_TESTNET.usdc, judge: kit.ARC_TESTNET.judge, abi: kit.ACP_ABI });

  // A second, independent fee limit inside the payment client: whatever the
  // policy said, it never signs anything but the judge's price on Arc testnet.
  const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: paymasterKey });
  gateway.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (r.network !== `eip155:${kit.ARC_TESTNET.chainId}`) return { abort: true, reason: `refusing to pay on ${r.network}` };
    if (String(r.asset).toLowerCase() !== kit.ARC_TESTNET.usdc.toLowerCase()) return { abort: true, reason: "refusing to pay in anything but USDC" };
    if (BigInt(r.amount) !== JUDGE_PRICE) return { abort: true, reason: `refusing a judge fee of ${r.amount} (expected ${JUDGE_PRICE})` };
  });

  const readJob = (jobId) => publicClient.readContract({ address: kit.ARC_TESTNET.acp, abi: kit.ACP_ABI, functionName: "getJob", args: [BigInt(jobId)] });
  const chain = {
    createJob: ({ provider, criteria, title }) => kit.createJudgedJob({ walletClient: gate, publicClient, provider, criteria, title, expiresInSeconds }),
    fund: ({ jobId, amount }) => kit.fundJob({ walletClient: gate, publicClient, jobId, amount }),
    readJob,
    readVerdict: (jobId) => publicClient.readContract({ address: kit.ARC_TESTNET.judge, abi: judgeAbi, functionName: "getVerdict", args: [BigInt(jobId)] }),
    async waitForJob(jobId, until) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const j = await readJob(jobId).catch(() => null);
        if (j && until(j)) return j;
        if (Date.now() + pollMs > deadline) return null;
        await sleep(pollMs);
      }
    },
  };

  const judge = {
    price: JUDGE_PRICE,
    async rule({ jobId }) {
      const res = await gateway.pay(`${api}/api/x402/judge`, { method: "POST", body: { jobId: String(jobId) } });
      const d = res.data || {};
      if (d.result === "judged" && d.verdict) {
        // Someone else asked first (or the daily sweep ruled): answered free.
        return { result: "already-judged", pass: d.verdict.pass, score: d.verdict.score, txHash: null, payment: { charged: false } };
      }
      if (d.result !== "judged") throw new Error(`the judge answered ${d.result}${d.error ? `: ${d.error}` : ""}`);
      return { result: d.result, pass: d.pass, score: d.score, txHash: d.txHash, payment: d.payment };
    },
  };

  const pending = new Map();
  const market = {
    async offer(job, c) {
      const agent = contractors.get(c.address.toLowerCase());
      if (!agent) return; // a real contractor watches the chain itself
      const next = await agent.onOffer(job);
      if (next) pending.set(String(job.jobId), next);
    },
    async funded(job) {
      const next = pending.get(String(job.jobId));
      pending.delete(String(job.jobId));
      if (next) await next();
    },
  };

  return { gate, chain, judge, market, gateway, publicClient, judgeAddress: kit.ARC_TESTNET.judge };
}
