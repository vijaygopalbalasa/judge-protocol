# Judge Protocol: Architecture
**Deterministic Evaluator-as-a-Service for ERC-8183 agent escrow · Arc**

## Mission
Be the neutral judgment layer between agent Clients and Providers: given a job's acceptance criteria and a submitted deliverable, produce a **deterministic, evidence-backed, signed verdict** that releases or refunds escrow, with an auditable trail and a reputation feed into ERC-8004.

## Design principles (from research)
1. **Build on Circle's canonical ACP deployment, never fork it.** Every judged job is a real job on the official contract: credibility + composability.
2. **The evaluator is a contract, not an EOA.** The reference ACP pays `evaluatorFeeBP` to the `evaluator` address; only a contract can hold policy, an on-chain evidence log, and a guardian override.
3. **Deterministic first, AI never in the trust path.** A verdict must be reproducible from recorded inputs. LLMs may *summarize* evidence but never *decide*.
4. **Chain-agnostic core.** Arc is the beachhead; the judge service and interfaces assume nothing Arc-specific except USDC decimals and RPC config.
5. **Downgrade, never halt.** `claimRefund` after `expiredAt` is the guaranteed recovery; judge downtime must never lock funds.

## System layers
```
┌─────────────────────────────────────────────────────────────┐
│ OFF-CHAIN: Judge Service (Node, viem)                        │
│  watch JobSubmitted → resolve PROVIDER deliverable (from      │
│  submit optParams) → assert keccak256(content)==commitment →  │
│  run checkers → structured verdict → store evidence →         │
│  EIP-712 sign → call JudgeEvaluator.submitVerdict            │
│  Checkers (implemented): schema · json · checksum ·          │
│            contains · length · http-endpoint                 │
│  Safety: validateCriteria() gate · SSRF denylist on all      │
│          outbound fetches · min-budget spam guard            │
└──────────────┬──────────────────────────────────────────────┘
               │ signed verdict (EIP-712)
┌──────────────▼──────────────────────────────────────────────┐
│ ON-CHAIN (Arc testnet, chain 5042002)                        │
│  JudgeEvaluator.sol  - set as job `evaluator` on ACP         │
│    · signer allowlist (attestation keys)                     │
│    · per-job criteria commitment (registerCriteria: signer-  │
│      only, write-once, only while Open/Funded)               │
│    · verdict enforces pass ⇒ score ≥ threshold               │
│    · complete()/reject() into ACP (reason = evidenceHash)    │
│    · immutable verdict log · guardian pause · withdraw()      │
│      (ERC-20 rescue; NOT the fee mechanism - ACP has none)   │
│  JudgeReputationHookV2.sol - IACPHook (ERC-8004 feedback)    │
│    · afterAction(fund): attributes the job to the provider's │
│      linked agent (judge-graded, client != provider)         │
│    · afterAction(complete/reject): the judge's own verdict   │
│      on an attributed job, counted in the hook's tally and   │
│      written to the ReputationRegistry as deployed (v2.0.0): │
│      PASS 100, REJECT 0, feedbackHash = evidenceHash         │
│    · a registry failure never reverses a payout; too little  │
│      gas for the record reverts the relay instead            │
│    · no owner; supersedes JudgeReputationHook (an earlier    │
│      ERC-8004 draft ABI it can no longer write to)           │
│      NOTE: hooks are not yet whitelisted on the canonical    │
│      ACP, so this path is not attachable there today         │
│  Circle ACP (canonical): 0x0747EEf0...089e4583  (testnet)    │
└─────────────────────────────────────────────────────────────┘
```

## Data model
- **AcceptanceCriteria** (in the immutable job description, hashed as `criteriaHash`): `version`, `jobType`, ordered `checks[]` (each `{kind, params, weight}`), `passThreshold`. Validated by `validateCriteria()` before any scoring.
- **Verdict** (EIP-712-signed, recorded on-chain): `jobId`, `criteriaHash`, `deliverable`, `score`, `threshold`, `pass`, `evidenceHash`, `timestamp`.
- **evidenceHash** = keccak256 of the canonical *recomputable core*: jobId (as a string), criteriaHash, deliverable, criteria, checks (ordered `{kind, pass, weight}`), score, threshold, pass. It excludes wall-clock timestamps and live-probe output, so a third party can recompute it from public inputs; `node judge-service/src/verify.js <jobId>` (which shares its code with the in-browser verifier) does exactly this and asserts equality with the on-chain value. An `http-endpoint` check is a live network probe: its recorded pass bit is inside the core, so verifiers confirm everything else and report what the judge recorded, but cannot re-run the probe as the judge saw it.

## Security model
- Judge service holds **no custody**: it can only submit verdicts to `JudgeEvaluator`, which alone calls ACP. A compromised signer key can submit a *wrong verdict*, caught by: (a) evidence recomputation (`node judge-service/src/verify.js`), (b) guardian pause, (c) on-chain signer allowlist revocation.
- `JudgeEvaluator` is **non-upgradeable** (the spec warns against mid-job behavior change); a new version deploys a new address and clients opt in.
- The judge only grades **provider-authored** content, bound to the on-chain commitment: it aborts unless `keccak256(deliverable) == submitted bytes32`.
- All outbound fetches (deliverable resolution + http-endpoint checker) pass through an SSRF denylist (private/loopback/link-local/metadata ranges), a timeout, and a size cap.
- Reentrancy: all state-changing paths `nonReentrant`; SafeERC20 for token movement; CEI ordering.
- **Criteria registration** (`registerCriteria`) is the judge's own consistency check, not a promise the
  client can enforce: only a signer or the owner can call it, write-once, only while the job is Open or
  Funded, only for a job naming this judge, and never while paused. The client's commitment is the
  criteria block in the job's immutable description. The owner can clear a registration
  (`clearCriteria`, emits `CriteriaCleared`) to recover from criteria a leaked key bound before the pause.
- **Ownership** moves in two steps (`Ownable2Step`: the new owner must accept), and `renounceOwnership`
  is disabled, so the signer set can always be rotated. Both, and the two registration limits above,
  came from a pre-deployment security review on 2026-09-28 (one medium, two low findings, all fixed with
  tests before the mainnet deployment). The Arc testnet contract was deployed on 2026-08-07 from the
  earlier version; only new deployments carry these changes.

## Latency / liveness
The hosted judge (https://judge-protocol-api.vercel.app) rules on demand: `POST /api/judge` settles a Submitted job within one function invocation, and a daily cron sweep over about the last 58 hours of blocks is the safety net. Liveness is **best-effort, not guaranteed** (no uptime SLA): if the judge does not rule, `claimRefund` after `expiredAt` is the protocol-level backstop; judge downtime can never lock funds. (A managed-hosting / alerting story is deliberately out of scope for this version.)

## What v1 is NOT
- Not a dispute/arbitration court (escalation to UMA/Internet Court is Act 2)
- Not an LLM judge (subjective rubric scoring is Act 2, layered *above* deterministic checks)
- Not cross-chain yet (interfaces are chain-agnostic; deployment is Arc-first)
