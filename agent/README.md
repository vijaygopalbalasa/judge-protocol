# Paymaster: a contractor-payments agent that only pays for verified work

The owner writes a budget and describes each milestone in plain English. The
paymaster turns each milestone into acceptance criteria a machine can check,
picks a contractor from their verified record, funds an ERC-8183 escrow on Arc
that names Judge Protocol as the evaluator, and pays the judge 0.01 USDC per
ruling over x402 through Circle Gateway. The contractor is paid when the judge
rules PASS; a REJECT refunds the escrow and the milestone goes to someone else.

The one thing it cannot do is pay for work nobody verified.

## Why it cannot pay for unverified work

That is a property of the code, not of a prompt:

- **Its wallet has four capabilities and nothing else** (`src/guard.js`): create a
  job that names Judge Protocol, approve USDC to the escrow contract, fund a job
  whose on-chain state still matches what the policy authorized (the judge, the
  owner, the agreed price), and reclaim its own expired escrow. There is no
  `transfer` to anyone, and no `complete` or `reject`. The only path from the
  owner's money to a contractor is the judge releasing the escrow.
- **Spend limits are enforced in code** (`src/policy.js`): a per-milestone cap, a
  project budget, a judge-fee budget and an attempts limit are hard; above a
  second line a named human must approve first. An approval never lifts a hard cap.
  The payment client has its own fee limit too: it refuses to sign anything but
  the judge's 0.01 USDC price on Arc.
- **It does not guess what "done" means** (`src/drafter.js`): every sentence of the
  acceptance text must become a check, or the milestone goes back to the owner
  with the exact sentences it cannot check ("make it look great" cannot be judged
  deterministically). An ambiguous term or an "A or B" list is refused, not guessed.
- **It reads verdicts from the chain** (`src/paymaster.js`): if the judge's reply ever
  disagrees with the verdict on chain, it stops.
- **Every decision is in a hash-chained log** (`src/ledger.js`), and the log's head is
  written into each job description on chain. `verify-log.js` checks the log
  against the chain; editing, deleting or reordering an entry breaks it.
- **A crash cannot make it pay twice** (`src/paymaster.js`, `src/logfile.js`): it writes
  its intent to the log before money moves, and every run starts by settling any
  attempt left open against the chain (already released, refunded, still in flight or
  never funded) before doing anything new. A log shorter than its last known state is
  refused.
- **It pays the judge only**: the payment client refuses any fee but 0.01 USDC in USDC
  on Arc, to anyone but the judge's published fee address.

## Who gets the work

A contractor's record is what Judge Protocol ruled on chain for them, nothing
self-reported (`src/reputation.js`); jobs a contractor paid for itself (the same
address as client and provider) do not count. Required terms are matched as whole
words, so "Arc" is not satisfied by "Architecture". The best record gets the milestone; one small
milestone per run (at most `trialMaxUSDC`) goes to a newcomer so new contractors
can earn a record. A contractor rejected on a milestone never gets that
milestone again. A contractor who quotes a different price than agreed is not
funded; one who never quotes costs nothing.

## Run it

```bash
cd agent && npm ci
npm test                                           # 57 tests, no network
PAYMASTER_KEY=0x... PROVIDER_KEY=0x... CONTRACTOR_B_KEY=0x... node run.js briefs/demo.json
node approve.js briefs/demo.json review --by "<name>" --note "<why>"
node verify-log.js runs/arc-docs-sprint-demo.jsonl  # no keys needed
```

The paymaster key needs testnet USDC in its wallet for escrows and a Circle
Gateway deposit for judge fees (`GatewayClient.deposit`).

## The recorded demo run (Arc testnet, 2026-09-27)

`runs/arc-docs-sprint-demo.jsonl` is the full log of two runs of `briefs/demo.json`:

| Milestone | What happened | Jobs |
|---|---|---|
| explainer (0.05) | Trial for newcomer birch, judged REJECT, refunded; reassigned to atlas (10 passed, 4 rejected on chain), whose own dry run caught a missing term; revised, PASS, paid | 186764, 186765 |
| invoice (0.05) | atlas; draft failed its dry run (a string total), revision PASS, paid | 186766 |
| review (0.20) | Above the 0.10 approval line: stopped for a human; approved in the log; second run PASS, paid | 186767 |
| landing (0.05) | "Make the landing page look great and feel premium": cannot be checked, sent back | none |

Totals: 0.30 USDC paid, 0.05 refunded, 0.04 in judge fees paid over x402.
Every job can be checked at https://judge-protocol-verifier.vercel.app.

## Honest limits

- Arc testnet only. The two contractors are scripted agents with their own
  wallets; their writing is scripted in the brief. The paymaster is the agent
  under test.
- The drafter is deterministic and deliberately narrow. It understands lengths,
  required terms, JSON fields and types, file checksums and endpoint probes;
  anything else goes back to a human. A language model could widen what it
  understands, but it would only draft: its output would pass the same
  validation, and it would never decide a payment. None is wired in yet.
- The demo approval was recorded by the operator running the demo, and says so.
- Keys are plain testnet keys from the environment. A Circle developer-controlled
  wallet could replace the paymaster's key; it is not wired in.
- A contractor can still pad its record with jobs it pays for from a second wallet;
  records rank contractors, they never replace the judge's check on each milestone.
- The log's truncation guard protects against crashes and bad restores, not against
  someone who can rewrite the agent's files (they could rewrite the brief too).
