// Paid rulings over x402, settled by Circle Gateway (batched, gasless for the
// payer) on Arc testnet: 0.01 USDC per ruling. The free POST /api/judge keeps
// working on testnet; this is the fee model, since Circle's ERC-8183 contract
// has no evaluator fee.
//
//   1. Only a job waiting for a ruling (names the judge, Submitted, no verdict,
//      a budget above the floor, valid criteria) is asked to pay. Everything
//      else is answered free.
//   2. A payment is checked here first (terms, recipient, amount, validity,
//      canonical numbers, the EIP-712 signature), then by Gateway's verify,
//      then against the payer's Gateway balance.
//   3. The judge prepares the verdict (loads the deliverable, runs the checks)
//      without signing anything. Only then is the payment settled, and only a
//      settled payment gets the verdict signed and sent. Gateway refuses to
//      settle a used nonce or an empty balance, so a replayed payment or a
//      burst against one balance buys at most one ruling, across instances.
//   4. No verdict ready (abstain, retry later, not found): nothing is settled.
//      If the verdict transaction fails after the payment settled, the answer
//      says so and the daily sweep settles the verdict.
import { formatUnits, getAddress, isAddress, parseUnits, recoverTypedDataAddress } from "viem";
import { BatchFacilitatorClient, GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS } from "@circle-fin/x402-batching/server";
import { config } from "./config.js";
import { judgeNow as defaultJudgeNow, jobStatus as defaultJobStatus, rulingPrecheck as defaultPrecheck, parseJobIdInput } from "./judge-now.js";

export const ARC_TESTNET_NETWORK = "eip155:5042002";
export const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
export const PRICE_ATOMIC = "10000"; // 0.01 USDC (6 decimals)
export const PRICE_LABEL = "0.01 USDC";
export const GATEWAY_TESTNET_URL = "https://gateway-api-testnet.circle.com";
export const RESOURCE_URL = "https://judge-protocol-api.vercel.app/api/x402/judge";
const ARC_GATEWAY_DOMAIN = 26;
const MAX_HEADER_BYTES = 8 * 1024;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/; // canonical uint256 in decimal: no sign, spaces, hex or leading zeros
const FREE_PATH = "the free POST /api/judge still works on testnet";
const BATCHING = { name: "GatewayWalletBatched", version: "1" };
const TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const jsonable = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const out = (status, body, headers = {}) => ({ status, body: jsonable(body), headers });
const same = (x, y) => String(x ?? "").toLowerCase() === String(y ?? "").toLowerCase();
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]);
}

/** A depositor's available Circle Gateway balance on Arc testnet, in USDC atomic units. */
export async function gatewayBalance(address, { url = GATEWAY_TESTNET_URL, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${url}/v1/balances`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor: address, domain: ARC_GATEWAY_DOMAIN }] }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => null);
  const entry = (data?.balances || []).find((b) => b.domain === ARC_GATEWAY_DOMAIN && same(b.depositor, address));
  if (!res.ok || typeof entry?.balance !== "string") throw new Error(`Gateway balance lookup failed (${res.status})`);
  return parseUnits(entry.balance, 6);
}

/** Gateway's record of a payment, by its nonce (null if Gateway has never seen it). */
export async function gatewayTransfer(nonce, { url = GATEWAY_TESTNET_URL, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${url}/v1/x402/transfers?nonce=${encodeURIComponent(nonce)}&network=${ARC_TESTNET_NETWORK}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Gateway transfer lookup failed (${res.status})`);
  const data = await res.json().catch(() => null);
  return (data?.transfers || []).find((t) => same(t.nonce, nonce) && t.status !== "failed") ?? null;
}

