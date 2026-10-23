// The dashboard's data layer: public job views in, grid rows out. A row is built from listed fields only, so a field
// that should never be shown (a worker's email, the delivered bytes) cannot reach the grid even if a view carries it.

export const STATUS = {
  posted: "Waiting for the buyer",
  funding: "Buyer approving in PayPal",
  funded: "Money held by PayPal",
  judged: "Judged, moving the money",
  captured: "Captured, paying the worker",
  paid: "Paid",
  refunded: "Refunded",
  expired: "Expired, hold released",
  failed: "Needs attention",
};
const OPEN = new Set(["posted", "funding", "funded", "judged", "captured"]);

const text = (v) => (typeof v === "string" ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Grid rows from an array of public job views. */
export function toRows(views) {
  if (!Array.isArray(views)) throw new TypeError("expected an array of jobs");
  return views.map((v, i) => {
    if (!v || typeof v !== "object") throw new TypeError(`job ${i} is not an object`);
    const verdict = v.verdict && typeof v.verdict === "object" ? v.verdict : null;
    const pp = v.paypal && typeof v.paypal === "object" ? v.paypal : {};
    const results = Array.isArray(verdict?.results) ? verdict.results : [];
    return {
      id: text(v.id), title: text(v.title), status: text(v.status), statusLabel: STATUS[v.status] ?? text(v.status),
      price: text(v.price?.value), currency: text(v.price?.currency), feePct: num(v.feeBps) === null ? null : v.feeBps / 100,
      payout: text(v.payout?.value), score: verdict ? num(verdict.score) : null,
      result: verdict ? (verdict.pass ? "PASS" : "REJECT") : null, decision: text(v.decision),
      checks: results.map((r) => `${text(r?.kind) ?? "?"}: ${r?.pass ? "passed" : "failed"}`).join(", "),
      orderId: text(pp.orderId), captureId: text(pp.captureId), payoutBatchId: text(pp.payoutBatchId),
      payoutStatus: text(pp.payoutStatus), voided: pp.voided === true, underReview: pp.underReview === true,
      createdAt: text(v.createdAt), updatedAt: text(v.updatedAt), deadline: text(v.deadline),
      criteriaHash: text(v.criteriaHash), evidenceHash: verdict ? text(verdict.evidenceHash) : null,
    };
  });
}

const toCents = (s) => {
  const m = /^(\d+)\.(\d{2})$/.exec(s ?? "");
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
};
const fromCents = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

/** The headline numbers. Money counts as paid out only when the worker's payout has gone through. */
export function summarize(rows) {
  const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];
  const paid = rows.filter((r) => r.status === "paid");
  return {
    jobs: rows.length,
    paid: paid.length,
    refunded: rows.filter((r) => r.status === "refunded").length,
    open: rows.filter((r) => OPEN.has(r.status)).length,
    needsAttention: rows.filter((r) => r.status === "failed" || r.underReview).length,
    judged: rows.filter((r) => r.result !== null).length,
    passed: rows.filter((r) => r.result === "PASS").length,
    paidOut: fromCents(paid.reduce((sum, r) => sum + toCents(r.payout), 0)),
    currency: currencies.length === 1 ? currencies[0] : currencies.length ? "mixed" : null,
  };
}
