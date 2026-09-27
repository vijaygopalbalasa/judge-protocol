# Plug Judge Protocol into your agent payments (Arc testnet)

Judge Protocol is a neutral, deterministic evaluator for ERC-8183 jobs. The client
writes the acceptance criteria into the job, the provider delivers, and the judge
checks the delivery against those criteria and settles the escrow: PASS pays the
provider, REJECT refunds the client. Anyone can recompute a ruling at
https://judge-protocol-verifier.vercel.app from chain data (plus the file, for a deliverable
hosted off chain), so nobody has to trust the judge. The one exception is a live
`http-endpoint` probe: its result is shown as the judge recorded it.

It is free to use on Arc testnet. It is best effort with no uptime guarantee.

| | Arc testnet |
|---|---|
| Circle's ERC-8183 contract (ACP) | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| JudgeEvaluator (the evaluator address to name) | `0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD` |
| USDC | `0x3600000000000000000000000000000000000000` |
| Hosted judge API | https://judge-protocol-api.vercel.app |
| Verifier | https://judge-protocol-verifier.vercel.app |

## Path A: your agents use Circle's ERC-8183 contract (about 10 minutes)

1. **Client** creates the job with `evaluator = 0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD`
   and the criteria in the description as a fenced `judge-criteria` block
   ([criteria reference](CRITERIA.md)).
2. **Provider** calls `setBudget`; **client** approves USDC and calls `fund`.
3. **Provider** calls `submit(jobId, keccak256(deliverableBytes), optParams)` with
   `optParams` = the UTF-8 bytes of `deliverableURI: <uri>`, from an ordinary account
   (the judge reads `optParams` from the submit transaction itself, so a submit relayed
   through a smart-contract wallet is not read). The URI can be:
   - `data:<type>;base64,<base64>` (what the kit writes; its `mediaType` option sets the type)
     or `data:,<percent-encoded text>`, for small content;
   - `https://...` on a host you control: at most 1 MB, fully downloaded within 5 seconds, no
     redirects, no credentials in the URL, public addresses only;
   - `ipfs://<cid>`, fetched through a public gateway (ipfs.filebase.io by default). This is
     best effort; prefer https for anything that matters.
4. **Anyone** asks for the ruling: `POST /api/judge` with the job id and the submit
   transaction hash. The judge settles on chain in the same request.

With the kit (`kit/judge-kit.js`, one file, depends only on viem):

```js
import * as kit from "./judge-kit.js";

const criteria = { version: 1, checks: [
  { kind: "length", params: { min: 20, max: 400 } },
  { kind: "contains", params: { all: ["ERC-8183", "USDC"] } },
] };
const job = await kit.createJudgedJob({ walletClient: client, publicClient, provider: providerAddress, criteria });
await kit.setBudget({ walletClient: provider, publicClient, jobId: job.jobId, amount: 100_000n }); // 0.10 USDC
await kit.fundJob({ walletClient: client, publicClient, jobId: job.jobId, amount: 100_000n });
const sub = await kit.submitDeliverable({ walletClient: provider, publicClient, jobId: job.jobId, content: work });
const ruling = await kit.requestRuling({ jobId: job.jobId, submitTx: sub.txHash });
```

`submitDeliverable` inlines the work as a `data:` URI (up to 48 KB). For bigger work, host
the exact bytes and pass their address as `uri`, for example
`kit.submitDeliverable({ ..., content: work, uri: "https://files.example.com/work.txt" })`: the
commitment is the hash of `content`, so the hosted file must be byte for byte the same.

The kit is not published to npm: copy `kit/judge-kit.js` into your project and add viem.
`kit/example.js` is the complete, runnable version (two testnet keys with a little testnet
USDC for gas, about a minute):

```bash
git clone https://github.com/vijaygopalbalasa/judge-protocol && cd judge-protocol/kit
npm ci
CLIENT_KEY=0x... PROVIDER_KEY=0x... node example.js
```

Or with plain HTTP after `submit`:

```bash
curl -X POST https://judge-protocol-api.vercel.app/api/judge \
  -H 'content-type: application/json' \
  -d '{"jobId":"186740","submitTx":"0x<provider submit tx hash>"}'
```

The criteria from the kit example, as they appear in the description:

```judge-criteria
{"version":1,"checks":[{"kind":"length","params":{"min":20,"max":400}},{"kind":"contains","params":{"all":["ERC-8183","USDC"]}}]}
```

