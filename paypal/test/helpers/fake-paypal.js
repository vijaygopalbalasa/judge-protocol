// An in-memory stand-in for the PayPal sandbox REST API, shaped after PayPal's published OpenAPI specs
// (paypal/paypal-rest-api-specifications: checkout_orders_v2, payments_payment_v2, payments_payouts_batch_v1):
//   - OAuth client credentials with expiring tokens;
//   - orders with intent AUTHORIZE: CREATED until the buyer approves (approve(id) here), then authorize once;
//   - authorizations: capture (final or partial, never above the authorized amount) and void, each once;
//   - payouts from the merchant's balance, which captures fill (net of a sandbox-like fee);
//   - PayPal-Request-Id replays the first answer for the same endpoint;
//   - fault injection: fail the next matching call before or after PayPal acts (an "unknown outcome").
// It is a fetch implementation: pass fake.fetch as fetchImpl.

const FEE_BPS = 349, FEE_FIXED = 49; // sandbox-like: 3.49% + $0.49
const cents = (v) => Math.round(Number(v) * 100);
const dollars = (c) => (c / 100).toFixed(2);
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status, name, issue, message) => json(status, { name, message: message ?? name, debug_id: "fake-debug", details: issue ? [{ issue, description: issue }] : [] });

export function fakePayPal({ clientId = "client-id", clientSecret = "client-secret", balanceCents = 500_000, tokenTtl = 32_400, now = () => Date.now() } = {}) {
  let n = 0;
  const id = (p) => `${p}${String(++n).padStart(6, "0")}`;
  const tokens = new Map();       // token -> expiresAt
  const orders = new Map();
  const auths = new Map();
  const captures = new Map();
  const payouts = new Map();
  const idem = new Map();         // `${path}|${requestId}` -> { status, body }
  const batchIds = new Set();
  const faults = [];              // { match, when: "before"|"after", status }
  const calls = [];
  let balance = balanceCents;

  function fault(match, when, status = 500) { faults.push({ match, when, status }); }
  function takeFault(key, when) {
    const i = faults.findIndex((f) => f.when === when && key.includes(f.match));
    return i === -1 ? null : faults.splice(i, 1)[0];
  }

  function authorized(headers) {
    const h = headers.get("authorization") || "";
    if (!h.startsWith("Bearer ")) return false;
    const exp = tokens.get(h.slice(7));
    return exp !== undefined && now() < exp;
  }

  async function handle(method, path, headers, body) {
    if (path === "/v1/oauth2/token" && method === "POST") {
      const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
      if (headers.get("authorization") !== expected) return err(401, "invalid_client", null, "Client Authentication failed");
      const t = `A21AA-fake-${++n}`;
      tokens.set(t, now() + tokenTtl * 1000);
      return json(200, { access_token: t, token_type: "Bearer", expires_in: tokenTtl, scope: "https://uri.paypal.com/services/payments/payment" });
    }
    if (!authorized(headers)) return err(401, "AUTHENTICATION_FAILURE", null, "Authentication failed due to invalid authentication credentials or a missing Authorization header.");

    let m;
    if (path === "/v2/checkout/orders" && method === "POST") {
      const pu = body?.purchase_units?.[0];
      if (body?.intent !== "AUTHORIZE" && body?.intent !== "CAPTURE") return err(400, "INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER");
      if (!pu?.amount?.currency_code || !/^\d+(\.\d{1,2})?$/.test(String(pu.amount.value ?? ""))) return err(400, "INVALID_REQUEST", "INVALID_PARAMETER_VALUE");
      if (pu.invoice_id && [...orders.values()].some((o) => o.purchase_units[0].invoice_id === pu.invoice_id && o.status === "COMPLETED")) {
        return err(422, "UNPROCESSABLE_ENTITY", "DUPLICATE_INVOICE_ID");
      }
      const o = { id: id("ORD"), intent: body.intent, status: "CREATED", create_time: new Date(now()).toISOString(),
        purchase_units: [{ ...pu, payee: { merchant_id: "FAKEMERCHANT" } }],
        links: [{ rel: "self", href: "", method: "GET" }] };
      o.links.push({ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`, method: "GET" });
      orders.set(o.id, o);
      return json(201, o);
    }
    if ((m = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/)) && method === "GET") {
      const o = orders.get(m[1]);
      return o ? json(200, o) : err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    }
    if ((m = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/)) && method === "POST") {
      const o = orders.get(m[1]);
      if (!o) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (o.intent !== "AUTHORIZE") return err(422, "UNPROCESSABLE_ENTITY", "ACTION_DOES_NOT_MATCH_INTENT");
      if (o.status === "COMPLETED") return err(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_AUTHORIZED");
      if (o.status !== "APPROVED") return err(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED");
      const pu = o.purchase_units[0];
      const a = { id: id("AUTH"), status: "CREATED", amount: { ...pu.amount }, custom_id: pu.custom_id, invoice_id: pu.invoice_id,
        expiration_time: new Date(now() + 29 * 86400_000).toISOString(), create_time: new Date(now()).toISOString(),
        _orderId: o.id, _captured: 0, _payer: o.payer };
      auths.set(a.id, a);
      o.status = "COMPLETED";
      pu.payments = { authorizations: [publicAuth(a)] };
      return json(201, o);
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)$/)) && method === "GET") {
      const a = auths.get(m[1]);
      return a ? json(200, publicAuth(a)) : err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/)) && method === "POST") {
      const a = auths.get(m[1]);
      if (!a) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (a.status === "VOIDED") return err(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_VOIDED");
      if (a.status === "CAPTURED") return err(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED");
      if (now() > Date.parse(a.expiration_time)) return err(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_EXPIRED");
      const total = cents(a.amount.value);
      const want = body?.amount ? cents(body.amount.value) : total - a._captured;
      if (want <= 0 || a._captured + want > total) return err(422, "UNPROCESSABLE_ENTITY", "MAX_CAPTURE_AMOUNT_EXCEEDED");
      const fee = Math.round((want * FEE_BPS) / 10_000) + FEE_FIXED;
      const c = { id: id("CAP"), status: "COMPLETED", amount: { currency_code: a.amount.currency_code, value: dollars(want) },
        final_capture: body?.final_capture !== false, invoice_id: body?.invoice_id ?? a.invoice_id, custom_id: a.custom_id,
        note_to_payer: body?.note_to_payer,
        seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: dollars(want) }, paypal_fee: { currency_code: "USD", value: dollars(fee) },
          net_amount: { currency_code: "USD", value: dollars(want - fee) } },
        create_time: new Date(now()).toISOString() };
      captures.set(c.id, c);
      const order = orders.get(a._orderId);
      if (order) (order.purchase_units[0].payments.captures ??= []).push({ id: c.id, status: c.status, amount: c.amount, final_capture: c.final_capture, seller_receivable_breakdown: c.seller_receivable_breakdown });
      a._captured += want;
      balance += want - fee;
      a.status = c.final_capture || a._captured === total ? "CAPTURED" : "PARTIALLY_CAPTURED";
      return json(201, c);
    }
    if ((m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)\/void$/)) && method === "POST") {
      const a = auths.get(m[1]);
      if (!a) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
      if (a.status === "VOIDED") return err(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_VOIDED");
      if (a.status === "CAPTURED") return err(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_CAPTURED");
      a.status = "VOIDED";
      return headers.get("prefer") === "return=minimal" ? new Response(null, { status: 204 }) : json(200, publicAuth(a));
    }
    if (path === "/v1/payments/payouts" && method === "POST") {
      const h = body?.sender_batch_header, item = body?.items?.[0];
      if (!h?.sender_batch_id || !item?.receiver || !item?.amount?.value) return err(400, "VALIDATION_ERROR", "MISSING_REQUIRED_PARAMETER");
      if (batchIds.has(h.sender_batch_id)) return err(400, "USER_BUSINESS_ERROR", "SENDER_BATCH_ID_ALREADY_EXISTS");
      const amt = cents(item.amount.value);
      if (amt > balance) return err(422, "INSUFFICIENT_FUNDS", null, "Sender does not have sufficient funds.");
      batchIds.add(h.sender_batch_id);
      balance -= amt;
      const p = { batch_header: { payout_batch_id: id("BATCH"), batch_status: "PENDING", sender_batch_header: { ...h },
          amount: { currency: item.amount.currency, value: item.amount.value } },
        items: [{ payout_item_id: id("ITEM"), transaction_status: "PENDING", payout_item: { ...item },
          payout_item_fee: { currency: "USD", value: "0.25" } }], _reads: 0 };
      payouts.set(p.batch_header.payout_batch_id, p);
      return json(201, { batch_header: { ...p.batch_header }, links: [] });
    }
    if ((m = path.match(/^\/v1\/payments\/payouts\/([^/?]+)/)) && method === "GET") {
      const p = payouts.get(m[1]);
      if (!p) return err(404, "INVALID_RESOURCE_ID", null, "Requested resource ID was not found.");
      if (++p._reads >= 1 && p.batch_header.batch_status === "PENDING") {
        p.batch_header.batch_status = "SUCCESS";
        p.items[0].transaction_status = /unclaimed/.test(p.items[0].payout_item.receiver) ? "UNCLAIMED" : "SUCCESS";
      }
      return json(200, { batch_header: { ...p.batch_header }, items: p.items.map((i) => ({ ...i })) });
    }
    return err(404, "NOT_FOUND", null, `no fake route for ${method} ${path}`);
  }

  function publicAuth(a) {
    const { _orderId, _captured, _payer, ...rest } = a;
    return { ...rest };
  }

  async function fakeFetch(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});
    let body;
    if (init.body && headers.get("content-type")?.includes("json")) body = JSON.parse(init.body);
    else if (init.body && headers.get("content-type")?.includes("x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(init.body));
    const key = `${method} ${u.pathname}`;
    calls.push({ method, path: u.pathname, headers, body, requestId: headers.get("paypal-request-id") });
    const before = takeFault(key, "before");
    if (before) return before.status === "timeout" ? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")) : err(before.status, "INTERNAL_SERVER_ERROR");
    const rid = headers.get("paypal-request-id");
    const ikey = rid && `${key}|${rid}`;
    if (ikey && idem.has(ikey)) {
      const { status, text } = idem.get(ikey);
      return new Response(text, { status, headers: { "content-type": "application/json" } });
    }
    const res = await handle(method, u.pathname, headers, body);
    const text = res.status === 204 ? null : await res.text();
    if (ikey && res.status < 500) idem.set(ikey, { status: res.status, text });
    const after = takeFault(key, "after");
    if (after) return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")); // PayPal acted, the answer was lost
    return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
  }

  return {
    fetch: fakeFetch,
    calls,
    fault,
    /** The buyer approves the order in PayPal's checkout. */
    approve(orderId, payer = { payer_id: "BUYER1", email_address: "buyer@personal.example.com" }) {
      const o = orders.get(orderId);
      if (!o) throw new Error(`no order ${orderId}`);
      o.status = "APPROVED";
      o.payer = payer;
    },
    expireTokens() { for (const k of tokens.keys()) tokens.set(k, 0); },
    /** PayPal keeps PayPal-Request-Id replays for a limited time; after that a repeated request is judged afresh. */
    forgetReplays() { idem.clear(); },
    /** The batch id of the latest payout PayPal holds (what a person would find in the PayPal dashboard). */
    lastPayoutBatchId() { return [...payouts.keys()].at(-1) ?? null; },
    /** The order vanishes (PayPal drops unapproved orders after a while): later reads are 404. */
    dropOrder(i) { orders.delete(i); },
    voidOrder(i) { orders.get(i).status = "VOIDED"; },
    /** The authorization passes its expiry (PayPal allows 29 days). */
    expireAuthorization(i) { auths.get(i).expiration_time = new Date(now() - 1000).toISOString(); },
    voidAuthorizationNow(i) { auths.get(i).status = "VOIDED"; },
    order: (i) => orders.get(i),
    authorization: (i) => (auths.get(i) ? publicAuth(auths.get(i)) : null),
    capture: (i) => captures.get(i),
    payout: (i) => payouts.get(i),
    get balance() { return balance; },
    set balance(c) { balance = c; },
  };
}
