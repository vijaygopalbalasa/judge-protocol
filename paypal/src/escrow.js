// Judge Pay's escrow on PayPal: a buyer's payment is authorized (held, not taken) when the job is funded; the worker
// delivers; Judge Protocol's deterministic checks decide; a pass captures the payment and pays the worker out, a fail
// voids the authorization so the buyer is never charged. No person and no AI model decides a payment: the checks were
// agreed before any money moved, they are pinned by their hash on PayPal's own order record (custom_id), and anyone
// holding the delivered bytes can recompute the verdict from the receipt.
//
// Status: posted -> funding -> funded -> judged -> captured -> paid      (every check passed)
//                                       judged -> refunded               (a check failed: the hold is voided)
//                            funded -> expired                           (no delivery by the deadline: voided)
// A step that moves money is recorded before PayPal is called and retried with the same PayPal-Request-Id, so a
// timeout or a crash between steps never pays twice and never loses a payment.
//
// Who may do what: a worker signs in with PayPal and gets a key for that account's confirmed email, stored only as a
// SHA-256 hash. Only the worker named on a job can deliver to it, so a buyer cannot deliver in the worker's place to
// force a refund, and nobody can hold a key for an address they do not control.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { keccak256 } from "viem";
import { dryRunEvaluate, MAX_DELIVERABLE_BYTES } from "../engine/evaluate.js";
import { validateCriteria } from "../engine/checkers/index.js";
import { criteriaHash } from "../engine/criteria.js";
import { CURRENCY, checkPrice, fromCents, payoutCents } from "./money.js";
import { PayPalError, authorizationOf, approveLinkOf } from "./paypal.js";

export const LIVE_CHECKS = new Set(["http-endpoint"]);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,63}\.[^\s@]{2,63}$/;
const ID = /^[0-9]{6,30}$/;
/** Payout refusals that prove PayPal created no batch, so a fresh sender_batch_id cannot pay twice. Any other refusal
 *  (SENDER_BATCH_ID_ALREADY_EXISTS among them) may mean a payout exists: it is stopped for a person to review. */
export const SAFE_PAYOUT_REFUSALS = new Set(["INSUFFICIENT_FUNDS", "VALIDATION_ERROR"]);

export class EscrowError extends Error {
  constructor(status, message) { super(message); this.name = "EscrowError"; this.status = status; }
}
const bad = (m) => new EscrowError(400, m);
const conflict = (m) => new EscrowError(409, m);

/** A refusal PayPal gave for good (a 4xx other than auth, conflict or rate limits): repeating the same request id would
 *  only replay it, so the next attempt needs a new one. A timeout or a 5xx is not: the next try reuses the id, and PayPal
 *  replays whatever really happened. */
const definitive = (e) => e instanceof PayPalError && e.status >= 400 && e.status < 500 && ![401, 408, 409, 429].includes(e.status);
const rid = (job, step) => { const n = job.paypal.attempts?.[step] ?? 0; return n ? `${job.id}-${step}-${n}` : `${job.id}-${step}`; };

export const hashSecret = (s) => createHash("sha256").update(String(s ?? "")).digest("hex");
function matches(secret, hash) {
  if (typeof secret !== "string" || !secret || typeof hash !== "string") return false;
  const a = Buffer.from(hashSecret(secret)), b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeEmail(email) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!e || e.length > 127 || !EMAIL.test(e)) throw bad("a PayPal email address is required");
  return e;
}

/** A 16-digit numeric id: milliseconds plus three random digits. Numeric because it is mixed into the evidenceHash
 *  exactly as Judge's on-chain job ids are. */
export function newJobId(now = Date.now()) {
  return `${now}${String(randomBytes(2).readUInt16BE(0) % 1000).padStart(3, "0")}`;
}

/** The checks a job may carry: valid Judge criteria with deterministic checks only, so every verdict is recomputable. */
export function checkCriteria(criteria) {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) throw bad("criteria must be a judge-criteria object");
  const v = validateCriteria(criteria);
  if (!v.valid) throw bad(`invalid criteria: ${v.reason}`);
  const live = criteria.checks.filter((c) => LIVE_CHECKS.has(c.kind)).map((c) => c.kind);
  if (live.length) throw bad(`Judge Pay takes deterministic checks only, which anyone can recompute later; remove: ${[...new Set(live)].join(", ")}`);
  return criteria;
}

