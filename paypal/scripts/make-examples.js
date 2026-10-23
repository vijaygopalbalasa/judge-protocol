// Example data for the receipt page and the dashboard: job records in every state, judged by the real engine and
// shown through the escrow's own publicView and receiptOf. No PayPal call is made; the PayPal ids are labeled examples.
// Run: node scripts/make-examples.js (test/examples.test.js fails when the committed files drift from this output).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dryRunEvaluate } from "../engine/evaluate.js";
import { criteriaHash } from "../engine/criteria.js";
import { publicView, receiptOf } from "../src/escrow.js";
import { fromCents, payoutCents, toCents } from "../src/money.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FILES = {
  receipt: join(here, "..", "public", "receipt", "example", "receipt.json"),
  delivery: join(here, "..", "public", "receipt", "example", "delivery.txt"),
  jobs: join(here, "..", "public", "dashboard", "sample-jobs.json"),
};

const BLURB = { version: 1, passThreshold: 100, checks: [
  { kind: "contains", params: { all: ["SteelSip", "750 ml"] }, weight: 2 },
  { kind: "length", params: { min: 12, max: 60, unit: "words" }, weight: 1 },
] };
const PRODUCT = { version: 1, passThreshold: 100, checks: [{ kind: "json", params: { shape: {
  type: "object", required: ["name", "price", "tags"],
  properties: { name: { type: "string", minLength: 1 }, price: { type: "number", minimum: 0 }, tags: { type: "array", minItems: 2, items: { type: "string" } } },
} } }] };
const FAQ = { version: 1, passThreshold: 100, checks: [
  { kind: "contains", params: { all: ["refund", "receipt"], wholeWords: true }, weight: 1 },
  { kind: "length", params: { max: 600, unit: "chars" }, weight: 1 },
] };

export const DELIVERY = "SteelSip keeps 750 ml of water ice cold for a full day, fits every cup holder we tried, and the lid "
  + "comes apart in two pieces for a quick rinse.";

const at = (h, m = 0) => new Date(Date.UTC(2026, 9, 21, h, m)).toISOString();
const plusDays = (iso, d) => new Date(Date.parse(iso) + d * 86_400_000).toISOString();

async function job({ n, title, task, criteria, price, status, created, delivery, paypal = {}, events }) {
  const cents = toCents(price);
  const id = `179200000000${String(1000 + n)}`;
  const j = {
    id, title, task, criteria, criteriaHash: criteriaHash(criteria),
    price: { currency: "USD", value: fromCents(cents), cents }, feeBps: 500,
    payout: { currency: "USD", value: fromCents(payoutCents(cents, 500)), cents: payoutCents(cents, 500) },
    worker: { email: `worker${n}@personal.example.com` },
    status, createdAt: created, updatedAt: events.at(-1).at, deadline: plusDays(created, 3),
    paypal, deliverable: null, verdict: null, decision: null, events,
  };
  if (delivery !== undefined) {
    const r = await dryRunEvaluate({ criteria, deliverable: delivery, jobId: id });
    if (r.status !== 200) throw new Error(`example ${n}: ${JSON.stringify(r.body)}`);
    const v = r.body;
    const judgedAt = events.find((e) => e.type === "judged").at;
    j.deliverable = { base64: Buffer.from(delivery).toString("base64"), bytes: Buffer.byteLength(delivery), keccak: v.deliverable,
      contentType: "text/plain", submittedAt: judgedAt };
    j.verdict = { results: v.results, score: v.score, threshold: v.threshold, pass: v.pass, evidenceHash: v.evidenceHash,
      criteriaHash: v.criteriaHash, judgedAt };
    j.decision = v.pass ? "release" : "refund";
  }
  return j;
}

const ev = (type, iso, detail) => ({ at: iso, type, ...(detail ? { detail } : {}) });
const ids = (n, more = {}) => ({ orderId: `EXAMPLE-ORDER-${n}`, authorizationId: `EXAMPLE-AUTH-${n}`, ...more });

export async function buildExamples() {
  const jobs = [
    await job({ n: 1, title: "Product blurb for the SteelSip bottle", task: "A 12 to 60 word blurb naming SteelSip and its 750 ml size.",
      criteria: BLURB, price: "5.00", status: "paid", created: at(6), delivery: DELIVERY,
      paypal: ids(1, { captureId: "EXAMPLE-CAPTURE-1", payoutBatchId: "EXAMPLE-BATCH-1", payoutStatus: "SUCCESS", payoutItemStatus: "SUCCESS" }),
      events: [ev("posted", at(6)), ev("funded", at(6, 5)), ev("judged", at(7)), ev("captured", at(7, 1)), ev("paid", at(7, 2))] }),
    await job({ n: 2, title: "Product blurb, second try", task: "Same brief as job 1.",
      criteria: BLURB, price: "5.00", status: "refunded", created: at(8), delivery: "A lovely bottle for every day of the week.",
      paypal: ids(2, { voided: true }),
      events: [ev("posted", at(8)), ev("funded", at(8, 4)), ev("judged", at(9)), ev("refunded", at(9, 1))] }),
    await job({ n: 3, title: "Catalog entry as JSON", task: "One product as JSON with name, price and at least two tags.",
      criteria: PRODUCT, price: "12.00", status: "captured", created: at(10),
      delivery: JSON.stringify({ name: "SteelSip 750", price: 24.5, tags: ["bottle", "steel"] }),
      paypal: ids(3, { captureId: "EXAMPLE-CAPTURE-3" }),
      events: [ev("posted", at(10)), ev("funded", at(10, 3)), ev("judged", at(11)), ev("captured", at(11, 1))] }),
    await job({ n: 4, title: "Refund policy FAQ answer", task: "Under 600 characters, mentioning refund and receipt.",
      criteria: FAQ, price: "8.00", status: "funded", created: at(12), paypal: ids(4),
      events: [ev("posted", at(12)), ev("funded", at(12, 6))] }),
    await job({ n: 5, title: "Second catalog entry", task: "Same shape as job 3.",
      criteria: PRODUCT, price: "12.00", status: "funding", created: at(13), paypal: { orderId: "EXAMPLE-ORDER-5" },
      events: [ev("posted", at(13)), ev("order", at(13, 2))] }),
    await job({ n: 6, title: "Three taglines", task: "Taglines for the SteelSip launch.",
      criteria: BLURB, price: "3.00", status: "posted", created: at(14), events: [ev("posted", at(14))] }),
    await job({ n: 7, title: "Product blurb, hold expired", task: "Same brief as job 1.",
      criteria: BLURB, price: "5.00", status: "failed", created: at(2), delivery: DELIVERY, paypal: ids(7),
      events: [ev("posted", at(2)), ev("funded", at(2, 5)), ev("judged", at(5)), ev("failed", at(5, 1))] }),
  ];
  return {
    receipt: receiptOf(jobs[0]),
    delivery: DELIVERY,
    jobs: jobs.map(publicView),
  };
}

export const serialize = (x) => JSON.stringify(x, null, 2) + "\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ex = await buildExamples();
  for (const f of Object.values(FILES)) mkdirSync(dirname(f), { recursive: true });
  writeFileSync(FILES.receipt, serialize(ex.receipt));
  writeFileSync(FILES.delivery, ex.delivery);
  writeFileSync(FILES.jobs, serialize(ex.jobs));
  console.log(`wrote ${Object.values(FILES).join(", ")}`);
}
