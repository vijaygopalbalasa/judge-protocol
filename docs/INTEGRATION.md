# Plug Judge Protocol into your agent payments (Arc testnet)

Judge Protocol is a neutral, deterministic evaluator for ERC-8183 jobs. The client
writes the acceptance criteria into the job, the provider delivers, and the judge
checks the delivery against those criteria and settles the escrow: PASS pays the
provider, REJECT refunds the client. Every ruling can be recomputed by anyone at
https://judge-protocol-verifier.vercel.app, so nobody has to trust the judge.

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
   `optParams` = the UTF-8 bytes of `deliverableURI: <uri>`. Use a `data:` URI for
   small text, or an `https://` / `ipfs://` URI you control.
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

`kit/example.js` is the complete, runnable version (two testnet keys, about a minute).

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
judge would sign for the same inputs. It never signs, never settles and never makes
a network request (an `http-endpoint` check is reported as not run). Anyone can
recompute its answer with the kit or the verifier code. For images and other
subjective work, keep a human or a model in the loop: a deterministic check
cannot judge taste.

## API reference

### `POST /api/judge`
Body: `{"jobId": "<id>", "submitTx": "0x..."}`. `submitTx` is optional for
submissions in the last ~4 hours and needed for older ones (the daily sweep also
finds them).

| HTTP | `result` | Meaning | What to do |
|---|---|---|---|
| 200 | `judged` | The judge ruled and settled on chain. Includes `pass`, `score`, `txHash`, `evidenceHash`. | Done. Verify it at the verifier if you like. |
| 200 | `already-judged` | A verdict already exists (maybe another caller asked first). Includes `verdict`. | Done. |
| 200 | `not-ours` | The job names a different evaluator. | Create the job with the JudgeEvaluator address. |
| 200 | `not-submitted` | The job is not in the Submitted state yet. | Ask again after `submit`. |
| 200 | `skipped` | For example the budget is under 0.01 USDC (spam guard). | Use a budget of at least 0.01 USDC. |
| 404 | `not-found` | No job with this id exists on the ACP contract. | Check the job id (and that you are on Arc testnet). |
| 404 | `submission-not-found` | No `JobSubmitted` event found in the search window. | Pass `submitTx`. |
| 422 | `abstained` | The judge will not rule (invalid criteria, no deliverable URI, content does not match the commitment). `reason` says which. | Fix the job; if it cannot be fixed, `claimRefund` after expiry. |
| 503 | `retry-later` | A temporary problem, for example the deliverable host is down. | Ask again later. |
| 502 | `error` | The ruling could not be settled right now. | Ask again later. |

### `GET /api/judge?jobId=<id>`
Read-only. `result` is `judged` (with the on-chain `verdict`), `pending` (Submitted,
not ruled yet), `not-submitted`, `expired`, `closed`, `not-ours`, or `not-found`. It never signs.

### `POST /api/evaluate`
Dry run, see Path B. Body: `criteria` plus exactly one of `deliverable` (text) or
`deliverableBase64`; optional `jobId` (only used in the `evidenceHash`).

### `POST /api/x402/judge` (paid over x402)
The same ruling, paid for over [x402](https://x402.org): 0.01 USDC through Circle Gateway
on Arc testnet (`eip155:5042002`), charged only when a verdict lands on chain. This is
the fee model, since Circle's ERC-8183 contract has no evaluator fee; the free
`POST /api/judge` keeps working on testnet.

- A job the judge can rule right now gets `402` with the terms in the `PAYMENT-REQUIRED`
  header (x402 v2). Any other job is answered for free, with the same `result` values
  as above and `charged: false`.
- Send the signed payment in a `payment-signature` header. The judge checks it locally
  (terms, recipient, amount, signature), asks Circle Gateway to verify it, checks your
  Gateway balance, rules, and only then settles. The receipt comes back in the
  `PAYMENT-RESPONSE` header and as `payment` in the body.
- No verdict from your request (the judge abstained, a transient failure, another
  request ruled first): the payment is never settled and the body says `not charged`.

With Circle's client (`npm install @circle-fin/x402-batching`):

```js
import { GatewayClient } from "@circle-fin/x402-batching/client";

const gateway = new GatewayClient({ chain: "arcTestnet", privateKey: process.env.AGENT_KEY });
await gateway.deposit("0.50"); // once: fund your Gateway balance
const { data } = await gateway.pay("https://judge-protocol-api.vercel.app/api/x402/judge",
  { method: "POST", body: { jobId: "186760" } });
```

### `GET /api/health`
The judge address, its signer and whether the signer is authorized on chain, and
the relayer's gas balance.

## How to check a ruling yourself

- In a browser: https://judge-protocol-verifier.vercel.app, enter the job id. It
  recomputes every hash and the score from chain data and shows each check.
- From a terminal: `node judge-service/src/verify.js <jobId>` in a checkout of the
  repo (no keys needed).

## Limits, stated plainly

- Arc testnet only. Best effort, no uptime guarantee, no SLA. If the judge never
  rules, `claimRefund` after `expiredAt` returns the client's funds.
- Deterministic checks cover objective, structured work. They do not judge quality or taste.
- `http-endpoint` checks are live probes and cannot be re-run later as the judge saw them.
- Inline `data:` deliverables are for small content (the kit caps them at 48 KB);
  host larger work at an https or ipfs URI.
- Paid rulings settle in Circle Gateway batches, so the transfer completes minutes
  later. The judge settles only after a verdict; if a payer empties its Gateway balance
  in between, that ruling goes unpaid. The judge carries that risk, never the payer.
