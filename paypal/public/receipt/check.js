// Checks a Judge Pay receipt in the browser. Given the receipt and the delivered file, it recomputes everything the
// receipt claims: its own hash, the hash of the agreed checks, the file against the hash that was judged, every check
// run again here, the evidence hash, the decision, the worker's payout, and whether PayPal's record ids agree with the
// decision. Nothing leaves the page. PayPal itself is not visible from here, so its records are compared with the
// decision, not confirmed: the ids are listed for the buyer to look up in their own PayPal account.
import { runChecks, criteriaHash, keccakBytes, keccakUtf8, canonicalize, evidenceHashOf, validateCriteria } from "../verify/app.js";

export const RECEIPT_KIND = "judge-pay/receipt@1";
export const STEPS = ["format", "receipt hash", "criteria hash", "delivery", "checks", "evidence hash", "decision", "payout", "paypal"];
const FIELDS = ["jobId", "criteria", "criteriaHash", "price", "currency", "feeBps", "payout", "deliverable", "results",
  "score", "threshold", "pass", "evidenceHash", "decision", "paypal", "receiptHash"];
const AMOUNT = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/;

function cents(value) {
  const s = String(value ?? "");
  if (!AMOUNT.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
const dollars = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/** The worker's share after the fee, rounded down to the cent exactly as the server does; null for anything that is
 *  not an amount or a fee. */
export function payoutOf(price, feeBps) {
  const c = cents(price);
  if (c === null || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) return null;
  return dollars(Math.floor((c * (10_000 - feeBps)) / 10_000));
}

function paypalStep(decision, p) {
  const ids = [p.orderId && `order ${p.orderId}`, p.captureId && `capture ${p.captureId}`, p.payoutBatchId && `payout batch ${p.payoutBatchId}`]
    .filter(Boolean).join(", ");
  const look = ids ? ` Look these up in PayPal to confirm: ${ids}.` : "";
  if (decision === "release") {
    if (p.voided) return [false, "the work was released, yet the PayPal hold is marked voided"];
    if (!p.captureId) return [null, "not captured yet: PayPal still holds the money" + look];
    if (!p.payoutBatchId) return [null, "captured; the worker's payout has not been sent yet." + look];
    return [true, "capture and payout batch are recorded. Confirm both in PayPal." + look];
  }
  if (decision === "refund") {
    if (p.captureId) return [false, "the work was refunded, yet PayPal shows a capture"];
    if (!p.voided) return [null, "the PayPal hold has not been released yet" + look];
    return [true, "the hold was voided, so the buyer was not charged." + look];
  }
  return [false, `unknown decision ${JSON.stringify(decision)}`];
}

/**
 * Check a receipt. `bytes` is the delivered file as a Uint8Array or ArrayBuffer, or null when the buyer has not
 * added it yet. `verified` is true only when every step passes; a step that cannot run yet has ok: null.
 */
export async function checkReceipt(receipt, bytes) {
  const steps = [];
  const add = (name, ok, detail) => steps.push({ name, ok, detail });
  const result = () => ({ verified: steps.length === STEPS.length && steps.every((s) => s.ok === true), steps,
    jobId: receipt?.jobId ?? null, decision: receipt?.decision ?? null });

  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || receipt.kind !== RECEIPT_KIND) {
    add("format", false, `this is not a Judge Pay receipt (expected kind ${RECEIPT_KIND})`);
    return result();
  }
  const missing = FIELDS.filter((k) => !(k in receipt));
  if (missing.length) {
    add("format", false, `the receipt is missing: ${missing.join(", ")}`);
    return result();
  }
  add("format", true, `a Judge Pay receipt for job ${receipt.jobId}`);

  const { receiptHash, ...issued } = receipt;
  const rh = keccakUtf8(canonicalize(issued));
  add("receipt hash", rh === receiptHash, rh === receiptHash ? "the receipt's contents match its own hash"
    : "the receipt's contents do not match its own hash: it was edited after the hash was made");

  const valid = validateCriteria(receipt.criteria);
  const live = Array.isArray(receipt.criteria?.checks) && receipt.criteria.checks.some((c) => c?.kind === "http-endpoint");
  const ch = valid.valid ? criteriaHash(receipt.criteria) : null;
  if (!valid.valid) add("criteria hash", false, `the agreed checks are not valid: ${valid.reason}`);
  else if (live) add("criteria hash", false, "Judge Pay never takes checks that call out to the network");
  else add("criteria hash", ch === receipt.criteriaHash, ch === receipt.criteriaHash
    ? `the listed checks match the criteria hash in this receipt (${ch})`
    : "the listed checks do not match the criteria hash in this receipt, so the receipt contradicts itself");

  const u8 = bytes == null ? null : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const runnable = valid.valid && !live;
  if (!u8) {
    add("delivery", null, "add the delivered file to recompute the checks");
    add("checks", null, "waiting for the delivered file");
    add("evidence hash", null, "waiting for the delivered file");
  } else {
    const k = keccakBytes(u8);
    const same = k === receipt.deliverable?.keccak && u8.length === receipt.deliverable?.bytes;
    add("delivery", same, same ? `the file you hold is the one that was judged (${u8.length} bytes)`
      : `this file does not match the delivery that was judged (${u8.length} bytes, hash ${k})`);
    if (!same || !runnable) {
      const why = !same ? "the file is not the judged delivery" : "the agreed checks are not valid";
      add("checks", null, `not run: ${why}`);
      add("evidence hash", null, `not run: ${why}`);
    } else {
      const r = await runChecks(receipt.criteria, u8);
      const claimed = Array.isArray(receipt.results) ? receipt.results : [];
      const each = r.results.length === claimed.length
        && r.results.every((x, i) => claimed[i]?.kind === x.kind && !!claimed[i]?.pass === !!x.pass);
      const agree = each && r.score === receipt.score && r.threshold === receipt.threshold && r.pass === !!receipt.pass;
      const summary = r.results.map((x) => `${x.kind} ${x.pass ? "passed" : "failed"}`).join(", ");
      add("checks", agree, agree ? `run again here: ${summary}; score ${r.score}, ${r.threshold} needed`
        : `run again here, the checks give score ${r.score} (${r.pass ? "pass" : "fail"}), but the receipt says ${receipt.score} (${receipt.pass ? "pass" : "fail"})`);
      const eh = evidenceHashOf({ jobId: receipt.jobId, criteriaHash: receipt.criteriaHash, deliverable: k, criteria: receipt.criteria,
        results: r.results, score: r.score, threshold: r.threshold, pass: r.pass });
      add("evidence hash", eh === receipt.evidenceHash, eh === receipt.evidenceHash ? "the evidence hash matches the recomputed ruling"
        : "the evidence hash does not match the recomputed ruling");
    }
  }

  const expected = receipt.pass ? "release" : "refund";
  add("decision", receipt.decision === expected, receipt.decision === expected
    ? (expected === "release" ? "every agreed check passed, so the money goes to the worker" : "a check failed, so the buyer is refunded")
    : `the receipt says ${JSON.stringify(receipt.decision)}, but a ${receipt.pass ? "pass" : "fail"} means ${expected}`);

  const due = payoutOf(receipt.price, receipt.feeBps);
  add("payout", due !== null && due === receipt.payout, due !== null && due === receipt.payout
    ? `${receipt.payout} ${receipt.currency} to the worker: ${receipt.price} less the ${receipt.feeBps / 100}% fee, rounded down`
    : `the payout should be ${due ?? "(not computable)"} ${receipt.currency}, but the receipt says ${receipt.payout}`);

  const [ok, detail] = paypalStep(receipt.decision, receipt.paypal && typeof receipt.paypal === "object" ? receipt.paypal : {});
  add("paypal", ok, detail);
  return result();
}
