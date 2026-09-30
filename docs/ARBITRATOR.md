# JudgeArbitrator: Judge rulings for ArcBounty disputes

`contracts/src/JudgeArbitrator.sol` holds the arbitrator role on one ArcBounty `BountyAdapter` and settles a
dispute only with a ruling that an allowlisted Judge signer signed for that exact bounty. It never judges. It
checks that the payout it asks for matches a signed ruling, then calls the adapter's own
`resolveDispute(jobId, payProvider, ipfsRulingHash, reputationPenalty)`. ArcBounty keeps control of the role at
all times.

Status: built and tested against a copy of ArcBounty's real adapter; not deployed anywhere yet. Testnet first.

## What a ruling is bound to

A ruling is EIP-712 typed data:

- domain: name `JudgeArbitrator`, version `1`, the chain id, and the JudgeArbitrator address as
  `verifyingContract`
- `Ruling(address adapter,uint256 jobId,bytes32 submissionHash,bytes32 descriptionHash,bool payProvider,string rulingCid,uint8 reputationPenalty,uint64 issuedAt)`

`resolve(ruling, signature)` applies it only when all of these hold:

- the signer is an active Judge signer (see "Signers" below), and the signature is well formed and low-s
- `adapter` is the one adapter this contract serves, on this chain
- the bounty exists, is in dispute and is not resolved
- `submissionHash` is keccak256 of the bounty's `submittedResultHash` and `descriptionHash` is keccak256 of its
  `ipfsDescHash`, both read from the adapter at call time, so a ruling made for other files cannot be used
- `rulingCid` is 1 to 96 characters (the adapter's own `MAX_CID_LEN`), `reputationPenalty` is at most 100
- `issuedAt` is not in the future and at most one day old
- the contract is not paused and ArcBounty has not started taking the role back

Anyone may relay a signed ruling: the signature is the authority, not the caller. A bounty can be in dispute
only once in BountyAdapter V4.7 (every exit from a dispute also sets `resolved`), so a ruling cannot be replayed.

## Handing the role over (testnet first)

1. Judge deploys `JudgeArbitrator(adapter, principal, signers)`, where `principal` is the address that holds the
   adapter's arbitrator role today (ArcBounty's Safe on mainnet) and `signers` are Judge's ruling keys.
2. ArcBounty's current arbitrator calls `adapter.transferArbitrator(<JudgeArbitrator>)`.
3. ArcBounty (the principal) or Judge (the owner) calls `JudgeArbitrator.acceptRole()`, which completes the
   adapter's two-step handover.
4. Check that `adapter.arbitrator()` now returns the JudgeArbitrator address.

## Settling a dispute

1. A poster or worker raises a dispute on the adapter (`disputeBounty`, or `challengeRejection` after a
   rejection).
2. Judge rules from chain data plus the two IPFS files, recomputing every link:
   `node judge-service/src/arcbounty.js <jobId> --network arc-mainnet` (or `--network arc-testnet` for the testnet
   adapter ArcBounty named for the first run, `0xeDf2c738915b042da97788b2b5499D4655FB1f20`). A pass becomes
   `payProvider = true`, a reject `payProvider = false`.
3. The ruling record is published and its IPFS link becomes `rulingCid`; the adapter stores it as the bounty's
   `disputeRulingHash`.
