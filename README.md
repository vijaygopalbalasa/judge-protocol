# Judge Protocol
### Deterministic Evaluator-as-a-Service for ERC-8183 agent escrow

**A neutral, evidence-backed judgment layer for agent-to-agent work, live on Arc testnet.**

When AI agents hire each other, escrow alone isn't enough: someone must decide *did the
provider deliver what was promised?* ERC-8183 defines an `evaluator` role for exactly this
but ships no evaluator. Judge Protocol is a standalone deterministic evaluator any
ERC-8183 client can name as their job's evaluator. It runs reproducible checkers, publishes
**recomputable** evidence, signs an EIP-712 verdict, and settles escrow on Circle's canonical
ERC-8183 contract: pass → provider paid, fail → client refunded.

> Built on Circle's canonical ERC-8183 deployment on **Arc**. We never fork the escrow
> contract. Every judged job is a real job on the official protocol.

## See it work

A real job posted on Circle's canonical contract, judged, escrow settled, then the verdict
**recomputed from public inputs** and matched against the on-chain record. Unedited capture:

![Judge Protocol demo: a real ERC-8183 job judged on Arc, then independently recomputed](docs/demo.svg)

*(Raw terminal recording: [`docs/demo.cast`](docs/demo.cast), replay with `asciinema play docs/demo.cast`.)*

---

## Live on Arc testnet (chain 5042002) · v1.1

