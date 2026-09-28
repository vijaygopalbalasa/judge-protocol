# RVR Judge Protocol checker derivation profile v0

Status: experimental external profile, for review.

## 1. Authority and scope

This file is the complete verification specification for profile
`judge-protocol-rvr-v0`. Its exact bytes are committed by the Verification
Profile. The Judge Protocol service, its verifier, and this package's adapter
are implementations; none of them is authoritative.

The profile covers rulings of the Judge Protocol evaluator on Circle's ERC-8183
contract on Arc testnet:

```text
chain:                eip155:5042002
ERC-8183 contract:    0x0747eef0706327138c69792bf28cd525089e4583
JudgeEvaluator:       0x6eff7d4bb514d341abed90bf4c667d0a980173ad
```

v0 covers exactly the four deterministic check kinds `length`, `contains`,
`schema` and `checksum`. A criteria set that includes `http-endpoint` is outside
v0 and is a gate rejection: the judge records a live probe's result, and a
recorded probe result is not a reproduced probe. A later profile may cover
probes if their response evidence is committed strongly enough to replay them.

## 2. Proposition and boundaries

The proposition identifier is:

```text
rvr.judge-protocol.v0.deliverable_meets_criteria
```

For `VERIFIED` it means:

> Under `judge-protocol-checkers-v1`, the deliverable bytes the provider
> committed to on the ERC-8183 job meet the job's acceptance criteria: the
> weighted score is at or above the pass threshold.

`REFUTED` means the committed deliverable does not meet them (the score is below
the threshold). `UNVERIFIABLE` means the evidence descriptor commits a required
member as `UNAVAILABLE` (section 6).

Boundaries, each recorded in the canonical result:

- `SNAPSHOT_BOUND_CANONICALITY_NOT_ESTABLISHED`: every chain fact comes from the
  committed chain snapshot. This profile never reads a chain or RPC endpoint and
  does not establish that the snapshot's block is canonical, final, or that the
  snapshot matches the chain. Checking the snapshot against the chain is a
  separate step outside this profile.
- `RECORDED_NOT_REDERIVED`: the verdict `timestamp` (the signing time) cannot be
  re-derived; it is carried as recorded data only.
- The on-chain verdict is not the outcome. The outcome is the derivation. The
  result reports whether the recorded verdict agrees with the derivation
  (`verdictAgreement`), so a recorded verdict that disagrees is visible rather
  than trusted.
- The profile does not verify the verdict's EIP-712 signature or the relay
  transaction; it does not establish who signed the verdict.

## 3. Byte contracts

Identity-bearing RVR objects (claim, evidence set, canonical result, receipt)
and the chain snapshot use `rvr-canonical-json-v0` exactly as defined by
ERC-8404. JSON numbers never occur in them; quantities are canonical unsigned
decimal strings; addresses and 32-byte values are lowercase `0x`-prefixed hex.

The Judge commits to keccak256 digests of a different byte encoding, which this
profile names `judge-protocol-sorted-json-v1`. It is the UTF-8 encoding of the
string produced by ECMAScript `JSON.stringify` applied to the value after every
object has been rebuilt with its keys inserted in ascending UTF-16 code unit
order. Because ECMAScript emits array-index keys first, the resulting key order
within each object is:

1. keys that are array indices (the decimal string of an integer `n` with
   `0 <= n < 2^32 - 1`, no sign and no leading zero except `0` itself), in
   ascending numeric order; then
2. all other keys in ascending UTF-16 code unit order.

Arrays keep their order. Strings use the ERC-8404 string escaping (which equals
ECMAScript `QuoteJSONString` for Unicode scalar-value strings). Numbers are
integers (section 5.2) and print as their decimal digits with a leading `-` when
negative; `-0` prints as `0`. `true`, `false` and `null` print literally. There
is no whitespace.

