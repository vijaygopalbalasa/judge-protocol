# Judge Pay

**Pay for verified work, not promises.**

Judge Pay is an acceptance and payment layer for work bought from AI agents or people. AI turns a plain-language task into objective acceptance checks and can perform the work. PayPal holds the buyer's payment before delivery. Only the agreed deterministic checks decide whether to capture and pay the worker or void the hold.

The demo job reconciles three refund receipts into JSON. The report must contain the exact total, every receipt ID, the agreed fields, and no unexpected fields. This is useful machine-verifiable work, not a chatbot with a checkout button.

## Try it live

**Hosted sandbox demo: https://judgepay.vercel.app** (PayPal sandbox only, so no real money moves.)

1. On the home page, describe a task or keep the prefilled reconciliation task, then click **Draft checks with AI**. Review the checks and create the job.
2. Copy the private worker link the job page shows. It is shown once.
3. Click the PayPal button and log in with the sandbox buyer below. This places an authorization hold; nothing is captured yet.
4. Open the worker link and click **Let the AI worker deliver and settle**, or paste an answer yourself. Passing work is captured and paid out to the worker; failing work voids the hold.
5. Open **Jobs** for the AG Grid dashboard and **Verify a receipt** to recompute a result from the delivered file.

Sandbox test accounts for judges (fake money, PayPal sandbox only):

- Buyer login for the PayPal button: SANDBOX_BUYER_EMAIL_TBD / SANDBOX_BUYER_PASSWORD_TBD
- Worker PayPal email (prefilled in the job form on the hosted demo): `sb-ia9ru53714828@personal.example.com`

AI drafting is capped per visitor each hour and per day to protect the demo's model budget. If the cap is reached, write the checks as JSON or deliver by hand; the payment flow is unchanged.

## Why this is different

Most agent-payment demos focus on how an agent sends money. Judge Pay focuses on when a buyer should release it.

- **PayPal is central:** Orders v2 authorization holds, capture, void, Payouts, and PayPal Buttons.
- **AI is meaningful:** AI drafts the acceptance checks and works through a draft, check, revise loop. It never decides a payment.
- **The terms cannot drift:** the criteria hash is pinned to the PayPal order and checked again before the hold is accepted.
- **Both outcomes work:** passing work is captured and paid; failing work or a missed deadline voids the hold.
- **Evidence is portable:** anyone with the original delivered file can recompute the checks, evidence hash, decision, payout, and receipt hash in their browser.
- **Operations are visible:** an AG Grid dashboard shows live job state, scores, payment IDs, and exceptions.

## Working product

1. The buyer describes a task. AI drafts one to six objective checks and names anything a program cannot verify.
2. The buyer reviews or edits the checks, chooses a worker's PayPal email and price, and creates the job.
3. The app displays a private worker link. Its job-specific delivery key is returned once; the server stores only its hash.
4. PayPal Buttons authorize a hold. No capture happens at this step.
5. The worker opens the private link and delivers directly or asks AI to draft and revise against the checks. A failing AI draft is not submitted.
6. Judge Protocol's engine runs the checks on the delivered bytes. A pass captures the authorization and creates a payout. A fail voids it.
7. The job page exposes the evidence trail and receipt. Only the private delivery key can retrieve the original bytes.

The private link authorizes work on one job; it is not PayPal identity and gives no access to anyone's PayPal account. PayPal sends the payout to the worker email named by the buyer.

## Five-minute local preview

This mode needs no account and contacts neither PayPal nor an AI provider. It uses a payment simulator and a canned assistant so the complete interface and settlement logic can be tested offline. The yellow banner makes this distinction visible at all times.

Requirements: Node.js 22 or newer.

```bash
cd paypal
npm ci
npm run demo
```

Open http://127.0.0.1:3000.

1. Click **Draft checks in local preview**, review the criteria, and create the prefilled reconciliation job.
2. Save the private worker link shown on the job page.
3. Click **Approve the simulated hold**.
4. Open the private worker link and run the canned preview worker.
5. Open the paid job, download its receipt, and inspect the money and evidence trail.
6. Create a second job, but deliver incorrect text manually. It ends as **Hold voided**, with no capture or payout.
7. Open **Jobs** for the live AG Grid dashboard and **Verify a receipt** to recompute a result with the original delivery.