If you write the block by hand, keep it one valid JSON object and write any backtick inside
a term as `\u0060`: three backticks in a row would close the block early. `kit.criteriaBlock`
does this for you and refuses criteria the judge would refuse.

## Path B: your own escrow (for example a fork of circlefin/arc-escrow)

The on-chain ruling above needs Circle's ERC-8183 contract. If you run your own
escrow, you can still use the same deterministic checks to decide release for
structured deliverables:

```bash
curl -X POST https://judge-protocol-api.vercel.app/api/evaluate \
  -H 'content-type: application/json' \
  -d '{"criteria":{"checks":[{"kind":"schema","params":{"required":["invoiceId","total"]}}]},"deliverable":"{\"invoiceId\":\"A-17\",\"total\":42}"}'
```

`POST /api/evaluate` returns the score, the decision, and the `evidenceHash` the
judge would sign for the same inputs (pass the job's `jobId`: the hash includes it, so
without it the hash will not match an on-chain verdict). It never signs, never settles
and never makes a network request: an `http-endpoint` check is listed in `notRun`, and with
one in the criteria `score`, `pass` and `evidenceHash` come back `null`. The deliverable can
be at most 256 KB here. Anyone can recompute its answer with the service code
(`judge-service/src/evaluate.js`); the kit only validates criteria, it does not score. For images and other subjective work, keep a human or a
model in the loop: a deterministic check cannot judge taste.

## API reference

### `POST /api/judge`
Body: `{"jobId": "<id>", "submitTx": "0x..."}`. `submitTx` is optional for
submissions in the last ~4 hours and needed for older ones (the daily sweep also
finds submissions from the last ~2 days).

| HTTP | `result` | Meaning | What to do |
|---|---|---|---|
| 200 | `judged` | The judge ruled and settled on chain. Includes `pass`, `score`, `txHash`, `evidenceHash`. | Done. Verify it at the verifier if you like. |
| 200 | `already-judged` | A verdict already exists (maybe another caller asked first). Includes `verdict`. | Done. |
| 200 | `not-ours` | The job names a different evaluator. | Create the job with the JudgeEvaluator address. |
| 200 | `not-submitted` | The job is Open or Funded, not Submitted yet. | Ask again after `submit`. |
| 200 | `expired` | The client already took the escrow back with `claimRefund` after expiry. | Nothing to rule. |
| 200 | `closed` | The job was already completed or rejected. | Nothing to rule. |
| 200 | `skipped` | For example the budget is under 0.01 USDC (spam guard). | Use a budget of at least 0.01 USDC. |
| 404 | `not-found` | No job with this id exists on the ACP contract. | Check the job id (and that you are on Arc testnet). |
| 404 | `submission-not-found` | No `JobSubmitted` event found in the search window. | Pass `submitTx`. |
| 422 | `abstained` | The judge will not rule. `reason` says why: invalid criteria, other criteria registered on chain for the job, no deliverable URI, content that does not hash to the provider's commitment, or a deliverable that can never load (it redirects, is over 1 MB, has credentials or a port the judge will not use, is on a private IP address, or uses an unsupported scheme). | Fix the job if you can (a host can stop redirecting); otherwise `claimRefund` after expiry. Answers are cached for 10 minutes. |
| 503 | `retry-later` | A temporary problem: the deliverable host is down, slow or answering with an error, Arc testnet could not be read, or the judge contract is paused. | Ask again later. The daily sweep also retries submissions from the last ~2 days. |
| 502 | `error` | The ruling could not be settled right now. | Ask again later. |
| 400 | (none) | `error` says what is wrong: malformed JSON, a `jobId` that is not a positive integer, or a `submitTx` that is not a 32-byte hash. | Fix the request. |
| 413 | (none) | The request body is over 4 KB. | Send only `jobId` and `submitTx`. |

### `GET /api/judge?jobId=<id>`
Read-only. `result` is `judged` (with the on-chain `verdict`), `pending` (Submitted,
not ruled yet), `not-submitted`, `expired`, `closed`, `not-ours`, or `not-found`. It never signs.

### `POST /api/evaluate`
Dry run, see Path B. Body: `criteria` plus exactly one of `deliverable` (text) or
`deliverableBase64`; optional `jobId` (only used in the `evidenceHash`).

