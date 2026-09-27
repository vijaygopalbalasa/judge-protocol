---
name: judge-protocol
description: Use when an agent pays another agent or a person for work on Arc (ERC-8183 escrow) and payment should be released only when the delivery provably meets criteria written down in advance. Covers turning a brief into deterministic acceptance criteria, creating a judged job on Circle's ERC-8183 contract, submitting deliverables, getting an on-chain ruling from Judge Protocol, and checking any ruling independently.
---

# Judge Protocol

A neutral, deterministic evaluator for ERC-8183 jobs on Arc testnet. The client
commits acceptance criteria in the job; the provider commits a deliverable; the
judge rules and settles the escrow (PASS pays the provider, REJECT refunds the
client). Every ruling is recomputable from public chain data.

- ACP (Circle's ERC-8183): `0x0747EEf0706327138c69792bF28Cd525089e4583`
- JudgeEvaluator (name it as the evaluator): `0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD`
- Hosted API: `https://judge-protocol-api.vercel.app`
- Kit: `kit/judge-kit.js` in github.com/vijaygopalbalasa/judge-protocol (depends on viem)
- Criteria reference: `docs/CRITERIA.md`; integration guide: `docs/INTEGRATION.md`

## When to use it

- The work has an objective definition of done: length, required terms, a JSON
  shape, an exact file (checksum), an endpoint that must answer.
- Not for subjective work (tone, design taste). Say so and keep a human in the loop.

## Workflow

1. **Turn the brief into criteria.** Map each requirement to a check kind
   (`length`, `contains`, `schema`, `checksum`, `http-endpoint`). List anything
   that cannot be checked mechanically and tell the user it is not covered.
   Validate before use with `validateCriteria(criteria)`. Example:

   ```json
   {"version":1,"passThreshold":100,"checks":[{"kind":"length","params":{"min":50,"max":300}},{"kind":"contains","params":{"all":["invoice","USDC"]}}]}
   ```

2. **Dry run the criteria** against a sample with `dryRun({ criteria, content })`
   (or `POST /api/evaluate`). It never signs or settles.
3. **Client:** `createJudgedJob({ walletClient, publicClient, provider, criteria, title })`,
   then after the provider's `setBudget`, `fundJob({ walletClient, publicClient, jobId, amount })`.
4. **Provider:** `setBudget({ ... jobId, amount })`, do the work, optionally `dryRun`
   it, then `submitDeliverable({ walletClient, publicClient, jobId, content })`.
5. **Rule:** `requestRuling({ jobId, submitTx })`, then `waitForRuling({ jobId })`.
6. **Report honestly:** give the user the job id, PASS or REJECT, the score, and the
   verifier link `https://judge-protocol-verifier.vercel.app`.

## Rules

- Never claim a ruling is verified unless the verifier page or
  `node judge-service/src/verify.js <jobId>` says VERIFIED for that job.
- Arc testnet only; never move mainnet funds with this skill.
- If the judge answers `abstained`, report its `reason` and fix the job; do not retry blindly.
- `retry-later` and `error` mean try again later; `not-ours` means the job names a different evaluator.
