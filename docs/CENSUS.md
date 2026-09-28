# Who judges ERC-8183 jobs on Arc? A full census of Circle's testnet contract

Every job ever created on Circle's ERC-8183 contract on Arc testnet
(`0x0747EEf0706327138c69792bF28Cd525089e4583`), read from chain: jobs 1 to 186,776 at block
64,338,738 (2026-09-27 23:16 UTC). Not a sample.

## Findings

- **Most jobs are graded by the client who pays.** In 70.96% of jobs the evaluator is the client; with
  the provider (0.83%), 71.79% are graded by one of the two parties to the job. A third party evaluates
  52,686 jobs (28.21%). No job has an empty evaluator.
- **Budgets are small.** 89,889 jobs were funded; the median budget is 1.00 USDC.
- **Status today:** 96,983 Completed, 82,522 Open, 3,943 Funded, 2,111 Submitted, 1,090 Rejected,
  127 Expired.
- **Third-party evaluation is concentrated in a ring.** 3,323 distinct third-party evaluators exist,
  and 2,849 of them were paid through (a funded job they evaluated reached Completed): 21,747 jobs
  and 22,671.47 USDC in total. Five evaluators, each named by a single client on about 2,310 jobs of
  about 1 USDC, account for 51.0% of that volume.
- **Few evaluators serve several clients.** 17 evaluators never act as a client or provider on any
  job and have 4 or more distinct clients who funded a job naming them. The largest has 55 such
  clients (49 of them on completed jobs); the next has 9; the rest have 4 to 6. Independent by role
  is not proof of independent ownership: some of these may still be one operator's wallets.
- **No hook has ever been used.** No job names a hook, and the contract has emitted no
  `HookWhitelistUpdated` event since it was deployed (block 33,908,011). Control: the same log scan
  found exactly 186,776 `JobCreated` events, equal to the job counter, so the scan saw every job.
- **No fees.** `evaluatorFeeBP` and `platformFeeBP` are both 0, so an evaluator earns nothing on
  chain from this contract.
- **Judge Protocol itself:** 27 jobs name JudgeEvaluator, all from one client (my own test jobs).

## The same count on Virtuals' AgenticCommerceV3

Virtuals' AgenticCommerceV3 (`0x238E541BfefD82238730D00a2208E5497F1832E0` on Base and on Arc
mainnet) has the same job lifecycle, evaluator role, hooks and fee fields as ERC-8183's reference
implementation, with one difference that matters here: a job may name no evaluator, and such a job
completes as soon as the provider submits. ERC-8183 requires an evaluator. Every job read the same
way (2026-09-28), with the same definitions:

| | Base (block 51,910,587) | Arc mainnet (block 23,218,739) |
|---|---|---|
| Jobs | 81,252 | 143 |
| No evaluator | 46,053 (56.68%) | 20 |
| Graded by the client | 35,162 (43.28%) | 0 |
| Graded by the provider | 0 | 0 |
| Third-party evaluator | 37 (0.05%), 8 distinct | 123, one evaluator |
| Third party, funded and completed | 18 jobs, 0.97 USDC, 5 evaluators | 77 jobs, 0.01 USDC |
| Median funded budget | 0.01 USDC | under 0.01 USDC |
| Jobs with a hook | 1,924 | 111 |
| Fees (evaluator / platform) | 500 / 500 basis points | 500 / 500 basis points |
| Evaluator fees paid, to the job's client | 99.84 USDC on 7,880 jobs | none |
| Evaluator fees paid, to a third party | 0.05 USDC on 18 jobs | 0.000535 USDC on 77 jobs |

- **On Base, the evaluator fee goes back to the client.** The contract pays its 5% evaluator fee only
  when a named evaluator completes a job, and the client names the evaluator. Of 15,850 completed
  jobs, 6,023 (38.00%) named no evaluator and completed on submission with no evaluator fee, 9,809
  (61.89%) named the client, and 18 (0.11%) a third party. The fees the contract actually paid, from
  its `EvaluatorFeePaid` events with every payment joined to its job, came to 99.84 USDC to clients
  grading their own jobs and 0.05 USDC to third parties. (The other 1,929 client-graded completed jobs
  had budgets too small for a nonzero 5%, most of them 0.) By completed budget, 95.09% was graded by
  the client itself.
- **Self-evaluation is growing.** Jobs 1 to 62,953 give exactly the split in Marsel Sultanov's
  [index of this contract](https://github.com/marsakahenry14-lab/virtuals-forensics) (72.50% no
  evaluator, 27.48% the client, 10 jobs a third party). Of the 18,299 jobs since, 97.62% name the
  client.
- **On Arc mainnet it is test-sized:** 143 jobs from two clients and two providers, one evaluator,
  about 0.02 USDC funded in total.
- Both log scans passed their control: 81,252 `JobCreated` events on Base (read to block 51,910,636
  in 2,000-block ranges, the public endpoint's limit; no job was created after the job read) and 143
  on Arc mainnet, each equal to the job counter. The contract emitted 4 `HookWhitelistUpdated` events
  on Base and 3 on Arc mainnet (an event can enable or disable a hook, so the count is of status
  changes, not distinct hooks), and on each chain one `EvaluatorFeeUpdated`, setting 500 basis points
  a few blocks after deployment and before any fee was paid.

## Definitions

From `judge-service/src/census-lib.js`, where they are pinned by tests:

- self-evaluated: the evaluator is the job's client or its provider
- third party: the evaluator is neither, and is not the zero address
- paid through: third party, funded (budget above 0) and Completed; the volume is the sum of those
  budgets
- evaluator fees paid: the contract's `EvaluatorFeePaid` events, each joined to its job and classed by
  whether the recipient is the job's client, its provider or a third party; a payment that does not
  join its job is reported as unmatched (none did)
- independent evaluator: an address that never appears as a client or provider on any job, with at
  least 4 distinct clients who funded a job naming it

## Reproduce it

No keys needed; it only reads.

```bash
git clone https://github.com/vijaygopalbalasa/judge-protocol && cd judge-protocol/judge-service
npm ci
node src/census.mjs --out census.jsonl
```

For Virtuals' contract, add `--acp 0x238E541BfefD82238730D00a2208E5497F1832E0 --layout virtuals-v3`
and an RPC for the chain: `--rpc https://mainnet.base.org --log-span 2000` for Base (it serves old
state and logs, slowly; `https://base-rpc.publicnode.com` reads jobs faster but serves no old logs,
so use it with `--no-logs`), or `--rpc https://rpc.mainnet.arc.io` for Arc mainnet.

It reads every job through Multicall3 and then scans the contract's logs, in 10,000-block ranges
unless `--log-span` says otherwise, for `JobCreated`, `HookWhitelistUpdated`, `EvaluatorFeePaid` and
`EvaluatorFeeUpdated`. On Arc's public RPC that takes about 30 to 60 minutes; the Base log scan takes
about 20 more. It resumes where it stopped, splits any batch or
range that fails, and reports what it could not read instead of dropping it. The summary is printed
and written to `census.jsonl.summary.json`. New jobs keep arriving, so later runs will differ.

## Limits

- Circle's contract is on testnet, where jobs are cheap, so farms and tests dominate its counts. Base
  and Arc mainnet are real money, but the budgets are small (median 0.01 USDC on Base).
- An address is not an identity. The census sees roles and money, not who is behind a wallet.
- It is a snapshot. The job counter and the logs are read at one block, recorded in the summary with
  the time; the jobs themselves are read in the minutes after it, so a job whose status changed
  during the run shows the newer status.
