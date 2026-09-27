// An in-memory Arc testnet for the paymaster's tests: Circle's ERC-8183 state
// machine, USDC balances and allowances, JobCreated logs the kit can decode,
// and a judge that rules with the judge service's own checkers. The kit's real
// functions run against it unchanged.
import { encodeAbiParameters, encodeEventTopics, hexToString, keccak256, toHex } from "viem";
import { ACP_ABI, ARC_TESTNET } from "../../../kit/judge-kit.js";
import { extractCriteria } from "../../../judge-service/src/criteria.js";
import { runAllChecks } from "../../../judge-service/src/checkers/index.js";
import * as kit from "../../../kit/judge-kit.js";

const ACP = ARC_TESTNET.acp.toLowerCase(), USDC = ARC_TESTNET.usdc.toLowerCase(), JUDGE = ARC_TESTNET.judge;
const STATUS = { Open: 0, Funded: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5 };
const ZERO32 = "0x" + "0".repeat(64);

export function world({ balances = {} } = {}) {
  const bal = new Map(Object.entries(balances).map(([a, v]) => [a.toLowerCase(), BigInt(v)]));
  const allowance = new Map();
  const jobs = new Map();
  const verdicts = new Map();
  const receipts = new Map();
  const calls = [];
  let nextId = 1000n, txn = 0, ts = 1_790_000_000n;
  const b = (a) => bal.get(a.toLowerCase()) ?? 0n;
  const move = (from, to, v) => {
    if (b(from) < v) throw new Error("ERC20: insufficient balance");
    bal.set(from.toLowerCase(), b(from) - v);
    bal.set(to.toLowerCase(), b(to) + v);
  };
  const tx = (logs = []) => { const h = keccak256(toHex(`tx-${++txn}`)); receipts.set(h, { status: "success", transactionHash: h, logs }); return h; };

  function walletFor(address) {
    const me = address.toLowerCase();
    return {
      account: { address },
      async writeContract({ address: to, functionName: fn, args }) {
        calls.push({ from: me, to: to.toLowerCase(), fn, args });
        if (to.toLowerCase() === USDC && fn === "approve") { allowance.set(`${me}:${String(args[0]).toLowerCase()}`, BigInt(args[1])); return tx(); }
        if (to.toLowerCase() === USDC && fn === "transfer") { move(me, args[0], BigInt(args[1])); return tx(); }
        if (to.toLowerCase() !== ACP) throw new Error(`unknown contract ${to}`);
        const [id] = args;
        const j = jobs.get(BigInt(id ?? 0));
        switch (fn) {
          case "createJob": {
            const [provider, evaluator, expiredAt, description, hook] = args;
            const jobId = nextId++;
            jobs.set(jobId, { id: jobId, client: address, provider, evaluator, description, budget: 0n, expiredAt, status: STATUS.Open, hook, escrow: 0n });
            const topics = encodeEventTopics({ abi: ACP_ABI, eventName: "JobCreated", args: { jobId, client: address, provider } });
            const data = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [evaluator, expiredAt, hook]);
            return tx([{ address: ARC_TESTNET.acp, topics, data }]);
          }
          case "setBudget":
            if (!j || j.provider.toLowerCase() !== me || j.status !== STATUS.Open) throw new Error("setBudget: not allowed");
            j.budget = BigInt(args[1]); return tx();
          case "fund": {
            if (!j || j.client.toLowerCase() !== me || j.status !== STATUS.Open || j.budget === 0n) throw new Error("fund: not allowed");
            const key = `${me}:${ACP}`;
            if ((allowance.get(key) ?? 0n) < j.budget) throw new Error("ERC20: insufficient allowance");
            allowance.set(key, allowance.get(key) - j.budget);
            move(me, ACP, j.budget); j.escrow = j.budget; j.status = STATUS.Funded; return tx();
          }
          case "submit":
            if (!j || j.provider.toLowerCase() !== me || j.status !== STATUS.Funded) throw new Error("submit: not allowed");
            j.deliverable = args[1]; j.optParams = args[2]; j.status = STATUS.Submitted; j.submitTx = tx(); return j.submitTx;
          case "claimRefund":
            if (!j || j.status === STATUS.Completed || j.status === STATUS.Rejected) throw new Error("claimRefund: nothing to refund");
            move(ACP, j.client, j.escrow); j.escrow = 0n; j.status = STATUS.Expired; return tx();
          default:
            throw new Error(`fake ACP: ${fn} is not callable by ${address}`);
        }
      },
    };
  }

  const publicClient = {
    async waitForTransactionReceipt({ hash }) { return receipts.get(hash); },
    async readContract({ functionName, args }) {
      if (functionName === "getJob") {
        const j = jobs.get(BigInt(args[0]));
        if (!j) throw new Error("execution reverted");
        return { ...j };
      }
      if (functionName === "getVerdict") return verdicts.get(BigInt(args[0])) ?? { pass: false, score: 0, timestamp: 0n, evidenceHash: ZERO32 };
      if (functionName === "balanceOf") return b(args[0]);
      throw new Error(`fake chain: unexpected read ${functionName}`);
    },
  };

  /** The judge rules exactly like the service: criteria from the description, bytes from the provider's data URI. */
  async function rule(jobId) {
    const j = jobs.get(BigInt(jobId));
    if (!j || j.status !== STATUS.Submitted) throw new Error(`job ${jobId} is not Submitted`);
    const uri = hexToString(j.optParams).replace(/^deliverableURI:\s*/, "");
    const content = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
    const r = await runAllChecks(extractCriteria(j.description), { content, source: "fake" });
    ts += 60n;
    verdicts.set(j.id, { pass: r.pass, score: r.score, threshold: r.threshold, timestamp: ts, evidenceHash: keccak256(toHex(`evidence-${j.id}`)) });
    if (r.pass) { move(ACP, j.provider, j.escrow); j.status = STATUS.Completed; } else { move(ACP, j.client, j.escrow); j.status = STATUS.Rejected; }
    j.escrow = 0n;
    return { result: "judged", jobId: String(j.id), pass: r.pass, score: r.score, txHash: tx() };
  }

  /** Scripted contractors: how each one reacts when offered a job. */
  function contractor(address, behavior) {
    const wallet = walletFor(address);
    return async function onOffer({ jobId, amount, criteria, milestone }) {
      if (behavior === "silent") return;
      const quote = behavior === "greedy" ? amount * 2n : amount;
      await kit.setBudget({ walletClient: wallet, publicClient, jobId, amount: quote });
      return async function afterFunded() {
        if (behavior === "ghost") return;
        const good = milestone.demoWork?.good ?? "ERC-8183 escrow on Arc holds USDC until the evaluator rules on the work.";
        const bad = milestone.demoWork?.bad ?? good.replace("USDC", "dollars");
        await kit.submitDeliverable({ walletClient: wallet, publicClient, jobId, content: behavior === "sloppy" ? bad : good, mediaType: "text/plain" });
      };
    };
  }

  return { walletFor, publicClient, rule, contractor, calls, jobs, verdicts, balance: b, JUDGE, STATUS };
}