The preview uses in-memory data and resets when the process stops. Simulated IDs such as `ORD000002` are not PayPal sandbox records.

## Run against PayPal's real sandbox

### 1. Create the sandbox resources

In the PayPal Developer Dashboard:

1. Create a sandbox application with **Payouts** enabled. Payouts may require access approval on the PayPal account. Log in with PayPal is not used by this application.
2. Create a sandbox business account for the app, a personal account for the buyer, and a separate personal account for the worker.
3. Use the worker's exact sandbox PayPal email in the buyer form. Never put PayPal passwords in the app or repository.

### 2. Configure the server

```bash
cd paypal
cp .env.example .env
```

Edit `.env` locally:

```dotenv
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=your-sandbox-client-id
PAYPAL_CLIENT_SECRET=your-sandbox-client-secret
OPENROUTER_API_KEY=your-openrouter-key
OPENROUTER_MODEL=openai/gpt-4.1-mini
PUBLIC_URL=http://localhost:3000
```

OpenRouter is the preferred AI provider. The default `openai/gpt-4.1-mini` model supports structured output and has low usage-based pricing. `ANTHROPIC_API_KEY` is an optional alternative when OpenRouter is not configured. Without either key, manual criteria and manual delivery still work. Do not paste secrets into chat, screenshots, the video, or the repository.

### 3. Start and exercise the real flow

```bash
npm ci
npm run dev
```

Open http://localhost:3000, draft or review the checks, and create a job using the real sandbox worker email. Save the private worker link. Approve the order with the sandbox buyer through PayPal Buttons. Deliver passing and failing work on separate jobs and confirm these records in the PayPal Developer Dashboard:

- One order with intent `AUTHORIZE` and the criteria hash in `custom_id`.
- One authorization while the job is funded.
- One capture and one successful payout after passing work.
- One void and no capture or payout after failing work.
- `GET /api/health` returns `{ "ok": true }` during operation.

The merchant secret cannot approve a buyer's order. The buyer must complete that step personally in PayPal's hosted checkout.

### CLI-assisted real sandbox proof

With `npm run dev` running in another terminal, the CLI can create both jobs and their real PayPal orders, preserve private delivery keys with mode `0600`, settle after buyer approval, and independently read back PayPal's records:

```bash
npm run sandbox:e2e -- prepare --worker=YOUR_SANDBOX_WORKER_EMAIL --open
# Approve both PayPal orders with the sandbox buyer in the opened browser tabs.
npm run sandbox:e2e -- settle
npm run sandbox:e2e -- verify
```

The runner refuses to use the simulator. It creates no duplicate jobs when preparation is repeated, and it does not deliver again after a terminal result. Its private state is in the git-ignored `.data/sandbox-e2e.json`; it never prints the worker key. To test real AI delivery after adding `OPENROUTER_API_KEY`, prepare with `--new` and then run `npm run sandbox:e2e -- settle --ai` before `verify`.

The CLI cannot discover private sandbox account credentials or approve a buyer on the account holder's behalf. Those remain PayPal-hosted user actions. Everything else in the pass, refund, payout, and verification sequence is handled through the app API and PayPal REST API.

### Verification status

