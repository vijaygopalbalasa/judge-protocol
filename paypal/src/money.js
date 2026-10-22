// Money in integer cents. PayPal takes and returns amounts as decimal strings ("5.00"); every sum here is done in
// cents so a fee or a payout can never pick up a floating-point remainder.

export const CURRENCY = "USD";
export const MIN_CENTS = 100;     // $1.00
export const MAX_CENTS = 50_000;  // $500.00: a sandbox demo cap, raised by configuration for real use
const AMOUNT = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/;

/** "5", "5.0" or "5.00" -> 500. Anything else (signs, exponents, spaces, three decimals) throws. */
export function toCents(value) {
  const s = String(value ?? "");
  if (!AMOUNT.test(s)) throw new RangeError(`not an amount: ${JSON.stringify(value)}`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** 500 -> "5.00" */
export function fromCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`not a cent amount: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** The price a job may carry: within the configured bounds. */
export function checkPrice(value, { min = MIN_CENTS, max = MAX_CENTS } = {}) {
  const cents = toCents(value);
  if (cents < min || cents > max) throw new RangeError(`price must be between ${fromCents(min)} and ${fromCents(max)} ${CURRENCY}`);
  return cents;
}

/** The worker's share after the platform fee in basis points, rounded down to the cent: the platform never pays out
 *  more than it captured. */
export function payoutCents(priceCents, feeBps) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new RangeError(`fee must be 0 to 10000 basis points: ${feeBps}`);
  return Math.floor((priceCents * (10_000 - feeBps)) / 10_000);
}