4. A Judge signer signs the `Ruling`. Set `issuedAt` from the latest block's timestamp rather than the wall
   clock (Arc testnet's clock has been seen running ahead). `rulingDigest(ruling)` returns the digest to sign.
5. Anyone sends `resolve(ruling, signature)`. The adapter pays the worker (less ArcBounty's fee) or refunds the
   poster, exactly as its own `resolveDispute` does.

The adapter's liveness paths never depend on this contract: `claimDefaultRuling` (no response within 48 hours)
and `claimArbitratorTimeout` (30 days) stay open whether JudgeArbitrator is paused, handing back, or silent.

## Disputes Judge does not rule on

Judge rules only on bounties whose description carries a Judge criteria block. Any other dispute (no criteria, or a
subjective question) is settled by ArcBounty itself through the contract: the principal calls
`resolveAsPrincipal(jobId, payProvider, rulingCid, reputationPenalty)`. It needs no Judge signature, has the same
bounds as a signed ruling (a CID of 1 to 96 characters, a penalty of at most 100, a bounty in dispute), and works
while the contract is paused or the role is on its way back. It gives the principal nothing it did not already have
through `handBack`; it only saves moving the role twice.

## Signing and relaying a ruling

`node judge-service/src/arbitrate.js <jobId> --network arc-testnet --arbitrator <address> --cid <Qm...> [--relay]`
signs a `Ruling` with `ARBITRATOR_SIGNER_KEY` (and, with `--relay`, sends `resolve` from `ARBITRATOR_RELAYER_KEY`).
It signs only when all of this holds, read fresh from the chain: Judge rules on the bounty now (an abstention means no
signature), the bounty is in dispute and unresolved, the pinned record at the CID is exactly this ruling (same
`rulingHash`, bytes checked against the CID), JudgeArbitrator serves this adapter, holds its arbitrator role, is
neither paused nor handing the role back, and trusts the signer, and the deployed contract's `rulingDigest` equals
the digest computed locally. The penalty is always 0 and `issuedAt` is the chain head's timestamp. Keys are read from
the environment and never printed.

## Deployed on Arc testnet (2026-09-30)

| | Address |
|---|---|
| JudgeArbitrator ([Sourcify exact match](https://repo.sourcify.dev/5042002/0xb810FEFDDE482f908e01F84c5c3645A7036816F2)) | `0xb810FEFDDE482f908e01F84c5c3645A7036816F2` |
| ArcBounty BountyAdapter V4.7 (the testnet adapter ArcBounty named) | `0xeDf2c738915b042da97788b2b5499D4655FB1f20` |
| Principal (the adapter's arbitrator: ArcBounty's testnet key) | `0xde427f3967cc7a0BF7A9F891195760cCffC82edA` |
| Judge signer | `0xaaa287033E603ec6a6056F1882086B93F9ee0FB0` |
| Owner | `0xf629006403580E2A7d94B666daA8374353a1d368` |

It holds no role until ArcBounty hands it over: `transferArbitrator(0xb810...)` on the adapter, then `acceptRole()`.
Deployed with `contracts/script/DeployArbitrator.s.sol`, which refuses to deploy unless the principal is the
adapter's arbitrator and the adapter's CID bound is 96, and reads every role back.

## Taking the role back

The principal calls `handBack(next)`. Rulings through JudgeArbitrator stop at once, the adapter records `next`
as its pending arbitrator, and `next` calls `adapter.acceptArbitrator()`. This works while paused. The owner can
neither hand the role back nor undo a hand-back.

## Signers and pause

- `addSigner(key)`: owner only. The key's rulings count only after `SIGNER_DELAY` (2 days), so the principal
  sees the `SignerAdded` event and can take the role back first.
- `removeSigner(key)`: owner only, immediate.
- `setPaused(bool)`: owner only; blocks `resolve` and nothing else.
- Ownership moves in two steps (`Ownable2Step`); renouncing is disabled so a signer can always be removed.

## Honest limits

- Testnet first. Not deployed, and no third-party audit: 41 unit tests run against a copy of ArcBounty's real
  adapter, two fork tests read their live Arc testnet adapter, and deliberate mutations of the guards were each
  caught by a test.
- Trust sits in the signer set. The payout follows whatever an active Judge signer signs, and Judge's owner
  controls that set, with the 2-day delay on additions as ArcBounty's warning. A leaked signer key can settle any
  open dispute until the owner removes the key or pauses, or ArcBounty takes the role back; treat a leak as a full
  compromise.
- Judge rules on objective, checkable criteria written into the bounty. A subjective dispute, or one on a bounty
  without criteria, belongs with a human: ArcBounty settles it with `resolveAsPrincipal`, or takes the role back.
- Publishing the ruling record is manual: pin the JSON that `arcbounty.js` prints (CIDv0), send ArcBounty the CID
  and a gateway link, then sign. `arbitrate.js` checks the pinned record against the fresh ruling before signing.

## Tests

- `forge test --match-contract JudgeArbitratorTest`: every guard above, against ArcBounty's `BountyAdapter`
  (vendored for tests only under `contracts/test/vendor/arcbounty`, MIT, pinned to their commit
  `ef5d100882a4bfe475c685586902ecc72da420e8`, pragma relaxed to this repo's solc; that folder alone compiles with
  via-IR, as it does in their repo).
- `ARC_TESTNET_RPC=https://rpc.testnet.arc.network forge test --match-contract ArcBountyTestnetFork -vv`: reads a
  live bounty from their Arc testnet adapter through `IBountyAdapter` and runs the handover and hand-back on a
  fork. Skipped without the variable.
