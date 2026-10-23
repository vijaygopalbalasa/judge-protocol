# Judge Pay

Pay for work through PayPal only when the delivery passes checks agreed before any money moved.

The buyer's payment is held by PayPal (an order with intent AUTHORIZE), the worker delivers, and Judge Protocol's
deterministic engine runs the agreed checks. Every check passing captures the payment and pays the worker through
PayPal Payouts; any check failing voids the hold, so the buyer is never charged. Claude drafts the checks from a
plain-language request and can do the work as an AI worker, but it never decides a payment: only the checks do.

**Status: in progress for the PayPal AI Hackathon.** Sandbox only by default. What is built and tested is listed
below; the web API, the job pages and a hosted demo are not built yet.

## Built and tested

- `src/paypal.js`: a small PayPal REST client: Orders v2 with intent AUTHORIZE, authorize, capture or void, Payouts,
  and Log in with PayPal. Every call that moves money carries a PayPal-Request-Id, so a retry after a timeout returns
  the first answer instead of acting twice. The live API needs two switches (`PAYPAL_ENV=live` and
  `JUDGE_PAY_ALLOW_LIVE=yes`).
- `src/escrow.js`: the job state machine (posted, funding, funded, judged, captured, paid, refunded, expired, failed),
  worker keys issued only after Log in with PayPal confirms the worker's email, a public view that lists only fields
  safe to show, and receipts with a hash over the terms, the delivery, the checks, the decision and PayPal's ids.
- `src/ai.js`: Claude drafts the checks for the buyer to approve before paying, and an AI worker runs its own draft
  through the same checks, revising until they pass, before it delivers.
- `engine/` and `public/verify/`: Judge Protocol's engine and browser verifier, copied byte for byte
  (`npm run sync-engine`); a test fails if a copy drifts.
- `public/receipt/`: a receipt checker that runs in the browser. Load a receipt and the delivered file; it recomputes
  the receipt's hash, the hash of the agreed checks, the file's hash, every check, the evidence hash, the decision and
  the payout, and compares PayPal's ids with the decision. Receipts are not signed and the page cannot see PayPal, so
  it shows that the numbers agree; the buyer confirms the payment in their own PayPal account.
- `public/dashboard/`: the jobs dashboard in AG Grid (Community 36.2.0, loaded from jsDelivr with a pinned integrity
  hash): headline totals, sortable and filterable jobs, and a detail panel. It shows example data by default
  (`sample-jobs.json`) or a list of public job views from `?src=`.

## Try it

```bash
npm install
npm test                          # 69 tests: PayPal client, escrow, AI, engine sync, receipt checker, dashboard
node scripts/make-examples.js     # regenerate the example receipt and sample jobs (a test checks they match)
python3 -m http.server 8765 --bind 127.0.0.1 --directory public
# then open http://127.0.0.1:8765/receipt/ (press "Load the example") and http://127.0.0.1:8765/dashboard/
```

The tests never reach PayPal or Claude: PayPal is a local stand-in built from PayPal's published API specs, and the AI
tests use a stand-in client. The example data comes from the real engine, with PayPal ids marked `EXAMPLE`.

## Limits

- Sandbox by default; nothing here has run against PayPal's real sandbox yet.
- Only checks a program can repeat (length, required terms, JSON shape and fields). Tone, accuracy and taste are not
  checked, and the AI says so when it drafts the checks.
- One currency (USD) and prices from 1.00 to 500.00 in the demo configuration.

MIT licensed, as the rest of the repository.