```text
criteriaHash = keccak256(judge-protocol-sorted-json-v1(criteria))
evidenceHash = keccak256(judge-protocol-sorted-json-v1(evidenceCore))
```

`keccak256` is Ethereum's Keccak-256 (Keccak-f[1600], rate 136 bytes, padding
`0x01 ... 0x80`), output as lowercase `0x`-prefixed hex.

## 4. Claim

The claim is exactly:

```text
schema                 rvr.claim.judge-protocol.v0
proposition            rvr.judge-protocol.v0.deliverable_meets_criteria
chainId                5042002
acp                    0x0747eef0706327138c69792bf28cd525089e4583
evaluator              0x6eff7d4bb514d341abed90bf4c667d0a980173ad
jobId                  the ERC-8183 job id (decimal string)
criteriaHash           keccak256 of the job's criteria (section 3)
deliverableCommitment  the bytes32 the provider submitted to the ERC-8183 job
snapshotMember         chain-snapshot
deliverableMember      deliverable
checkerContract        judge-protocol-checkers-v1
judgeByteContract      judge-protocol-sorted-json-v1
```

## 5. Evidence closure

The evidence set has exactly two members, sorted by `id`:

- `chain-snapshot`: `application/json; profile=rvr-canonical-json-v0`, the exact
  canonical bytes of a chain snapshot matching `#/$defs/chainSnapshot`;
- `deliverable`: `application/octet-stream`, the exact deliverable bytes whose
  keccak256 is the provider's commitment.

### 5.1 Chain snapshot

The snapshot freezes, at one named block (`readAt.blockNumber`,
`readAt.blockHash`), everything outcome-relevant that lives on chain:

- `job`: the ERC-8183 job fields, including `evaluator` and the exact
  `description` string that carries the criteria;
- `submission`: the provider's `JobSubmitted` event: transaction, block, block
  hash, provider, and the `deliverable` commitment;
- `verdict`: the JudgeEvaluator verdict for the job, all eight EIP-712 fields,
  plus the transaction and block of its `VerdictSubmitted` event when known, or
  `null` when no verdict existed at `readAt`.

The payload MUST be exactly `rvr-canonical-json-v0(snapshot)`; an alternate
spelling of the same JSON is a gate rejection.

### 5.2 Criteria

1. **Extraction.** The criteria text is the first capture of the ECMAScript
   regular expression ``/```judge-criteria\s*([\s\S]*?)```/`` applied to
   `job.description`, where `\s` is ECMAScript WhiteSpace and LineTerminator:
   U+0009, U+000A, U+000B, U+000C, U+000D, U+0020, U+00A0, U+1680, U+2000 to
   U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. No match is a gate
   rejection.
2. **Parsing.** The text is parsed as ECMAScript `JSON.parse` does (RFC 8259
   grammar; a duplicate key keeps its last value; no `NaN` or `Infinity`
   literals). Text that does not parse is a gate rejection.
3. **v0 scope.** Every number, read as an IEEE-754 double as ECMAScript does,
   MUST be an integer with absolute value at most 2^53 - 1, and every string MUST
   consist of Unicode scalar values. Otherwise the criteria are outside v0 (gate
   rejection). So `1.0` and `1e2` are the integers 1 and 100, and `0.5` is out
   of scope.
4. **Validation.** The criteria MUST pass the Judge's validation, or they are a
   gate rejection: an object nesting at most 12 levels; `checks` a non-empty
   array of at most 64 objects; `passThreshold` absent or an integer from 0 to
   100; each check has only the fields `kind`, `params` and `weight`; `kind` is a
   known kind; `weight`, if present, is a number greater than 0 and at most 1000;
   `params`, if present and not null, is an object whose members are the kind's
   known parameters with valid values:
   - `length`: `min`, `max` numbers at least 0 with `min <= max`; `unit` is
     `chars` or `words`;
   - `contains`: `all` a list of at most 256 strings of at most 1024 UTF-16 code
     units; `wholeWords` a boolean;
   - `schema`: `required` a list like `all`; `types` an object of at most 256
     members whose values are `string`, `number`, `boolean` or `object`;
   - `checksum`: `sha256` exactly 64 hexadecimal characters (required);
   - `http-endpoint`: validated as the Judge does, then outside v0.

   A parameter whose value is `null` is treated as absent.