export function createEscrow({ paypal, store, workers, now = () => Date.now(), publicUrl = "http://localhost:3000", feeBps = 500, deadlineHours = 72,
  idgen = newJobId, keygen = () => randomBytes(24).toString("base64url"), operatorKeyHash = null } = {}) {
  if (!paypal || !store || !workers) throw new Error("createEscrow needs paypal, store and workers");
  const iso = () => new Date(now()).toISOString();
  const receiptUrl = (id) => `${publicUrl}/job.html?id=${id}`;
  const event = (job, type, detail) => { job.events.push({ at: iso(), type, ...(detail ? { detail } : {}) }); job.updatedAt = iso(); return job; };

  async function load(id) {
    if (!ID.test(String(id ?? ""))) throw bad("no such job");
    const job = await store.get(String(id));
    if (!job) throw new EscrowError(404, "no such job");
    return job;
  }

  /** A worker signs in with PayPal and gets a key for the confirmed email on that PayPal account, shown exactly once;
   *  only its hash is kept. Signing in again as the same account issues a fresh key and retires the old one, so the
   *  owner of an address can always take it back and nobody can hold a key for an address they do not control. */
  async function registerWorker({ loginCode } = {}) {
    if (typeof loginCode !== "string" || !loginCode) throw bad("sign in with PayPal to get a worker key");
    let who;
    try { who = await paypal.loginWithPayPal(loginCode); } catch (e) { throw new EscrowError(403, `PayPal sign-in failed: ${e.message}`); }
    if (!who?.email || !who.emailConfirmed) throw new EscrowError(403, "the PayPal account has no confirmed email to be paid at");
    const e = normalizeEmail(who.email);
    const key = keygen();
    const existing = await workers.get(e);
    await workers.put({ id: e, email: e, payerId: who.payerId ?? null, keyHash: hashSecret(key), createdAt: existing?.createdAt ?? iso(),
      ...(existing ? { reissuedAt: iso() } : {}) });
    return { email: e, key };
  }

  /** A new key for a registered worker, in exchange for the current one. */
  async function rotateWorkerKey({ email, workerKey } = {}) {
    const e = normalizeEmail(email);
    const w = await workers.get(e);
    if (!w || !matches(workerKey, w.keyHash)) throw new EscrowError(403, "bad worker key");
    const key = keygen();
    await workers.update(e, (x) => ({ ...x, keyHash: hashSecret(key), rotatedAt: iso() }));
    return { email: e, key };
  }

  async function workerFor(job, workerKey) {
    const w = await workers.get(job.worker.email);
    if (!w || !matches(workerKey, w.keyHash)) throw new EscrowError(403, "only the worker named on this job can deliver (bad worker key)");
    return w;
  }

  /** Post a job: the task, the agreed checks, the price and the worker. Nothing is charged yet. */
  async function postJob({ title, task, criteria, price, workerEmail } = {}) {
    if (typeof title !== "string" || !title.trim() || title.length > 80) throw bad("title must be 1 to 80 characters");
    if (typeof task !== "string" || !task.trim() || task.length > 4000) throw bad("task must be 1 to 4000 characters");
    const c = checkCriteria(criteria);
    let cents;
    try { cents = checkPrice(price); } catch (e) { throw bad(e.message); }
    let email;
    try { email = normalizeEmail(workerEmail); } catch { throw bad("workerEmail must be the worker's PayPal email"); }
    const created = now();
    const id = idgen(created);
    const job = {
      id, title: title.trim(), task: task.trim(), criteria: c, criteriaHash: criteriaHash(c),
      price: { currency: CURRENCY, value: fromCents(cents), cents }, feeBps,
      payout: { currency: CURRENCY, value: fromCents(payoutCents(cents, feeBps)), cents: payoutCents(cents, feeBps) },
      worker: { email },
      status: "posted", createdAt: new Date(created).toISOString(), updatedAt: new Date(created).toISOString(),
      deadline: new Date(created + deadlineHours * 3600_000).toISOString(),
      paypal: {}, deliverable: null, verdict: null, decision: null, events: [],
    };
    event(job, "posted", `checks pinned: ${job.criteriaHash}`);
    await store.put(job);
    return job;
  }

  /** The PayPal order for this job (created once): intent AUTHORIZE, with the criteria hash in custom_id. */
  async function createOrder(id) {
    const job = await load(id);
    if (job.status !== "posted" && job.status !== "funding") throw conflict(`the job is ${job.status}; it can be funded only before it is funded`);
    let attempt = job.paypal.orderAttempt ?? 0;
    if (job.paypal.orderId) {
      let live = null;
      try { live = await paypal.getOrder(job.paypal.orderId); } catch (e) { if (!(e instanceof PayPalError) || e.status !== 404) throw e; }
      // Any order PayPal still knows and has not voided is this job's order (COMPLETED included: its authorization
      // exists and authorize() will find it). Only a voided or vanished order is replaced.
      if (live && live.status !== "VOIDED") return { orderId: job.paypal.orderId, approveUrl: job.paypal.approveUrl ?? null };
      attempt += 1;
    }
    const order = await paypal.createOrder({
      referenceId: job.id, customId: job.criteriaHash, invoiceId: `JP-${job.id}`,
      description: job.title.slice(0, 127), amount: { currency_code: job.price.currency, value: job.price.value },
      returnUrl: `${receiptUrl(job.id)}&approved=1`, cancelUrl: receiptUrl(job.id), requestId: `${job.id}-order-${attempt}`,
    });
    const updated = await store.update(job.id, (j) => {
      if (j.paypal.orderId && (j.paypal.orderAttempt ?? 0) >= attempt) return j;
      j.paypal.orderId = order.id;
      j.paypal.orderAttempt = attempt;
      j.paypal.approveUrl = approveLinkOf(order);
      j.status = "funding";
      return event(j, "order-created", order.id);
    });
    return { orderId: updated.paypal.orderId, approveUrl: updated.paypal.approveUrl ?? null };
  }

  /** The buyer approved the order in PayPal: authorize it, after checking it is this job's order on this job's terms. */
  async function authorize(id, orderId) {
    const job = await load(id);
    if (job.status === "funded" || job.paypal.authorizationId) return job;
    if (job.status !== "funding") throw conflict(`the job is ${job.status}`);
    if (orderId !== job.paypal.orderId) throw bad("that order does not belong to this job");
    const order = await paypal.getOrder(orderId);
    const pu = order?.purchase_units?.[0];
    if (pu?.reference_id !== job.id || pu?.custom_id !== job.criteriaHash || pu?.invoice_id !== `JP-${job.id}`
      || pu?.amount?.currency_code !== job.price.currency || pu?.amount?.value !== job.price.value || order.intent !== "AUTHORIZE") {
      throw bad("the PayPal order does not carry this job's terms");
    }
    let auth = authorizationOf(order);
    if (!auth && order.status !== "APPROVED") throw conflict("the buyer has not approved the payment in PayPal yet");
    if (!auth) {
      try { auth = authorizationOf(await paypal.authorizeOrder(orderId, { requestId: `${job.id}-authorize` })); } catch (e) {
        if (!(e instanceof PayPalError) || e.issue !== "ORDER_ALREADY_AUTHORIZED") throw e;
        auth = authorizationOf(await paypal.getOrder(orderId)); // an earlier answer was lost
      }
    }
    if (!auth || auth.status !== "CREATED") throw new EscrowError(402, `PayPal did not hold the payment (${auth?.status ?? "no authorization"})`);
    return store.update(job.id, (j) => {
      if (j.paypal.authorizationId) return j;
      j.paypal.authorizationId = auth.id;
      j.paypal.authorizationExpires = auth.expiration_time ?? null;
      j.buyer = { payerId: order.payer?.payer_id ?? null, email: order.payer?.email_address ?? null };
      j.status = "funded";
      return event(j, "funded", `${job.price.value} ${job.price.currency} held by PayPal (authorization ${auth.id})`);
    });
  }

  /** The worker's delivery. Judged at once; the money then moves by the verdict alone. */
  async function deliver(id, { workerKey, content, base64, contentType = "text/plain" } = {}) {
    let job = await load(id);
    await workerFor(job, workerKey);
    job = await sweep(id);
    if (job.status !== "funded") throw conflict(`the job is ${job.status}; a delivery is taken only while it is funded`);
    const hasText = typeof content === "string", hasB64 = typeof base64 === "string";
    if (hasText === hasB64) throw bad("send exactly one of content (text) or base64 (bytes)");
    const bytes = hasText ? Buffer.from(content, "utf8") : Buffer.from(base64, "base64");
    if (bytes.length === 0) throw bad("the delivery is empty");
    if (bytes.length > MAX_DELIVERABLE_BYTES) throw bad(`the delivery exceeds ${MAX_DELIVERABLE_BYTES} bytes`);
    const r = await dryRunEvaluate({ criteria: job.criteria, deliverableBase64: bytes.toString("base64"), jobId: job.id });
    if (r.status !== 200 || r.body.score === null) throw new EscrowError(500, `the checks could not run: ${r.body.error ?? r.body.reason ?? "no score"}`);
    const v = r.body;
    job = await store.update(job.id, (j) => {
      if (j.status !== "funded") throw conflict(`the job is ${j.status}`);
      j.deliverable = { base64: bytes.toString("base64"), bytes: bytes.length, keccak: v.deliverable, contentType: String(contentType).slice(0, 100), submittedAt: iso() };
      j.verdict = { results: v.results, score: v.score, threshold: v.threshold, pass: v.pass, evidenceHash: v.evidenceHash, criteriaHash: v.criteriaHash, judgedAt: iso() };
      j.decision = v.pass ? "release" : "refund";
      j.status = "judged";
      return event(j, "judged", `score ${v.score} of ${v.threshold} needed: ${v.pass ? "every agreed check passed, releasing" : "a check failed, refunding"}`);
    });
    return settle(job.id);
  }

  /** Move the money the verdict decided. Safe to call again at any time: every PayPal call repeats its request id. */
  async function settle(id) {
    let job = await load(id);
    if (job.status === "judged" && job.decision === "refund") {
      try {
        await paypal.voidAuthorization(job.paypal.authorizationId, { requestId: rid(job, "void") });
      } catch (e) {
        const s = await authorizationStatus(job);
        if (s !== "VOIDED") {
          if (definitive(e)) await bump(job, "void");
          return note(job, "settle-retry", `void did not complete: ${e.message}`);
        }
      }
      return store.update(job.id, (j) => { j.status = "refunded"; j.paypal.voided = true; return event(j, "refunded", "the hold was voided: the buyer is not charged"); });
    }
    if (job.status === "judged" && job.decision === "release") {
      let cap;
      try {
        cap = await paypal.captureAuthorization(job.paypal.authorizationId, {
          invoiceId: `JP-${job.id}`, requestId: rid(job, "capture"), finalCapture: true,
          noteToPayer: `Released by Judge Pay: every agreed check passed. Receipt: ${receiptUrl(job.id)}`.slice(0, 255),
        });
      } catch (e) {
        const s = await authorizationStatus(job);
        if (s === "VOIDED" || s === "EXPIRED" || s === "DENIED") {
          return store.update(job.id, (j) => {
            j.status = "failed";
            return event(j, "failed", `the checks passed but PayPal's hold is ${s}, so nothing could be captured: the buyer is not charged and the worker must be paid another way`);
          });
        }
        // Captured already (an earlier answer was lost and its replay window passed): PayPal's order lists the capture.
        if (s === "CAPTURED") cap = (await paypal.getOrder(job.paypal.orderId).catch(() => null))?.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
        if (!cap) {
          if (definitive(e) && s !== "CAPTURED") await bump(job, "capture");
          return note(job, "settle-retry", `capture did not complete: ${e.message}`);
        }
      }
      job = await store.update(job.id, (j) => {
        j.paypal.captureId = cap.id;
        j.paypal.captureNet = cap.seller_receivable_breakdown?.net_amount?.value ?? null;
        j.paypal.paypalFee = cap.seller_receivable_breakdown?.paypal_fee?.value ?? null;
        j.status = "captured";
        return event(j, "captured", `${cap.amount?.value} ${cap.amount?.currency_code} captured (capture ${cap.id})`);
      });
    }
    if (job.status === "captured" && !job.paypal.payoutBatchId && !job.paypal.payoutReview) {
      const n = job.paypal.attempts?.payout ?? 0;
      const senderBatchId = n ? `JP-${job.id}-${n}` : `JP-${job.id}`;
      // The attempt is on record before PayPal is asked, so a crash here is reconciled against this batch id, never
      // paid again under another.
      job = await store.update(job.id, (j) => { j.paypal.payoutAttempt = { senderBatchId, at: iso() }; return j; });
      let p;
      try {
        p = await paypal.createPayout({
          senderBatchId, senderItemId: job.id, requestId: rid(job, "payout"), receiver: job.worker.email,
          amount: { currency: job.payout.currency, value: job.payout.value },
          emailSubject: "You were paid for verified work",
          emailMessage: `Judge Pay checked your delivery for "${job.title}" against the agreed checks and every one passed.`,
          note: `Receipt: ${receiptUrl(job.id)}`,
        });
      } catch (e) {
        if (definitive(e) && SAFE_PAYOUT_REFUSALS.has(e.paypalName)) {
          await bump(job, "payout"); // PayPal created nothing: the next try may use a fresh batch id
          return note(job, "payout-retry", `payout refused, will retry: ${e.message}`);
        }
        if (definitive(e)) {
          // PayPal may already hold a batch under this id (the answer to an earlier try was lost and its replay
          // window passed). Paying again under a new id could pay twice, so this stops for a person to reconcile.
          return store.update(job.id, (j) => {
            j.paypal.payoutReview = `${senderBatchId}: ${e.message}`;
            return event(j, "payout-review", `payout stopped for review, batch ${senderBatchId}: ${e.message}`);
          });
        }
        return note(job, "payout-retry", `payout did not complete: ${e.message}`); // timeout or 5xx: same request id next time
      }
      job = await store.update(job.id, (j) => {
        j.paypal.payoutBatchId = p.batch_header?.payout_batch_id;
        j.paypal.payoutStatus = p.batch_header?.batch_status ?? "PENDING";
        return event(j, "payout-sent", `${job.payout.value} ${job.payout.currency} to the worker (batch ${j.paypal.payoutBatchId})`);
      });
    }
    if (job.status === "captured" && job.paypal.payoutBatchId) return refreshPayout(job.id);
    return job;
  }

  /** An operator reconciled a payout stopped for review, after looking in PayPal: either PayPal's batch id for this
   *  job's payout (checked against PayPal: the batch id this job sent, its amount and its receiver), or an explicit
   *  confirmedNoBatch: true, after which a fresh batch id is used. Needs the operator key; with none configured, a
   *  review cannot be resolved at all. */
  async function resolvePayoutReview(id, { operatorKey, payoutBatchId = null, confirmedNoBatch = false } = {}) {
    if (!operatorKeyHash || !matches(operatorKey, operatorKeyHash)) throw new EscrowError(403, "resolving a payout review needs the operator key");
    const job = await load(id);
    if (!job.paypal.payoutReview) throw conflict("this job's payout is not under review");
    if (Boolean(payoutBatchId) === (confirmedNoBatch === true)) throw bad("give either the payoutBatchId found at PayPal or confirmedNoBatch: true");
    if (payoutBatchId) {
      let p;
      try { p = await paypal.getPayout(String(payoutBatchId)); } catch (e) { throw bad(`PayPal has no payout ${payoutBatchId}: ${e.message}`); }
      const item = p?.items?.[0]?.payout_item;
      if (p?.batch_header?.sender_batch_header?.sender_batch_id !== job.paypal.payoutAttempt?.senderBatchId
        || item?.amount?.value !== job.payout.value || item?.amount?.currency !== job.payout.currency || item?.receiver !== job.worker.email) {
        throw bad(`batch ${payoutBatchId} is not this job's payout (batch id, amount or receiver differ)`);
      }
    }
    const next = await store.update(job.id, (j) => {
      delete j.paypal.payoutReview;
      if (payoutBatchId) { j.paypal.payoutBatchId = String(payoutBatchId); j.paypal.payoutStatus = "PENDING"; event(j, "payout-reconciled", `batch ${payoutBatchId} confirmed at PayPal by the operator`); }
      else { j.paypal.attempts = { ...(j.paypal.attempts || {}), payout: (j.paypal.attempts?.payout ?? 0) + 1 }; event(j, "payout-reconciled", "the operator confirmed no batch exists at PayPal: a fresh batch id will be used"); }
      return j;
    });
    return next.status === "captured" ? settle(next.id) : next;
  }

  /** Read the payout's state from PayPal; the job is paid once PayPal reports the item paid. */
  async function refreshPayout(id) {
    const job = await load(id);
    if (!job.paypal.payoutBatchId || job.status === "paid") return job;
    let p;
    try { p = await paypal.getPayout(job.paypal.payoutBatchId); } catch (e) { return note(job, "payout-check", `could not read the payout: ${e.message}`); }
    const item = p?.items?.[0];
    return store.update(job.id, (j) => {
      j.paypal.payoutStatus = p?.batch_header?.batch_status ?? j.paypal.payoutStatus;
      j.paypal.payoutItemStatus = item?.transaction_status ?? null;
      if (item?.transaction_status === "SUCCESS" && j.status === "captured") {
        j.status = "paid";
        event(j, "paid", `PayPal paid ${job.payout.value} ${job.payout.currency} to the worker`);
      }
      return j;
    });
  }

  /** Housekeeping on every read: void a funded job past its deadline, and finish any settlement left half done. */
  async function sweep(id) {
    let job = await load(id);
    if (job.status === "funded" && now() > Date.parse(job.deadline)) {
      try {
        await paypal.voidAuthorization(job.paypal.authorizationId, { requestId: rid(job, "expire") });
      } catch (e) {
        const s = await authorizationStatus(job);
        if (s !== "VOIDED") {
          if (definitive(e)) await bump(job, "expire");
          return note(job, "expire-retry", `void did not complete: ${e.message}`);
        }
      }
      job = await store.update(job.id, (j) => {
        if (j.status !== "funded") return j;
        j.status = "expired"; j.paypal.voided = true;
        return event(j, "expired", "no delivery by the deadline: the hold was voided, the buyer is not charged");
      });
    }
    if (job.status === "judged" || job.status === "captured") job = await settle(job.id);
    return job;
  }

  /** PayPal's own status for the job's authorization, or null when it cannot be read right now. */
  async function authorizationStatus(job) {
    try { return (await paypal.getAuthorization(job.paypal.authorizationId))?.status ?? null; } catch { return null; }
  }

  /** The next attempt at a step gets a new request id (see definitive above). */
  async function bump(job, step) {
    return store.update(job.id, (j) => { j.paypal.attempts = { ...(j.paypal.attempts || {}), [step]: (j.paypal.attempts?.[step] ?? 0) + 1 }; return j; });
  }

  async function note(job, type, detail) {
    return store.update(job.id, (j) => event(j, type, detail));
  }

  async function list() {
    return (await store.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return { registerWorker, rotateWorkerKey, postJob, createOrder, authorize, deliver, settle, sweep, refreshPayout, resolvePayoutReview, get: load, list, receiptUrl };
}

/** What anyone may see: the terms, the state, the verdict, the hashes and PayPal's record ids. Never the delivered
 *  bytes, the worker's or the buyer's details. An allowlist, so a new field is private until it is listed here. */
export function publicView(job) {
  if (!job) return null;
  const pp = job.paypal || {};
  return {
    id: job.id, title: job.title, task: job.task, criteria: job.criteria, criteriaHash: job.criteriaHash,
    price: job.price, feeBps: job.feeBps, payout: job.payout, status: job.status, decision: job.decision,
    createdAt: job.createdAt, updatedAt: job.updatedAt, deadline: job.deadline,
    deliverable: job.deliverable ? { keccak: job.deliverable.keccak, bytes: job.deliverable.bytes, contentType: job.deliverable.contentType, submittedAt: job.deliverable.submittedAt } : null,
    verdict: job.verdict,
    paypal: { orderId: pp.orderId ?? null, authorizationId: pp.authorizationId ?? null, captureId: pp.captureId ?? null, voided: !!pp.voided,
      payoutBatchId: pp.payoutBatchId ?? null, payoutStatus: pp.payoutStatus ?? null, payoutItemStatus: pp.payoutItemStatus ?? null, underReview: !!pp.payoutReview },
    events: job.events,
  };
}

/** The receipt: the terms, the delivery, the checks, the decision and PayPal's records, with a hash over all of it. */
export function receiptOf(job) {
  if (!job?.verdict) return null;
  const r = {
    kind: "judge-pay/receipt@1",
    jobId: job.id, title: job.title, task: job.task,
    criteria: job.criteria, criteriaHash: job.criteriaHash,
    price: job.price.value, currency: job.price.currency, feeBps: job.feeBps, payout: job.payout.value,
    deliverable: { keccak: job.deliverable.keccak, bytes: job.deliverable.bytes, submittedAt: job.deliverable.submittedAt },
    results: job.verdict.results.map((x) => ({ kind: x.kind, weight: x.weight ?? 1, pass: x.pass, detail: x.detail })),
    score: job.verdict.score, threshold: job.verdict.threshold, pass: job.verdict.pass, evidenceHash: job.verdict.evidenceHash,
    decision: job.decision,
    paypal: { orderId: job.paypal.orderId ?? null, authorizationId: job.paypal.authorizationId ?? null, captureId: job.paypal.captureId ?? null,
      voided: !!job.paypal.voided, payoutBatchId: job.paypal.payoutBatchId ?? null },
  };
  r.receiptHash = keccak256(Buffer.from(JSON.stringify(sortKeys(r))));
  return r;
}

function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") return Object.keys(x).sort().reduce((a, k) => { a[k] = sortKeys(x[k]); return a; }, Object.create(null));
  return x;
}