/** Local checks on a payment-signature header, before anything leaves this process. */
async function checkPayment(header, terms, nowSec) {
  if (typeof header !== "string") return { status: 400, error: "send exactly one payment-signature header, as a single string" };
  if (header.length > MAX_HEADER_BYTES) return { status: 400, error: "the payment-signature header is too large" };
  let p;
  try { p = JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { p = null; }
  const a = p?.payload?.authorization, sig = p?.payload?.signature, acc = p?.accepted;
  if (!p || typeof p !== "object" || !a || typeof a !== "object" || typeof sig !== "string" || !acc || typeof acc !== "object") {
    return { status: 400, error: "malformed payment: expected base64 JSON with payload.authorization, payload.signature and accepted (x402 v2)" };
  }
  if (p.x402Version !== 2) return { status: 400, error: "x402Version must be 2" };
  const termsMatch = acc.scheme === terms.scheme && acc.network === terms.network && same(acc.asset, terms.asset)
    && String(acc.amount) === terms.amount && same(acc.payTo, terms.payTo) && acc.extra?.name === terms.extra.name
    && acc.extra?.version === terms.extra.version && same(acc.extra?.verifyingContract, terms.extra.verifyingContract);
  if (!termsMatch) return { status: 402, error: "the payment does not accept this endpoint's terms (price, recipient, network or asset)" };
  if (!isAddress(String(a.from)) || !isAddress(String(a.to)) || !/^0x[0-9a-fA-F]{64}$/.test(String(a.nonce))) {
    return { status: 400, error: "malformed payment authorization" };
  }
  if (!same(a.to, terms.payTo)) return { status: 402, error: "the payment is not addressed to the judge's fee address" };
  if (![a.value, a.validAfter, a.validBefore].every((x) => typeof x === "string" && DECIMAL.test(x))) {
    return { status: 400, error: "authorization value, validAfter and validBefore must be canonical decimal strings" };
  }
  const value = BigInt(a.value), after = BigInt(a.validAfter), before = BigInt(a.validBefore);
  if (a.value !== terms.amount) return { status: 402, error: `the payment must be exactly ${PRICE_LABEL}` };
  const t = BigInt(nowSec);
  if (after > t || before <= t) return { status: 402, error: "the payment authorization is not valid now" };
  let signer = null;
  try {
    signer = await recoverTypedDataAddress({
      domain: { ...BATCHING, chainId: Number(terms.network.split(":")[1]), verifyingContract: getAddress(terms.extra.verifyingContract) },
      types: TYPES, primaryType: "TransferWithAuthorization",
      message: { from: getAddress(a.from), to: getAddress(a.to), value, validAfter: after, validBefore: before, nonce: a.nonce },
      signature: sig,
    });
  } catch { signer = null; }
  if (!signer || !same(signer, a.from)) return { status: 402, error: "the payment signature does not match the payer (it must be signed by the paying address for Arc testnet)" };
  return { ok: true, payload: p, from: getAddress(a.from), nonce: String(a.nonce).toLowerCase() };
}

export function createPaidJudge({
  facilitator = new BatchFacilitatorClient({ url: GATEWAY_TESTNET_URL }),
  balanceOf = gatewayBalance,
  lookupTransfer = gatewayTransfer,
  payTo = config.feeAddress,
  resourceUrl = RESOURCE_URL,
  deps = {},
  judgeNow = defaultJudgeNow,
  jobStatus = defaultJobStatus,
  precheck = defaultPrecheck,
  now = () => Math.floor(Date.now() / 1000),
  timeoutMs = 8000,
} = {}) {
  let arcKind = null;          // Gateway's Arc testnet entry, fetched once per instance
  const inFlight = new Set();  // nonces being processed right now (a cheap first line; Gateway is the real one)
  const spent = new Set();     // nonces this instance has settled

  async function terms() {
    if (!arcKind) {
      const s = await withTimeout(facilitator.getSupported(), timeoutMs, "Gateway supported list");
      arcKind = (s?.kinds || []).find((k) => k.network === ARC_TESTNET_NETWORK && k.scheme === "exact" && k.extra?.verifyingContract) || null;
      if (!arcKind) throw new Error("Circle Gateway does not list Arc testnet");
    }
    return { scheme: "exact", network: ARC_TESTNET_NETWORK, asset: USDC_ARC_TESTNET, amount: PRICE_ATOMIC, payTo: getAddress(payTo),
      maxTimeoutSeconds: GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
      extra: { ...BATCHING, verifyingContract: getAddress(arcKind.extra.verifyingContract) } };
  }

  /** Settle, and if the answer never comes back, ask Gateway whether it went through. */
  async function settle(c, t) {
    let s;
    try { s = await withTimeout(facilitator.settle(c.payload, t), timeoutMs, "Gateway settle"); } catch (e) {
      let found;
      try { found = await withTimeout(lookupTransfer(c.nonce), timeoutMs, "Gateway transfer lookup"); } catch {
        return { charged: "unknown", reason: `${e.message}; the payment could not be looked up` };
      }
      return found ? { charged: true, transaction: found.id, payer: found.fromAddress ?? c.from, via: "lookup" }
        : { charged: false, reason: `${e.message}; Gateway has no record of the payment` };
    }
    if (s?.success) return { charged: true, transaction: s.transaction, payer: s.payer || c.from };
    return { charged: false, reason: s?.errorReason || "unknown" };
  }

  return async function paidJudge({ jobId, submitTx, paymentHeader } = {}) {
    if (parseJobIdInput(jobId) === null) return out(400, { error: "jobId must be a positive integer", charged: false });
    if (submitTx !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(String(submitTx))) {
      return out(400, { error: "submitTx must be a 32-byte transaction hash", charged: false });
    }

    // 1. Is a ruling possible? If not, answer free and never ask for money.
    const st = await jobStatus({ jobId }, deps);
    if (st.status === 200 && st.body.result === "judged") {
      return out(200, { result: "already-judged", jobId: st.body.jobId, verdict: st.body.verdict, charged: false });
    }
    if (st.status !== 200 || st.body.result !== "pending") return out(st.status, { ...st.body, charged: false });
    const pre = await precheck({ jobId }, deps);
    if (pre) return out(pre.status, { ...pre.body, charged: false });

    // 2. The terms, straight from Circle Gateway's supported list.
    let t;
    try { t = await terms(); } catch {
      return out(503, { error: `the payment service (Circle Gateway) is unavailable; ${FREE_PATH}`, charged: false });
    }
    const required = { x402Version: 2, accepts: [t], resource: { url: resourceUrl, mimeType: "application/json",
      description: `One Judge Protocol ruling on an ERC-8183 job: ${PRICE_LABEL}, settled only when the judge has a verdict ready` } };
    const again = { "PAYMENT-REQUIRED": b64(required) };
    if (paymentHeader === undefined || paymentHeader === null || paymentHeader === "") {
      return out(402, { ...required, error: `payment required: ${PRICE_LABEL} through Circle Gateway on Arc testnet`, charged: false }, again);
    }

    // 3. Check the payment: locally, then Gateway's verify, then the payer's balance.
    const c = await checkPayment(paymentHeader, t, now());
    if (!c.ok) return out(c.status, { error: c.error, accepts: [t], charged: false }, c.status === 402 ? again : {});
    if (spent.has(c.nonce) || inFlight.has(c.nonce)) {
      return out(402, { error: "this payment was already used; sign a new one", accepts: [t], charged: false }, again);
    }
    inFlight.add(c.nonce);
    try {
      let v;
      try { v = await withTimeout(facilitator.verify(c.payload, t), timeoutMs, "Gateway verify"); } catch {
        return out(503, { error: `could not verify the payment with Circle Gateway; ${FREE_PATH}`, charged: false });
      }
      if (!v?.isValid) return out(402, { error: `payment rejected by Circle Gateway: ${v?.invalidReason || "invalid"}`, accepts: [t], charged: false }, again);
      let have;
      try { have = await withTimeout(balanceOf(c.from), timeoutMs, "Gateway balance"); } catch {
        return out(503, { error: `could not read the payer's Circle Gateway balance; ${FREE_PATH}`, charged: false });
      }
      if (have < BigInt(t.amount)) {
        return out(402, { error: `insufficient Gateway balance: deposit USDC into Circle Gateway on Arc testnet first (available ${formatUnits(have, 6)}, price ${PRICE_LABEL})`,
          accepts: [t], charged: false }, again);
      }

      // 4. Prepare the verdict; settle the payment; only then sign and send it.
      let receipt = null;
      const r = await judgeNow({ jobId, submitTx }, { ...deps, beforeSettle: async () => {
        const s = await settle(c, t);
        if (s.charged === false) {
          return { ok: false, status: 402, body: { result: "payment-failed", jobId: String(jobId), charged: false, error: `payment could not be settled: ${s.reason}` } };
        }
        receipt = s;
        spent.add(c.nonce);
        return { ok: true };
      } });

      if (!receipt) {
        if (r.body.result === "payment-failed") return out(402, { ...r.body, accepts: [t] }, again);
        const why = r.body.reason || r.body.error;
        return out(r.status, { ...r.body, charged: false, error: `not charged: ${r.body.result ?? "error"}${why ? ` (${why})` : ""}` });
      }
      const payment = { charged: receipt.charged, amount: "0.01", asset: "USDC", network: t.network, transaction: receipt.transaction ?? null,
        payer: receipt.payer ?? c.from, ...(receipt.charged === "unknown" ? { note: `Gateway did not confirm the payment; look up nonce ${c.nonce}` } : {}) };
      const headers = receipt.charged === true ? { "PAYMENT-RESPONSE": b64({ success: true, transaction: receipt.transaction, network: t.network, payer: payment.payer }) } : {};
      if (r.body.result === "judged") return out(200, { ...r.body, charged: receipt.charged, payment }, headers);
      if (r.body.result === "already-judged") {
        return out(200, { ...r.body, charged: receipt.charged, payment, note: "another request settled the same verdict first; your payment covered this ruling" }, headers);
      }
      return out(r.status, { ...r.body, charged: receipt.charged, payment,
        error: "your payment settled but the verdict transaction failed; the daily sweep settles this job within a day" }, headers);
    } finally {
      inFlight.delete(c.nonce);
    }
  };
}