| Contract | Address |
|---|---|
| **JudgeEvaluator** (source-verified ✓) | [`0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD`](https://testnet.arcscan.app/address/0x6EFF7d4BB514d341AbEd90bF4c667d0A980173AD) |
| **JudgeReputationHook** (source-verified ✓) | [`0xfe38bF336148eb3F2E1A5DEE8Ed89AC3B8bcF1c8`](https://testnet.arcscan.app/address/0xfe38bF336148eb3F2E1A5DEE8Ed89AC3B8bcF1c8) |
| Canonical ACP (Circle) | [`0x0747EEf0706327138c69792bF28Cd525089e4583`](https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583) |
| Guardian / owner | `0x427C62eDCae20DDc8c5e875De39D4E4845491458` |

**Real judged jobs on Circle's canonical ERC-8183 contract, with provider-authored deliverables:**
- Job **170857**: PASS → escrow released to provider ([job](https://testnet.arcscan.app/tx/0x13507d31df322c43473de6965b5180db0aff53a0959514f44e9cba047b9f83bd))
- Job **170856**: REJECT (deliverable violated criteria) → client refunded
- Jobs **171507** and **171925**: PASS → escrow released (both re-verifiable in the browser verifier under `web/`)

Every verdict is independently checkable: `node judge-service/src/verify.js <jobId> --evidence <file>`
recomputes the score, decision, and evidence hash from public inputs and asserts they match
the on-chain record.

## How it works

```
Client posts job (evaluator = JudgeEvaluator, criteria in description) ──► Provider delivers
   │                                                              via submit(optParams)
   ▼
Judge service detects JobSubmitted
  1. read the PROVIDER's deliverable from submit calldata
  2. assert keccak256(content) == the on-chain commitment  (never grade substituted content)
  3. validate the acceptance-criteria block  (reject malformed criteria, never score them)
  4. run DETERMINISTIC checkers:  checksum · schema · contains · length · http-endpoint
  5. build the recomputable evidence core, hash it (evidenceHash)
  6. EIP-712-sign the verdict
   │ signed verdict
   ▼
JudgeEvaluator.sol (on-chain)
  · verify signer allowlist                · enforce pass ⇒ score ≥ threshold
  · record immutable verdict               · pass → acp.complete() (escrow → provider)
                                           · fail → acp.reject()   (refund → client)
```

**Key property: recomputable determinism.** The same deliverable + criteria always yield the
same verdict, and `evidenceHash` is a pure function of the reproducible inputs (it excludes
wall-clock timestamps and live-probe output). No LLM in the trust path: an LLM may summarize
evidence for humans, never decide.

## Repository layout

```
contracts/        Foundry project (Solidity 0.8.28, cancun)
  src/JudgeEvaluator.sol        core evaluator: signed verdicts → complete()/reject()
  src/JudgeReputationHook.sol   IACPHook → ERC-8004 feedback + reputation gate
  src/interfaces/               IACP, IACPHook, IReputationRegistry
  src/mocks/                    MockACP (faithful to Circle's reference), MockUSDC
  test/                         27 Foundry tests (evaluator + hook + attack paths)
  script/Deploy.s.sol           Arc testnet deploy
  broadcast/                    deploy receipts (public audit trail)
judge-service/    Node/viem off-chain engine
  src/checkers/                 5 deterministic checkers + validateCriteria() gate
  src/criteria.js               criteria parse + canonical hash
  src/evidence.js               deliverable resolve + recomputable evidence
  src/safe-fetch.js             SSRF-hardened fetch (denylist + timeout + size cap)
  src/signer.js                 EIP-712 signing + on-chain submit
  src/engine.js                 watcher + evaluation pipeline
  src/verify.js                 independent verdict recomputation CLI
  src/measure-acp.js            on-chain ERC-8183 market measurement
  test/                         31 unit tests (checker gate, SSRF, evidence determinism)
  evidence/                     recomputable verdict evidence (public audit trail)
```

## Status

- ✅ **27/27 contract tests** (`cd contracts && forge test`): full lifecycle, both settlement
  paths, and attack paths: bad signer, double-resolution, pause, criteria mismatch, stale
  verdict, threshold enforcement, criteria-registration gating, withdraw auth, and the full
  hook feedback flow (7 hook tests; the hook decode bug that these now cover was previously
  untested).
- ✅ **31/31 service unit tests** (`cd judge-service && npm test`): the four escrow-steering
  criteria defects, SSRF denylist, and evidence-hash determinism.
- ✅ **Live end-to-end on Arc testnet**: provider-authored PASS and REJECT jobs on the
  canonical contract, verdicts independently recomputed and matched on-chain.

## Quick start

```bash
# contracts
cd contracts && git submodule update --init --recursive && forge test   # 27/27

# service
cd ../judge-service && npm install && npm test                          # 31/31

# run the judge against Arc testnet (needs a funded .env, see .env.example)
node --env-file=.env src/index.js

# prove it end-to-end (posts a real job on the canonical ACP and settles it)
node --env-file=.env src/e2e.js            # PASS path
node --env-file=.env src/e2e.js --reject   # REJECT path

# independently verify any settled job
node --env-file=.env src/verify.js <jobId> --evidence evidence/job-<jobId>-<hash>.json
```

## HTTP API

`npm start` runs the watcher **and** a local integration API (loopback-only by default,
`HTTP_HOST`/`HTTP_PORT` to change). `npm run api` runs the API standalone; the read
endpoints and dry-run evaluation need no keys.

| Endpoint | What it returns |
|---|---|
| `GET /healthz` | liveness + watcher state (persisted block cursor, last poll, last error) |
| `GET /verdict/:jobId` | the on-chain verdict from `JudgeEvaluator.getVerdict` (404 if none) |
| `GET /evidence/:jobId` | the stored evidence JSON whose hash the verdict commits to |
| `POST /evaluate` | **dry run**: `{criteria, deliverable\|deliverableBase64}` → the exact `score`/`pass`/`evidenceHash` a real run would produce. Nothing is signed or settled. |

The watcher persists its block cursor (`state/cursor.json`), so jobs submitted while the
service is down are still picked up on restart; catch-up scans run in bounded block-range
chunks to stay inside RPC limits.

## Security model

- **No custody.** Judge only attests; the canonical ACP contract escrows and disburses. A
  compromised signer key can submit a *wrong verdict*, caught by evidence recomputation
  (`verify`), guardian pause, and signer-allowlist revocation.
- **Grades only provider-authored, hash-committed content.** The service aborts unless the
  resolved deliverable hashes to the provider's on-chain commitment.
- **Non-upgradeable** (the spec warns evaluators must not change behavior mid-job). A new
  version deploys a new address; clients opt in.
- **Liveness is the protocol's, not the judge's.** `claimRefund` after `expiredAt` is the
  backstop; judge downtime can never lock funds. Liveness is best-effort, stated honestly.
- All outbound fetches pass an SSRF denylist + timeout + size cap. Reentrancy-guarded,
  SafeERC20, checks-effects-interactions throughout.

## Known limits (honest scope)

- Deterministic checkers cover **objective/structured** deliverables (schema, checksum,
  text presence/length, HTTP). Subjective quality is out of scope for the trust path; the
  intended path for contested/subjective work is escalation to a dispute layer (e.g. UMA /
  GenLayer Internet Court), not an LLM in the settlement path.
- The ERC-8004 reputation hook is implemented and tested but **not yet attachable** on the
  canonical ACP: hooks other than `address(0)` are not whitelisted there yet.
- Per-evaluation fees are charged **out of band**: the canonical ACP exposes no per-job fee
  surface (`evaluatorFeeBP` is a single global rate only Circle can set). `withdraw()` is a
  rescue hatch, not the pricing mechanism.

## License
MIT
