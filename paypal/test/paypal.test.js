// The PayPal client against the in-memory sandbox stand-in: the shapes it sends, the token handling, idempotent
// retries, and the live-environment guard.
import test from "node:test";
import assert from "node:assert/strict";
import { createPayPal, baseUrlFor, authorizationOf, approveLinkOf, PayPalError, SANDBOX, LIVE } from "../src/paypal.js";
import { toCents, fromCents, checkPrice, payoutCents } from "../src/money.js";
import { fakePayPal } from "./helpers/fake-paypal.js";

function setup(opts = {}) {
  const fake = fakePayPal(opts);
  const pp = createPayPal({ clientId: "client-id", clientSecret: "client-secret", fetchImpl: fake.fetch, ...(opts.client || {}) });
  return { fake, pp };
}
const AMOUNT = { currency_code: "USD", value: "5.00" };

test("money: amounts are exact cents, and odd strings are refused", () => {
  assert.equal(toCents("5"), 500);
  assert.equal(toCents("5.5"), 550);
  assert.equal(toCents("12.34"), 1234);
  for (const bad of ["-1", "1e3", " 5", "5.001", "05", "", "1,000", null]) assert.throws(() => toCents(bad), RangeError, String(bad));
  assert.equal(fromCents(1234), "12.34");
  assert.equal(fromCents(5), "0.05");
  assert.throws(() => fromCents(1.5), RangeError);
  assert.throws(() => checkPrice("0.99"), /between 1.00 and 500.00/);
  assert.throws(() => checkPrice("500.01"), /between/);
  assert.equal(checkPrice("500"), 50_000);
  assert.equal(payoutCents(500, 500), 475, "5% of $5.00");
  assert.equal(payoutCents(333, 500), 316, "rounded down: never more than captured");
  assert.throws(() => payoutCents(500, 10_001), RangeError);
});

test("the live API needs two switches; the default is the sandbox", () => {
  assert.equal(baseUrlFor({}), SANDBOX);
  assert.throws(() => baseUrlFor({ PAYPAL_ENV: "live" }), /JUDGE_PAY_ALLOW_LIVE/);
  assert.equal(baseUrlFor({ PAYPAL_ENV: "live", JUDGE_PAY_ALLOW_LIVE: "yes" }), LIVE);
  assert.throws(() => createPayPal({ clientId: "", clientSecret: "x" }), /required/);
});

test("an AUTHORIZE order holds the money; authorize works only after the buyer approves, and only once", async () => {
  const { fake, pp } = setup();
  const order = await pp.createOrder({ referenceId: "1001", customId: "0x" + "ab".repeat(32), invoiceId: "JP-1001", description: "Write a summary", amount: AMOUNT, requestId: "1001-order" });
  assert.equal(order.status, "CREATED");
  assert.match(approveLinkOf(order), /checkoutnow\?token=/);
  const sent = fake.calls.find((c) => c.path === "/v2/checkout/orders").body;
  assert.equal(sent.intent, "AUTHORIZE");
  assert.deepEqual(sent.purchase_units[0], { reference_id: "1001", custom_id: "0x" + "ab".repeat(32), invoice_id: "JP-1001", description: "Write a summary", amount: AMOUNT });
  assert.equal(sent.payment_source.paypal.experience_context.shipping_preference, "NO_SHIPPING");

  await assert.rejects(pp.authorizeOrder(order.id, { requestId: "1001-auth" }), (e) => e instanceof PayPalError && e.issue === "ORDER_NOT_APPROVED");
  fake.approve(order.id);
  const done = await pp.authorizeOrder(order.id, { requestId: "1001-auth-2" });
  const auth = authorizationOf(done);
  assert.equal(auth.status, "CREATED");
  assert.deepEqual(auth.amount, AMOUNT);
  assert.equal(auth.custom_id, "0x" + "ab".repeat(32), "the criteria hash rides on PayPal's own record");
  await assert.rejects(pp.authorizeOrder(order.id, { requestId: "1001-auth-3" }), (e) => e.issue === "ORDER_ALREADY_AUTHORIZED");
});