- **89 automated tests pass.** They cover the API, both settlement outcomes, retries, idempotency, private delivery authorization, key privacy, receipt tampering, dashboard totals, local-preview startup, both AI providers, the AI usage caps, the plain-language check descriptions, and the Vercel Blob job store's conflict handling.
- **The complete browser scenario passes in Chromium:** one paid reconciliation, one refunded delivery, private worker-link use, independent receipt verification, live dashboard, and mobile layouts with no console errors.
- **Real PayPal sandbox settlement passes.** A passing job captured $5.00 and paid the worker $4.75 with PayPal Payouts reporting `SUCCESS`. A failing job voided its authorization with no capture or payout. Independent PayPal reads confirmed the order terms, capture, payout receiver and amount, and void.
- **Real receipt evidence passes in Chromium:** the paid job, refunded job, independent receipt recomputation, dashboard, and mobile layout were checked with no console errors. These checks used the real sandbox records, not the simulator.
- **Real OpenRouter drafting and delivery pass.** The verified run used `openai/gpt-4.1-mini` to produce one comprehensive JSON check, including the exact total, currency, closed object fields, and three unique allowed receipt IDs. Its criteria hash is `0x172bf9ca9fea09590e35133796efd0fd1ffc8b74ceec497ba460295848d39f66`. Passing job `1793795940574689` captured $5.00, paid the worker $4.75, and reached payout `SUCCESS`. Failing job `1793795943066454` voided its authorization without capture or payout. Both were independently checked through PayPal REST. The passing payout batch is `294Q842SX33N4`; the delivery is 229 bytes with SHA-256 `0e50ea63e70a0b35026ca84d236071fab66faa0bbd2b47f4b19757956bea7544`.
- **The shared Judge engine passes its 323 tests**, including the `uniqueItems` support used by this AI draft. The engine sources in the service, browser verifier, and PayPal module are synchronized.

These settlement results are from local sandbox runs, not a production claim. The hosted demo at https://judgepay.vercel.app answers healthy with real sandbox PayPal and OpenRouter, has drafted checks with the real model and created a real sandbox order; the full hosted pass and fail through PayPal Buttons is recorded below once it is run. The optional Anthropic provider has stand-in tests but was not used in the real AI run.

## Deploy on Vercel

The hosted demo runs on Vercel from this folder: `public/` is served as static pages and every `/api/*` request goes to one function, `api/index.js` (see `vercel.json`). Jobs are kept in a private Vercel Blob store, because a function's disk does not last between requests.

```bash
cd paypal
vercel link
vercel blob create-store judge-pay-jobs --access private --yes   # adds BLOB_READ_WRITE_TOKEN
vercel env add PAYPAL_CLIENT_ID production       # and PAYPAL_CLIENT_SECRET, OPENROUTER_API_KEY
vercel env add PAYPAL_ENV production             # sandbox
vercel env add OPENROUTER_MODEL production       # openai/gpt-4.1-mini
vercel env add PUBLIC_URL production             # the production https URL, no trailing slash
vercel deploy --prod
```

Blob reads bypass the CDN cache, and each job update is written only if nobody changed the job since it was read (an ETag check); a conflicting update is re-applied to the fresh record. PayPal calls happen outside those updates and carry their own idempotency keys. Give the OpenRouter key a small spend limit: the demo has no accounts, so the in-memory AI caps are its only abuse control besides that limit.

## API

All mutations use JSON. Public job views contain terms, hashes, verdicts, events, and PayPal record IDs, never worker credentials, personal account details, or delivered bytes. The private delivery key is returned only in the job-creation response.

| Route | Purpose |
|---|---|
| `POST /api/ai/draft` | AI drafts objective criteria |
| `POST /api/jobs` | Create a job, pin its criteria hash, and return its private delivery key once |
| `GET /api/jobs` | Public job views for the dashboard |
| `GET /api/jobs/:id` | Current public state, including settlement recovery |
| `POST /api/jobs/:id/order` | Create or recover the PayPal authorization order |
| `POST /api/jobs/:id/authorize` | Verify order terms and create the hold after buyer approval |
| `POST /api/jobs/:id/ai-work` | Authenticate the job key, run AI revisions, deliver only a passing draft |
| `POST /api/jobs/:id/deliver` | Judge and settle a direct delivery authorized by the job key |
| `POST /api/jobs/:id/delivery` | Retrieve the original bytes with the private job key |
| `GET /api/jobs/:id/receipt` | Portable receipt after judging |
| `POST /api/jobs/:id/payout-review` | Operator reconciles an uncertain payout |
| `GET /api/health` | Service and configuration health |

## Code map

