// A deterministic evaluation sold over x402: 0.01 USDC through Circle Gateway, on the Arc network this judge runs
// on (mainnet or testnet). It is POST /api/evaluate with a price: the same checks, score, decision and evidenceHash,
// for any agent that can pay, with no account and no key. The judge signs nothing and settles nothing on chain here.
//
//   1. The evaluation is computed first, free of charge. Bad input (400, 413, 422) is answered free, and so is a
//      criteria block that needs a live network probe (http-endpoint), which the paid dry run does not do.
//   2. Only a result that is ready is asked to pay: 402 with the terms until a payment-signature header comes.
//   3. The payment is checked here (terms, recipient, amount, validity, the EIP-712 signature), then by Gateway's
//      verify, then against the payer's Gateway balance, and only then settled. A result goes out only for a
//      settled payment (or one Gateway could not confirm either way, which is said in the answer).
import { formatUnits } from "viem";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { NETWORKS, PRICE_LABEL, checkPayment, gatewayBalance, gatewayTransfer, makeTerms, makeSettle, withTimeout } from "./x402.js";
import { dryRunEvaluate } from "./evaluate.js";
import { config } from "./config.js";

const FREE_PATH = "the free POST /api/evaluate still works";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const jsonable = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const out = (status, body, headers = {}) => ({ status, body: jsonable(body), headers });

/** The Gateway network for a chain id, or null when this judge's chain has none. */
export function networkFor(chainId) {
  return NETWORKS[Number(chainId)] ?? null;
}

export function createPaidEvaluate({
  chainId = config.chain.id,
  facilitator,
  balanceOf,
  lookupTransfer,
  payTo = config.feeAddress,
  resourceUrl,
  now = () => Math.floor(Date.now() / 1000),
  timeoutMs = 8000,
} = {}) {
  const net = networkFor(chainId);
  if (!net) throw new Error(`no Circle Gateway network for chain ${chainId}`);
  facilitator ??= new BatchFacilitatorClient({ url: net.gatewayUrl });
  balanceOf ??= (address) => gatewayBalance(address, { url: net.gatewayUrl, domain: net.domain });
  lookupTransfer ??= (nonce) => gatewayTransfer(nonce, { url: net.gatewayUrl, network: net.network });
  const terms = makeTerms({ facilitator, network: net.network, asset: net.usdc, payTo, timeoutMs, label: net.label });
  const settle = makeSettle({ facilitator, lookupTransfer, timeoutMs });
  const inFlight = new Set();
  const spent = new Set();

  return async function paidEvaluate({ input, paymentHeader, resource = resourceUrl } = {}) {
    // 1. The evaluation itself. Anything that is not a ready result is answered free.
    const r = await dryRunEvaluate(input ?? {}, { allowLiveProbes: false });
    if (r.status !== 200) return out(r.status, { ...r.body, charged: false });
    if (r.body.score === null) {
      return out(400, { error: `the paid evaluation runs deterministic checks only; remove the live checks (${r.body.notRun.join(", ")}), or use ${FREE_PATH}`, charged: false });
    }

    // 2. The terms, straight from Circle Gateway's supported list.
    let t;
    try { t = await terms(); } catch {
      return out(503, { error: `the payment service (Circle Gateway) is unavailable; ${FREE_PATH}`, charged: false });
    }
    const required = { x402Version: 2, accepts: [t], resource: { url: resource ?? null, mimeType: "application/json",
      description: `One Judge Protocol deterministic evaluation: ${PRICE_LABEL}, settled only when the result is ready` } };
    const again = { "PAYMENT-REQUIRED": b64(required) };
    if (paymentHeader === undefined || paymentHeader === null || paymentHeader === "") {
      return out(402, { ...required, error: `payment required: ${PRICE_LABEL} through Circle Gateway on ${net.label}`, charged: false }, again);
    }

    // 3. Check the payment: locally, then Gateway's verify, then the payer's balance, then settle.
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
        return out(402, { error: `insufficient Gateway balance: deposit USDC into Circle Gateway on ${net.label} first (available ${formatUnits(have, 6)}, price ${PRICE_LABEL})`,
          accepts: [t], charged: false }, again);
      }
      const s = await settle(c, t);
      if (s.charged === false) return out(402, { error: `payment could not be settled: ${s.reason}`, accepts: [t], charged: false }, again);
      spent.add(c.nonce);
      const payment = { charged: s.charged, amount: "0.01", asset: "USDC", network: t.network, transaction: s.transaction ?? null,
        payer: s.payer ?? c.from, ...(s.charged === "unknown" ? { note: `Gateway did not confirm the payment; look up nonce ${c.nonce}` } : {}) };
      const headers = s.charged === true ? { "PAYMENT-RESPONSE": b64({ success: true, transaction: s.transaction, network: t.network, payer: payment.payer }) } : {};
      return out(200, { ...r.body, charged: s.charged, payment }, headers);
    } finally {
      inFlight.delete(c.nonce);
    }
  };
}
