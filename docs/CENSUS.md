# Who judges ERC-8183 jobs on Arc? A full census of Circle's testnet contract

Every job ever created on Circle's ERC-8183 contract on Arc testnet
(`0x0747EEf0706327138c69792bF28Cd525089e4583`), read from chain: jobs 1 to 186,776 at block
64,338,738 (2026-09-27 23:16 UTC). Not a sample.

## Findings

- **Most jobs are graded by the party that pays.** In 71.79% of jobs the evaluator is the client
  (70.96%) or the provider (0.83%). A third party evaluates 52,686 jobs (28.21%). No job has an empty
  evaluator.
- **Budgets are small.** 89,889 jobs were funded; the median budget is 1.00 USDC.
- **Status today:** 96,983 Completed, 82,522 Open, 3,943 Funded, 2,111 Submitted, 1,090 Rejected,
  127 Expired.
- **Third-party evaluation is concentrated in a ring.** 3,323 distinct third-party evaluators exist,
  and 2,849 of them were paid through (a funded job they evaluated reached Completed): 21,747 jobs
  and 22,671.47 USDC in total. Five evaluators, each paid by a single client for about 2,310 jobs of
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

## Definitions

From `judge-service/src/census-lib.js`, where they are pinned by tests:

- self-evaluated: the evaluator is the job's client or its provider
- third party: the evaluator is neither, and is not the zero address
- paid through: third party, funded (budget above 0) and Completed; the volume is the sum of those
  budgets
- independent evaluator: an address that never appears as a client or provider on any job, with at
  least 4 distinct clients who funded a job naming it

## Reproduce it

No keys needed; it only reads.

```bash
git clone https://github.com/vijaygopalbalasa/judge-protocol && cd judge-protocol/judge-service
npm ci
node src/census.mjs --out census.jsonl
```

It reads every job through Multicall3 and then scans the contract's logs in 10,000-block ranges. On
the public RPC that takes about 30 to 60 minutes. It resumes where it stopped, splits any batch or
range that fails, and reports what it could not read instead of dropping it. The summary is printed
and written to `census.jsonl.summary.json`. New jobs keep arriving, so later runs will differ.

## Limits

- Testnet only. Testnet jobs are cheap, so farms and tests dominate the counts.
- An address is not an identity. The census sees roles and money, not who is behind a wallet.
- It is a snapshot at one block. The block and time are recorded in the summary.