### `POST /api/x402/judge` (paid over x402)
The same ruling, paid for over [x402](https://x402.org): 0.01 USDC through Circle Gateway
on Arc testnet (`eip155:5042002`). The judge prepares the verdict first and settles your payment
only when a verdict is ready, before it signs anything. This is the fee model, since Circle's
ERC-8183 contract has no evaluator fee; the free `POST /api/judge` keeps working on testnet.

- A job waiting for a ruling (it names the judge, is Submitted, has no verdict yet, a budget of
  at least 0.01 USDC and valid criteria) gets `402` with the terms in the `PAYMENT-REQUIRED`
  header (x402 v2). Any other job is answered for free, with the same `result` values as above.
- Send the signed payment in a `payment-signature` header. The judge checks it locally (terms,
  recipient, amount, canonical numbers, signature), asks Circle Gateway to verify it, checks your
  Gateway balance, prepares the verdict, checks the contract would accept it (not paused, signer
  authorized, no other criteria registered), and only then settles the payment and signs.
- Every answer carries `charged`: `true`, `false`, or `"unknown"` if Gateway could not confirm.
  That includes malformed or oversized requests (400, 413), which are never charged.
  A settled payment's receipt comes back in the `PAYMENT-RESPONSE` header and as `payment` in the
  body. Trust those, not the amount your client signed: Circle's `GatewayClient.pay()` reports
  the signed amount even when the payment was not settled.
- Nothing is settled when no verdict is ready (the judge abstains, a transient failure, the job
  was already judged). `payment-failed` (402) means Gateway refused the settlement (for example
  an empty balance or a payment already used) and nothing was signed. If the verdict transaction
  still fails after your payment settled, the answer says which way. If it did not go through,
  ask again for free with `POST /api/judge` (same `jobId` and `submitTx`): the judge rules again,
  and without `http-endpoint` checks it reaches the same verdict. If the contract refused it, that
  is a fault on the judge's side: report it at the repo's issues. The fee is not refunded
  automatically.

With Circle's client (`npm install @circle-fin/x402-batching`):

```js
import { GatewayClient } from "@circle-fin/x402-batching/client";

const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: process.env.AGENT_KEY });
await gateway.deposit("0.50"); // once: fund your Gateway balance
const { data } = await gateway.pay("https://judge-protocol-api.vercel.app/api/x402/judge",
  { method: "POST", body: { jobId: "186760" } });
```

`pay()` returns only 2xx answers and throws on anything else, so you do not see `result` or
`charged` in those cases. Check first that `GET /api/judge?jobId=<id>` says `pending`. Before
a payment, the error is `Request failed with status <code>` and nothing was paid. After a
payment, it is `Payment failed: <error>`, and every such error means nothing was settled except
one that says your payment settled (see above).

### `GET /api/health`
The judge address, its signer and whether the signer is authorized on chain, and
the relayer's gas balance.

## How to check a ruling yourself

- In a browser: https://judge-protocol-verifier.vercel.app, enter the job id. It
  recomputes every hash and the score from chain data and shows each check. For a
  deliverable hosted at a URL, the page does not fetch it: drop in the file and it checks
  those exact bytes against the provider's commitment.
- From a terminal: `node judge-service/src/verify.js <jobId>` in a checkout of the
  repo, after `npm ci` in `judge-service` (no keys needed). For a deliverable hosted at a URL,
  pass the file with `--deliverable <file>`.

## Limits, stated plainly

- Arc testnet only. Best effort, no uptime guarantee, no SLA. If the judge never
  rules, `claimRefund` after `expiredAt` returns the client's funds.
- Deterministic checks cover objective, structured work. They do not judge quality or taste.
- `http-endpoint` checks are live probes and cannot be re-run later as the judge saw them.
  Without a `url` they probe the deliverable's own URL, so with a `data:` deliverable give
  them an explicit `url` (otherwise the check fails with "no url provided").
- Deliverables at an https URL: at most 1 MB, fully downloaded within 5 seconds, no redirects,
  no credentials in the URL, public addresses only. A redirect, an oversized file, credentials,
  a port the judge will not use or a private IP address makes the judge abstain; a timeout, a
  DNS failure (including a name that resolves to a private address) or an HTTP error status is
  treated as temporary and retried. For `ipfs://`, only an oversized file abstains; gateway
  problems are retried.
- Inline `data:` deliverables are for small content (the kit caps them at 48 KB);
  host larger work at an https or ipfs URI (the kit's `uri` option).
- Paid rulings settle in Circle Gateway batches, so the transfer completes minutes later.
  Gateway refuses to settle a used payment or an empty balance, and the judge signs only after
  a payment settled, so a replayed payment or a burst against one balance buys at most one
  ruling. If Gateway cannot confirm a settlement, the judge rules anyway and answers
  `charged: "unknown"`: that risk is the judge's, not the payer's.
