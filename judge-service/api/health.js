// GET /api/health: who the judge is, whether its signer is authorized on-chain,
// and whether it has gas. Public data only; never any key material.
import { formatEther } from "viem";
import { config } from "../src/config.js";
import { judgeAbi } from "../src/abi.js";
import { makeClients as defaultMakeClients } from "../src/signer.js";
import { cors } from "../src/vercel-util.js";

const LOW_GAS = 200_000_000_000_000_000n; // 0.2 USDC (Arc's native gas token, 18 decimals)

export function createHealthHandler(deps = {}) {
  return async function handler(req, res) {
    cors(res);
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    const base = {
      judge: config.judgeAddress, acp: config.acpAddress, chainId: config.chain.id,
      minJobBudgetUSDC: String(Number(process.env.MIN_JOB_BUDGET || 10_000) / 1e6),
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || null,
    };
    let clients;
    try { clients = deps.clients || (deps.makeClients || defaultMakeClients)(); } catch {
      res.status(503).json({ ...base, ok: false, warnings: ["signer not configured"] });
      return;
    }
    const signer = clients.signerAccount.address;
    const relayer = clients.relayerWallet.account.address;
    const warnings = [];
    let signerAuthorized = false, balance = 0n;
    try {
      signerAuthorized = await clients.publicClient.readContract({ address: config.judgeAddress, abi: judgeAbi, functionName: "isSigner", args: [signer] });
      balance = await clients.publicClient.getBalance({ address: relayer });
    } catch (e) {
      warnings.push("chain read failed: " + String(e.message || e).slice(0, 120));
    }
    if (!signerAuthorized) warnings.push("signer is not authorized on JudgeEvaluator");
    if (signer.toLowerCase() === relayer.toLowerCase()) warnings.push("signer and relayer use the same key (use a separate relayer)");
    if (balance < LOW_GAS) warnings.push("relayer gas is low");
    res.status(200).json({ ...base, ok: warnings.length === 0, signer, signerAuthorized, relayer,
      relayerBalanceUSDC: formatEther(balance).replace(/\.0$/, ""), warnings });
  };
}

export default createHealthHandler();