5. **Scope.** Any check of kind `http-endpoint` makes the criteria outside v0.

### 5.3 The four checks (`judge-protocol-checkers-v1`)

Text checks read the deliverable as UTF-8. v0 requires valid UTF-8 when any
check other than `checksum` is present; otherwise it is a gate rejection. No
byte order mark is removed.

- **`length`**: with `unit = chars`, `n` is the number of UTF-16 code units of
  the text (a character outside the Basic Multilingual Plane counts 2);
  otherwise `n` is the number of words, a word being a maximal run of characters
  outside the whitespace set of 5.2 item 1. The check passes when
  `min <= n <= max`, with `min` defaulting to 0 and `max` to infinity.
- **`contains`**: every term of `all` (default empty) occurs in the text as a
  substring. With `wholeWords = true`, each term must have an occurrence whose
  neighbouring characters, where present, are neither `_` nor of Unicode
  General_Category Letter (L*) or Number (N*).
- **`schema`**: the text is parsed as in 5.2 item 2 (numbers are unrestricted
  here). The check fails if the text does not parse or the value is not an
  object (an array or `null` is not an object here). Otherwise every field of
  `required` (default empty) must be an own member, and every member named in
  `types` that is present must have the named ECMAScript `typeof`: `string`,
  `number`, `boolean`, or `object`, where `null` and arrays are `object`.
- **`checksum`**: the lowercase hex SHA-256 of the deliverable bytes equals the
  lowercased `sha256` parameter.

### 5.4 Score and pass

Each check has `weight` (default 1). With `W` the sum of weights and `P` the sum
of weights of passing checks:

```text
rounded = round-half-up(100 * P / W)     (ECMAScript Math.round; W > 0 by validation)
score   = rounded                        if every check passed
        = min(rounded, 99)               otherwise
threshold = passThreshold, default 100
pass    = score >= threshold
```

`100 * P / W` is computed as `(P / W) * 100` in IEEE-754 double arithmetic. So a
score of 100 always means every check passed. (This is the Judge's rule since
commit `2563835`; every verdict recorded before it is consistent with it.)

### 5.5 Evidence core

```text
evidenceCore = {
  jobId:        the claim's jobId,
  criteriaHash: the recomputed criteriaHash,
  deliverable:  the claim's deliverableCommitment,
  criteria:     the parsed criteria,
  checks:       [ { kind, pass, weight } for each check in order ],
  score, threshold, pass
}
```

## 6. Deterministic procedure

Given the claim, the evidence set and its payloads, in order:

1. If `chain-snapshot` is `UNAVAILABLE`: `UNVERIFIABLE /
   rvr.judge-protocol.v0.required_chain_snapshot_unavailable`.
2. Parse the snapshot and validate it (gate `snapshot_invalid`); require canonical
   bytes (gate `snapshot_not_canonical`); require its `chainId`, `acp` and
   `evaluatorContract` to be this profile's and equal to the claim's, and
   `job.id` to equal the claim's `jobId` (gate `snapshot_claim_mismatch`);
   require `job.evaluator` to be JudgeEvaluator (gate `evaluator_not_judge`);
   require `submission.deliverable` to equal `deliverableCommitment` (gate
   `commitment_mismatch`).
3. Extract, parse, scope and validate the criteria (5.2; gates
   `criteria_missing`, `criteria_invalid`, `criteria_out_of_scope`), and require
   their `criteriaHash` to equal the claim's (gate `criteria_hash_mismatch`).