- `src/app.js`: HTTP API and static app server.
- `src/paypal.js`: PayPal REST client and idempotency handling.
- `src/escrow.js`: job state machine, settlement recovery, private delivery authorization, public views, and receipts.
- `src/ai.js`: shared AI schemas and prompts, plus optional Anthropic delivery.
- `src/openrouter-ai.js`: OpenRouter criteria drafting and self-checking worker.
- `src/store.js`: memory, atomic JSON-file, and Vercel Blob stores.
- `src/server.js`: builds the app from environment variables for both runtimes.
- `api/index.js` and `vercel.json`: the Vercel function and routing.
- `engine/`: copied deterministic Judge Protocol engine, protected by a drift test.
- `public/index.html`: buyer flow.
- `public/job.html`: funding, private worker invitation, verdict, and evidence trail.
- `public/worker.html`: private worker access and delivery.
- `public/receipt/`: independent browser receipt checker.
- `public/dashboard/`: AG Grid Community dashboard.
- `scripts/dev-server.js`: real PayPal sandbox runtime on your machine.
- `scripts/local-demo.js`: isolated local preview runtime.

## AI and sponsor tools

- **OpenRouter with `openai/gpt-4.1-mini` by default:** turns the task into structured checks and produces the worker's drafts. The request, repair loop, and actual model reporting are in `src/openrouter-ai.js`.
- **Optional Anthropic Claude:** used only when `ANTHROPIC_API_KEY` is set without OpenRouter, configured by `AI_MODEL`. Not used by the hosted demo.
- **PayPal Developer Platform:** authorization, capture, void, Payouts, and Buttons are part of the actual job lifecycle.
- **AG Grid Community 36.2.0:** live filterable and sortable jobs dashboard with payment exceptions and per-job evidence.
- **Vercel:** hosts the judge-accessible sandbox demo, with jobs in Vercel Blob.

## Security and scope limits

- Sandbox is the default. Real money requires both `PAYPAL_ENV=live` and `JUDGE_PAY_ALLOW_LIVE=yes`.
- The 5% platform fee is illustrative application logic. PayPal processing and payout fees are separate and are not a revenue claim.
- Only deterministic form, content, length, checksum, and JSON checks are supported. They cannot prove truth, taste, accuracy, or the authenticity of external records.
- A private job link proves possession of its delivery key, not control of the worker's PayPal email. Add verified worker identity and key revocation before production use.
- The buyer receives the worker link when creating the job and passes it on, so the buyer could also deliver through it, for example by submitting failing work first to have the hold voided. The prototype trusts the buyer not to do this; a production version needs a delivery credential only the worker holds.
- AI calls are capped per caller each hour and per day in memory, to protect the demo's model budget. The provider key should also carry its own spend limit.
- Delivery keys are stored in the browser and shown in private worker links. Keep them out of screenshots and public recordings.
- Receipts are internally recomputable but not signed. Confirm PayPal IDs in the PayPal account to establish who issued them.
- The file store serializes writes within one process; the Blob store adds ETag-checked writes across function instances. A production deployment still needs a transactional database, worker identity, per-account rate limits, monitoring, and operational payout reconciliation.
- Job terms and payment record IDs are public by design. Delivered bytes, personal account details, and delivery-key hashes are not public.
- This is a hackathon prototype, not a production escrow service, money transmitter, or guarantee of payment for subjective work.

## Tests

```bash
cd paypal
npm test
node scripts/make-examples.js
npm run sync-engine
npm test
```

The PayPal tests use a local stand-in shaped after PayPal's published API behavior. AI tests use a stand-in client. The local-preview smoke test starts the real preview process and verifies its funding configuration. Browser evidence is generated separately from the unit suite.

## Hackathon progress

The pre-existing Judge engine and initial PayPal modules were significantly extended during the submission window with the complete browser application, HTTP API, buyer funding flow, private worker invitations, AI delivery route, private delivery retrieval, live dashboard integration, reconciliation demo, Vercel hosting with a Blob job store, AI usage caps, and end-to-end tests.

MIT licensed. See the repository's top-level `LICENSE` file.
