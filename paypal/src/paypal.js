// A small PayPal REST client for the calls Judge Pay makes: an order with intent AUTHORIZE (the buyer's money is held,
// not taken), capture or void of that authorization, and a payout to the worker. Every call that moves money takes a
// PayPal-Request-Id, so a retry after a timeout returns the first answer instead of acting twice.
//
// Sandbox by default. The live API is used only when PAYPAL_ENV=live AND JUDGE_PAY_ALLOW_LIVE=yes are both set, so a
// copied configuration can never move real money by accident.

export const SANDBOX = "https://api-m.sandbox.paypal.com";
export const LIVE = "https://api-m.paypal.com";

export class PayPalError extends Error {
  constructor(status, body, where) {
    const issue = body?.details?.[0]?.issue;
    super(`PayPal ${where}: ${status} ${body?.name ?? "error"}${issue ? ` (${issue})` : ""}${body?.message ? `: ${body.message}` : ""}`);
    this.name = "PayPalError";
    this.status = status;
    this.paypalName = body?.name ?? null;
    this.issue = issue ?? null;
    this.debugId = body?.debug_id ?? null;
    this.details = body?.details ?? [];
  }
}

/** The API base for an environment, refusing live unless it was asked for twice. */
export function baseUrlFor(env = process.env) {
  if (env.PAYPAL_ENV === "live") {
    if (env.JUDGE_PAY_ALLOW_LIVE !== "yes") throw new Error("PAYPAL_ENV=live needs JUDGE_PAY_ALLOW_LIVE=yes as well");
    return LIVE;
  }
  return SANDBOX;
}

export function createPayPal({ clientId, clientSecret, baseUrl = SANDBOX, fetchImpl = fetch, timeoutMs = 15_000, now = () => Date.now() } = {}) {
  if (!clientId || !clientSecret) throw new Error("PayPal client id and secret are required");
  let token = null; // { value, expiresAt }

  async function accessToken(force = false) {
    if (!force && token && now() < token.expiresAt) return token.value;
    const res = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || typeof body?.access_token !== "string") throw new PayPalError(res.status, body, "oauth2/token");
    const ttl = Number(body.expires_in) || 300;
    token = { value: body.access_token, expiresAt: now() + Math.max(30, ttl - 60) * 1000 };
    return token.value;
  }

  async function call(method, path, body, { requestId, prefer = "return=representation" } = {}, retried = false) {
    const headers = { authorization: `Bearer ${await accessToken(retried)}`, "content-type": "application/json", prefer };
    if (requestId) headers["paypal-request-id"] = requestId;
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 && !retried) return call(method, path, body, { requestId, prefer }, true); // token revoked or expired early
    if (res.status === 204) return null;
    const parsed = await res.json().catch(() => null);
    if (!res.ok) throw new PayPalError(res.status, parsed, `${method} ${path.split("?")[0]}`);
    return parsed;
  }

  return {
    baseUrl,

    /** An order whose payment is only authorized when the buyer approves it: the money is held, not taken. */
    createOrder({ referenceId, customId, invoiceId, description, amount, brandName = "Judge Pay", returnUrl, cancelUrl, requestId }) {
      const experience = { brand_name: brandName, shipping_preference: "NO_SHIPPING", user_action: "CONTINUE" };
      if (returnUrl) experience.return_url = returnUrl;
      if (cancelUrl) experience.cancel_url = cancelUrl;
      return call("POST", "/v2/checkout/orders", {
        intent: "AUTHORIZE",
        purchase_units: [{ reference_id: referenceId, custom_id: customId, invoice_id: invoiceId, description, amount }],
        payment_source: { paypal: { experience_context: experience } },
      }, { requestId });
    },
    getOrder: (id) => call("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`),
    authorizeOrder: (id, { requestId } = {}) => call("POST", `/v2/checkout/orders/${encodeURIComponent(id)}/authorize`, {}, { requestId }),
    getAuthorization: (id) => call("GET", `/v2/payments/authorizations/${encodeURIComponent(id)}`),
    captureAuthorization: (id, { invoiceId, noteToPayer, amount, finalCapture = true, requestId } = {}) => {
      const body = { final_capture: finalCapture };
      if (invoiceId) body.invoice_id = invoiceId;
      if (noteToPayer) body.note_to_payer = noteToPayer;
      if (amount) body.amount = amount;
      return call("POST", `/v2/payments/authorizations/${encodeURIComponent(id)}/capture`, body, { requestId });
    },
    voidAuthorization: (id, { requestId } = {}) => call("POST", `/v2/payments/authorizations/${encodeURIComponent(id)}/void`, undefined, { requestId, prefer: "return=minimal" }),
    createPayout({ senderBatchId, emailSubject, emailMessage, receiver, amount, note, senderItemId, requestId }) {
      return call("POST", "/v1/payments/payouts", {
        sender_batch_header: { sender_batch_id: senderBatchId, recipient_type: "EMAIL", email_subject: emailSubject, email_message: emailMessage },
        items: [{ recipient_type: "EMAIL", amount, note, sender_item_id: senderItemId, receiver }],
      }, { requestId });
    },
    getPayout: (batchId) => call("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`),

    /** Log in with PayPal: exchange the one-time code PayPal sent back to the site (with this app's credentials),
     *  then read who signed in with the user's own token. The email is the account's primary email, and whether
     *  PayPal has confirmed it. */
    async loginWithPayPal(code) {
      const res = await fetchImpl(`${baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: String(code ?? "") }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const tok = await res.json().catch(() => null);
      if (!res.ok || typeof tok?.access_token !== "string") throw new PayPalError(res.status, { name: tok?.error, message: tok?.error_description }, "oauth2/token (login)");
      const r2 = await fetchImpl(`${baseUrl}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, {
        headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(timeoutMs),
      });
      const info = await r2.json().catch(() => null);
      if (!r2.ok || !info) throw new PayPalError(r2.status, { name: info?.error, message: info?.error_description }, "identity/userinfo");
      const emails = Array.isArray(info.emails) ? info.emails : [];
      const primary = emails.find((e) => e?.primary === true || e?.primary === "true") ?? emails[0] ?? null;
      const yes = (v) => v === true || v === "true";
      return { email: primary?.value ?? null, emailConfirmed: yes(primary?.confirmed), payerId: info.payer_id ?? null, verifiedAccount: yes(info.verified_account) };
    },
  };
}

/** The authorization PayPal created when the order was authorized. */
export function authorizationOf(order) {
  return order?.purchase_units?.[0]?.payments?.authorizations?.[0] ?? null;
}

/** The buyer's approval link on a created order. */
export function approveLinkOf(order) {
  return (order?.links || []).find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
}