4. If `deliverable` is `UNAVAILABLE`: `UNVERIFIABLE /
   rvr.judge-protocol.v0.required_deliverable_unavailable`.
5. Require `keccak256(deliverable) = deliverableCommitment` (gate
   `commitment_mismatch`), then the size limit (gate `resource_limit`), then
   valid UTF-8 when a text check is present (gate `deliverable_not_utf8`); run
   the checks in order (5.3; gate `resource_limit` for deep `schema` input),
   score (5.4), and compute `evidenceHash` (5.5).
6. Compare with the snapshot's verdict: `MATCHES` when its `jobId`,
   `criteriaHash`, `deliverable`, `score`, `threshold`, `pass` and
   `evidenceHash` all equal the derivation, `DIFFERS` otherwise, `NO_VERDICT`
   when it is `null`.
7. `pass` gives `VERIFIED / rvr.judge-protocol.v0.score_meets_threshold`;
   otherwise `REFUTED / rvr.judge-protocol.v0.score_below_threshold`.

Gate reason codes are `rvr.judge-protocol.v0.gate.<name>` as listed in the
profile's `reasonCodeNamespace`. A gate rejection is never an outcome and never
a recomputation status.

Resource limits: deliverables above 1,000,000 bytes, and `schema` deliverables
nesting deeper than 512 levels, are gate rejections (`resource_limit`), never
outcomes.

## 7. Mapping the Judge verdict

The EIP-712 verdict has eight fields. In this profile:

| Verdict field | Where it lives |
| --- | --- |
| `jobId` | claim `jobId`; part of the `evidenceHash` preimage |
| `criteriaHash` | claim `criteriaHash`; recomputed in the result |
| `deliverable` | claim `deliverableCommitment`; recomputed as keccak256 of the deliverable |
| `score`, `threshold` | recomputed in the result |
| `pass` | recomputed in the result; projected as the outcome |
| `evidenceHash` | recomputed in the result |
| `timestamp` | snapshot only; recorded, not re-derived, not outcome-relevant |

The recorded verdict as a whole stays in the chain snapshot, and the result's
`verdictAgreement` says whether it equals the derivation.

## 8. Canonical result

The canonical result matches `#/$defs/canonicalResult`: `outcome` and
`reasonCode` (projected into the receipt) and an `evaluation` holding the
procedure and contract identifiers, both boundaries, the snapshot block, the
recomputed `criteriaHash`, `deliverableCommitment`, per-check results (`index`,
`kind`, `weight`, `pass`), `score`, `threshold`, `pass`, `evidenceHash`, the
recorded verdict's decision (`PASS`, `REJECT` or `NONE`) and `verdictAgreement`.
Fields the procedure did not reach are `null` (or an empty `checks` list).

## 9. Recomputation and failure ownership

Recomputation follows ERC-8404 in its stated order. Only dependencies marked
`requiredForRecomputation` are resolved, and each is hashed before it is parsed
or used. An unavailable required dependency returns `CANNOT_RECOMPUTE /
rvr.recompute.normative_dependency_unavailable`; one that fails its pin returns
`CANNOT_RECOMPUTE / rvr.recompute.normative_dependency_pin_mismatch`; neither
evaluates, and the failing bytes are never parsed. A committed-present payload
that cannot be supplied returns `CANNOT_RECOMPUTE /
rvr.recompute.committed_evidence_unavailable` without evaluation. A supplied
payload whose length or digest differs from its descriptor, a contradictory
receipt projection, and any outcome-relevant input outside the closure are gate
rejections. A complete, self-consistent mutation is evaluated and returns
`DIVERGED` against the fixed receipt.

## 10. Unicode

`wholeWords` boundaries use the Unicode General_Category of the recomputer's
Unicode Character Database. v0 is exact for code points whose category is the
same in Unicode 15.0 through 16.0, the versions of the reference
implementations. A result that depends on a code point assigned or recategorized
outside that range is outside v0; a later profile will pin a category table.
