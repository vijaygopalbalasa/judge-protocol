# Judge on BNB Chain's ERC-8183 kernel

BNB Chain's [bnbagent-sdk](https://github.com/bnb-chain/bnbagent-sdk) ships an ERC-8183 kernel
(`AgenticCommerceUpgradeable`, BSC mainnet proxy `0xea4daa3100a767e86fded867729ae7446476eba6`, testnet proxy
`0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de`) that settles jobs through an **EvaluatorRouter**: the router is the
job's evaluator and hook, forwards each kernel action to the job's **policy**, and on `settle(jobId, evidence)` asks
the policy `check(jobId, evidence)` for a verdict and applies it to the kernel. The SDK's reference policy,
`OptimisticPolicy`, ignores the evidence and decides on time and votes alone: silence past the dispute window
approves.

`contracts/src/bnb/` puts a Judge Protocol verdict in that slot instead, on top of the official kernel, unchanged:

- **`JudgeDeterministicPolicy`** decides from a signed Judge verdict. The bytes passed as `evidence` are
  `abi.encode(Verdict, bytes signature)`: the same EIP-712 `Verdict` struct `JudgeEvaluator` accepts on Arc
  (`jobId, criteriaHash, deliverable, score, threshold, pass, evidenceHash, timestamp`), signed by an allowlisted
  judge key under the policy's own EIP-712 domain (`JudgeDeterministicPolicy`, version `1`, chain 56 or 97). Anyone may
  relay it: the signature, not the caller, is what the policy trusts. `pass` settles the job as completed (escrow to
  the provider, minus the kernel's fee); `!pass` settles it as rejected (refund to the client).
- **`JudgeRouter`** is a minimal router of our own, with the public surface the SDK reads (`registerJob`, `settle`,
  `jobPolicy`, `policyWhitelist`, `markExpired`) and the same error names. BNB's own router whitelists policies by
  its owner only, so a deterministic policy needs a router it can be whitelisted on. An SDK user points at ours with
  two environment variables and nothing else changes:

  ```
  ERC8183_ROUTER_ADDRESS=<JudgeRouter>
  ERC8183_POLICY_ADDRESS=<JudgeDeterministicPolicy>
  ```

## What settles a job, and what never does

`check` answers `APPROVE` or `REJECT` only when the evidence carries a verdict that is signed by an allowlisted key,
names this job, matches the deliverable hash the kernel recorded at submission (the router tells the policy on the
kernel's submit hook), is consistent (`pass` implies `score >= threshold`), is not older than one day, is not dated
ahead of the chain's clock, is not dated before the submission, and, when criteria were registered for the job,
carries that `criteriaHash`. Everything else answers `PENDING`, the router reverts `NotDecided`, and the job is
untouched. Evidence that does not even decode reverts the same way. While the guardian has the policy paused, every
check answers `PENDING`.

The kernel's `claimRefund` after expiry is not touched by any of this, so the judge can never lock funds: a job
nobody settles refunds its client on expiry, exactly as it would under the reference policy.

`registerCriteria(jobId, criteriaHash)` is the same optional commitment `JudgeEvaluator.registerCriteria` offers on
Arc: a judge signer or the owner binds the acceptance criteria to a job before the provider submits (write-once, only
while the job is Open or Funded, only for a job the router bound to this policy, refused while paused). The criteria
are also committed in the immutable job description, so this is explicit, not required.

## Roles

| Who | Can |
|---|---|
| judge signer | sign verdicts; register criteria |
| owner (Ownable2Step, renounce disabled) | add or remove signers; set the guardian; register criteria |
| guardian | pause and unpause the policy (pause only stops settlement; refunds are the kernel's) |
| router owner | whitelist policies |
| client | bind a whitelisted policy to its own job before funding (`registerJob`) |
| anyone | relay a signed verdict (`settle`), `markExpired` after the kernel expired a job |

A compromised signer key can settle any submitted job either way until the owner removes it or the guardian pauses.
It cannot move funds anywhere other than to the job's provider or back to its client, cannot settle an unsubmitted
job, and cannot settle a job twice.

## Deploy

```bash
cd contracts
export BNB_CHAIN_ID=97 BNB_COMMERCE=0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de \
       BNB_OWNER=<broadcasting wallet> BNB_GUARDIAN=<pause key> BNB_SIGNER=<verdict key>
forge script script/DeployBnb.s.sol --rpc-url $RPC                                      # simulate
forge script script/DeployBnb.s.sol --rpc-url $RPC --broadcast --private-key $DEPLOYER_KEY
```

The script refuses any chain other than 56 or 97, checks that `BNB_COMMERCE` has BNB's 11 field `Job` layout
(`getJob(1)` puts the description offset at `0x160`; Circle's 9 field layout puts it at `0x120`), deploys the router
and the policy, whitelists the policy, and reads every role back before it prints the addresses.

## Tests

- `test/JudgeDeterministicPolicy.t.sol`: 31 tests against `MockBnbCommerce`, a mock of the kernel with BNB's Job
  layout, status gates, hook encodings and revert bubbling; includes a fuzz test that arbitrary evidence never settles
  a job. 26 planted bugs were each caught by a failing test.
- `test/JudgeOnBnbKernelFork.t.sol`: 6 tests that drive the router and policy with the **real** kernel on BSC testnet
  on a local fork (the kernel's ERC-165 check on the hook, its hook encodings, its auth and status gates, its token
  transfers). Nothing is sent to the chain. Runs only with `BSC_TESTNET_RPC` set, and is reported as skipped
  otherwise:

  ```bash
  BSC_TESTNET_RPC=https://data-seed-prebsc-1-s1.bnbchain.org:8545 forge test --match-contract JudgeOnBnbKernelFork -vv
  ```

## Limits, stated plainly

- Not deployed on BSC testnet or mainnet yet, and no BNB user has run a job through it.
- Tested against the real kernel on a fork, not yet through bnbagent-sdk's own client code end to end.
- The SDK's `getDeliverableUrl` helper scans for the reference policy's `JobInitialised` log; this policy emits
  `SubmissionRecorded(jobId, deliverable)` instead, and the deliverable URL stays in the kernel's submit `optParams`.
- The judge service does not yet sign BNB verdicts: the policy's EIP-712 domain differs from JudgeEvaluator's, and
  BNB's deliverable commitment is the keccak256 of the SDK's canonical manifest JSON, so the service needs an adapter
  (fetch the manifest from `optParams.deliverable_url`, recompute its hash against the kernel's `deliverable`, grade
  `response.content` against the criteria block in the job description, sign under the policy's domain).