async function authorizedJob(fake, pp, id = "1002") {
  const order = await pp.createOrder({ referenceId: id, customId: "c", invoiceId: `JP-${id}`, description: "d", amount: AMOUNT });
  fake.approve(order.id);
  return authorizationOf(await pp.authorizeOrder(order.id, { requestId: `${id}-auth` }));
}

test("capture once; a retry with the same request id returns the same capture instead of a second one", async () => {
  const { fake, pp } = setup();
  const auth = await authorizedJob(fake, pp);
  const c1 = await pp.captureAuthorization(auth.id, { invoiceId: "JP-1002", noteToPayer: "Released: all checks passed", requestId: "1002-capture" });
  assert.equal(c1.status, "COMPLETED");
  assert.equal(c1.amount.value, "5.00");
  const c2 = await pp.captureAuthorization(auth.id, { invoiceId: "JP-1002", requestId: "1002-capture" });
  assert.equal(c2.id, c1.id, "idempotent replay");
  await assert.rejects(pp.captureAuthorization(auth.id, { requestId: "1002-capture-other" }), (e) => e.issue === "AUTHORIZATION_ALREADY_CAPTURED");
  assert.equal((await pp.getAuthorization(auth.id)).status, "CAPTURED");
  await assert.rejects(pp.voidAuthorization(auth.id, { requestId: "1002-void" }), (e) => e.status === 422);
});

test("void releases the hold; a voided authorization cannot be captured", async () => {
  const { fake, pp } = setup();
  const auth = await authorizedJob(fake, pp, "1003");
  assert.equal(await pp.voidAuthorization(auth.id, { requestId: "1003-void" }), null, "204 no content");
  assert.equal((await pp.getAuthorization(auth.id)).status, "VOIDED");
  await assert.rejects(pp.captureAuthorization(auth.id, { requestId: "1003-capture" }), (e) => e.issue === "AUTHORIZATION_VOIDED");
  assert.equal(await pp.voidAuthorization(auth.id, { requestId: "1003-void" }), null, "a replayed void answers the same");
});

test("a payout pays the worker from the merchant balance; a lost answer is recovered by the same request id", async () => {
  const { fake, pp } = setup();
  const before = fake.balance;
  fake.fault("POST /v1/payments/payouts", "after"); // PayPal pays, the answer never arrives
  const args = { senderBatchId: "JP-1004", emailSubject: "You were paid", emailMessage: "m", receiver: "worker@personal.example.com",
    amount: { currency: "USD", value: "4.75" }, note: "receipt", senderItemId: "1004", requestId: "1004-payout" };
  await assert.rejects(pp.createPayout(args), /timeout/i);
  const p = await pp.createPayout(args);
  assert.ok(p.batch_header.payout_batch_id);
  assert.equal(fake.balance, before - 475, "paid exactly once");
  const got = await pp.getPayout(p.batch_header.payout_batch_id);
  assert.equal(got.batch_header.batch_status, "SUCCESS");
  assert.equal(got.items[0].transaction_status, "SUCCESS");
  fake.balance = 100;
  await assert.rejects(pp.createPayout({ ...args, senderBatchId: "JP-1005", senderItemId: "1005", requestId: "1005-payout" }), (e) => e.paypalName === "INSUFFICIENT_FUNDS");
});

test("tokens are cached, refreshed when PayPal says 401, and bad credentials fail loudly", async () => {
  const { fake, pp } = setup();
  await pp.createOrder({ referenceId: "1", customId: "c", invoiceId: "JP-1", description: "d", amount: AMOUNT });
  await pp.createOrder({ referenceId: "2", customId: "c", invoiceId: "JP-2", description: "d", amount: AMOUNT });
  assert.equal(fake.calls.filter((c) => c.path === "/v1/oauth2/token").length, 1, "one token for two calls");
  fake.expireTokens();
  await pp.createOrder({ referenceId: "3", customId: "c", invoiceId: "JP-3", description: "d", amount: AMOUNT });
  assert.equal(fake.calls.filter((c) => c.path === "/v1/oauth2/token").length, 2, "refreshed once after a 401");
  const bad = createPayPal({ clientId: "client-id", clientSecret: "wrong", fetchImpl: fake.fetch });
  await assert.rejects(bad.getOrder("x"), (e) => e instanceof PayPalError && e.status === 401);
});
