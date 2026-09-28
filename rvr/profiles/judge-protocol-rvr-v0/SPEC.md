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
the threshold). `UNVERIFIABLE` means the evidence descriptor commits the chain
snapshot or the deliverable as `UNAVAILABLE` (section 6).

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
is no whitespace. No object in the preimage has a member named `__proto__`:
criteria with one are refused (5.2 item 4), because an ECMAScript object rebuilt
by assignment would silently drop it.

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

The evidence set has exactly two members, sorted by `id`, each with exactly this
media type when `PRESENT`:

- `chain-snapshot`: `application/json; profile=rvr-canonical-json-v0`, the exact
  canonical bytes of a chain snapshot matching `#/$defs/chainSnapshot`;
- `deliverable`: `application/octet-stream`, the exact deliverable bytes whose
  keccak256 is the provider's commitment.

### 5.1 Chain snapshot

The snapshot freezes, at one named block (`readAt.blockNumber`,
`readAt.blockHash`), everything outcome-relevant that lives on chain:

- `job`: the ERC-8183 job fields, including `evaluator` and the exact
  `description` string that carries the criteria;
- `submission`: the provider's `JobSubmitted` event: its `jobId`, transaction,
  block, block hash, provider, and the `deliverable` commitment;
- `verdict`: the JudgeEvaluator verdict for the job, all eight EIP-712 fields,
  plus the transaction and block of its `VerdictSubmitted` event when known, or
  `null` when no verdict existed at `readAt`.

The payload MUST be exactly `rvr-canonical-json-v0(snapshot)`; an alternate
spelling of the same JSON is a gate rejection (`snapshot_not_canonical`), and
bytes that do not parse as JSON, including a value nested deeper than the
recomputer's parser goes, are `snapshot_invalid`.

The snapshot MUST describe one chain state, or it is a gate rejection
(`snapshot_inconsistent`): `submission.jobId` equals `job.id`; `job.provider` is
not the zero address and equals `submission.provider`; the submission's block
is at or before `readAt`; `job.status` is Submitted, Completed, Rejected or
Expired (2 to 5); and a verdict, when present, has `jobId` equal to `job.id` and,
when its block is known, a block from the submission's block to `readAt`.

### 5.2 Criteria

1. **Extraction.** The criteria text is the first capture of the ECMAScript
   regular expression ``/```judge-criteria\s*([\s\S]*?)```/`` applied to
   `job.description`, where `\s` is ECMAScript WhiteSpace and LineTerminator:
   U+0009, U+000A, U+000B, U+000C, U+000D, U+0020, U+00A0, U+1680, U+2000 to
   U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. No match is a gate
   rejection (`criteria_missing`).
2. **Parsing.** The text is parsed as ECMAScript `JSON.parse` does (RFC 8259
   grammar; a duplicate key keeps its last value; no `NaN` or `Infinity`
   literals). Text that does not parse, or is not an object, is a gate rejection
   (`criteria_invalid`). Syntax is decided before item 3: an out-of-scope number
   in text that does not parse is still `criteria_invalid`.
3. **v0 scope.** Every number, read as an IEEE-754 double as ECMAScript does,
   MUST be an integer with absolute value at most 2^53 - 1, and every string MUST
   consist of Unicode scalar values. Otherwise the criteria are outside v0 (gate
   rejection). So `1.0` and `1e2` are the integers 1 and 100, and `0.5` is out
   of scope.
4. **Validation.** The criteria MUST pass the Judge's validation, or they are a
   gate rejection (`criteria_invalid`): nesting at most 12 levels, counting
   objects and arrays with the criteria object at level 1, and no object at any
   depth having a member named `__proto__`; `checks` a non-empty array of at most
   64 objects, at most 4 of them `http-endpoint`; `passThreshold` absent or an
   integer from 0 to 100 (not a boolean); each check has only the fields `kind`,
   `params` and `weight`; `kind` is a known kind; `weight`, if present, is a
   number greater than 0 and at most 1000; `params`, if present and not null, is
   an object whose members are the kind's known parameters with valid values:
   - `length`: `min`, `max` numbers at least 0 with `min <= max`; `unit` is
     `chars` or `words`;
   - `contains`: `all` a list of at most 256 strings of at most 1024 UTF-16 code
     units; `wholeWords` a boolean;
   - `schema`: `required` a list like `all`; `types` an object of at most 256
     members whose values are `string`, `number`, `boolean` or `object`;
   - `checksum`: `sha256` exactly 64 hexadecimal characters (required);
   - `http-endpoint`: `url` a string of at most 2048 UTF-16 code units;
     `expectStatus` an integer from 100 to 599 (not a boolean); `bodyIncludes` a
     list like `all`; `timeoutMs` a number from 1 to 10000. Valid probes are
     then outside v0 (item 5); invalid ones are `criteria_invalid`.

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
  neighbouring characters, where present, are not word characters (section 10).
- **`schema`**: the text is parsed as in 5.2 item 2, and every number is read as
  an IEEE-754 double as ECMAScript does, so a very long integer is a large or
  infinite number, never an error. The check fails if the text does not parse or
  the value is not an object (an array or `null` is not an object here). Otherwise every field of
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

0. The claim MUST match `#/$defs/claim` and the evidence set
   `#/$defs/evidenceSet` (gate `rvr.gate.schema_invalid`), with its two members
   in order (gate `rvr.gate.evidence_closure_incomplete`), each supplied payload
   matching its descriptor's length and digest, and no payload for an
   `UNAVAILABLE` member (gate `rvr.gate.identity_mismatch`).
1. If the deliverable is `PRESENT`: require at most 1,000,000 bytes (gate
   `resource_limit`), then `keccak256(deliverable) = deliverableCommitment`
   (gate `commitment_mismatch`). This needs no snapshot, so it comes first.
2. If `chain-snapshot` is `UNAVAILABLE`: `UNVERIFIABLE /
   rvr.judge-protocol.v0.required_chain_snapshot_unavailable`.
3. Parse the snapshot and validate it against `#/$defs/chainSnapshot` (gate
   `snapshot_invalid`); require canonical bytes (gate `snapshot_not_canonical`)
   and one chain state (5.1; gate `snapshot_inconsistent`); require its
   `chainId`, `acp`, `evaluatorContract` and `job.id` to equal the claim's (gate
   `snapshot_claim_mismatch`; the claim schema pins the first three to this
   profile's deployment); require `job.evaluator` to be JudgeEvaluator (gate
   `evaluator_not_judge`) and `submission.deliverable` to equal
   `deliverableCommitment` (gate `commitment_mismatch`).
4. Extract, parse, scope and validate the criteria (5.2; gates
   `criteria_missing`, `criteria_invalid`, `criteria_out_of_scope`), and require
   their `criteriaHash` to equal the claim's (gate `criteria_hash_mismatch`).
5. If `deliverable` is `UNAVAILABLE`: `UNVERIFIABLE /
   rvr.judge-protocol.v0.required_deliverable_unavailable`.
6. Require valid UTF-8 when a text check is present (gate
   `deliverable_not_utf8`); run the checks in order (5.3), score (5.4), and
   compute `evidenceHash` (5.5).
7. Compare with the snapshot's verdict: `MATCHES` when its `criteriaHash`,
   `deliverable`, `score`, `threshold`, `pass` and `evidenceHash` all equal the
   derivation (its `jobId` already equals the job's, step 3), `DIFFERS`
   otherwise, `NO_VERDICT` when it is `null`. An `UNVERIFIABLE` result, which evaluates no checks, says
   `NOT_EVALUATED`.
8. `pass` gives `VERIFIED / rvr.judge-protocol.v0.score_meets_threshold`;
   otherwise `REFUTED / rvr.judge-protocol.v0.score_below_threshold`.

Gate reason codes are the profile's `rvr.judge-protocol.v0.gate.<name>` codes
above, and the ERC's generic `rvr.gate.schema_invalid`,
`rvr.gate.identity_mismatch`, `rvr.gate.result_projection_mismatch` and
`rvr.gate.evidence_closure_incomplete` for malformed objects, identity failures,
contradictory projections and closure failures (section 9). All are listed in
the profile's `reasonCodeNamespace`. A gate rejection is never an outcome and
never a recomputation status.

Resource limits: a `schema` check whose text reaches a depth greater than 512
is a gate rejection (`resource_limit`), counted before parsing, whether or not
the text is JSON. The text is scanned once with a count starting at 0: outside a
string, `[` and `{` add 1 and `]` and `}` subtract 1 (the count may go below 0),
and `"` starts a string; inside a string, `\` skips the next character and `"`
ends the string. The depth is the largest count reached. The Judge itself rules
on such text (the check fails when it does not parse); v0 declines to, and never
returns an outcome for it.

## 7. Mapping the Judge verdict

The EIP-712 verdict has eight fields. In this profile:

| Verdict field | Where it lives |
| --- | --- |
| `jobId` | claim `jobId`; equal to the snapshot's job and submission; part of the `evidenceHash` preimage |
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
recorded verdict's decision (`PASS`, `REJECT` or `NONE`) and `verdictAgreement`
(`MATCHES`, `DIFFERS`, `NO_VERDICT` or `NOT_EVALUATED`). Fields the procedure
did not reach are `null` (or an empty `checks` list). A canonical result whose
`outcome`, `reasonCode` and `pass` contradict each other is malformed (gate
`rvr.gate.schema_invalid`).

## 9. Recomputation and failure ownership

The recomputer holds the receipt, the original canonical result, the claim and
the evidence descriptor; the payloads are supplied as candidate evidence.
Recomputation performs the ERC-8404 steps in the ERC's order:

1. The receipt MUST have exactly the six ERC-8404 members in their shapes and
   the Verification Profile envelope MUST validate against the bootstrap schema
   (gate `rvr.gate.schema_invalid`), with unique dependency ids (gate
   `rvr.gate.identity_mismatch`).
2. The supplied profile's digest MUST equal the receipt's
   `verificationProfileDigest` (gate `rvr.gate.identity_mismatch`), before any
   dependency is read.
3. Only dependencies marked `requiredForRecomputation` are resolved, each read
   once and hashed before it is parsed or used. An unavailable or unresolvable
   one (its path outside the package root, say) returns `CANNOT_RECOMPUTE /
   rvr.recompute.normative_dependency_unavailable`; one whose bytes fail its pin
   returns `CANNOT_RECOMPUTE /
   rvr.recompute.normative_dependency_identity_mismatch`, and those bytes are
   never parsed. Then, in order: the manifest schema, constraints schema, SPEC.md
   and RVR schema MUST all be marked required (gate `rvr.gate.schema_invalid`);
   the generic-schema pin MUST be byte for byte the bootstrap schema (gate
   `rvr.gate.identity_mismatch`); the constraints schema is parsed and applied to
   the profile, and the RVR schema and the word table of section 10 are parsed
   (gate `rvr.gate.schema_invalid`); both contracts' `schemaSha256` MUST be the
   pinned RVR schema's digest (gate `rvr.gate.identity_mismatch`). Last, the
   candidate descriptor is read only to find the members committed as
   `PRESENT` (a descriptor too malformed for that is `rvr.gate.schema_invalid`
   here); any such member without a supplied payload, even one outside the
   closure, returns `CANNOT_RECOMPUTE / rvr.recompute.committed_evidence_unavailable`.
   None of these evaluates.
4. The original receipt, canonical result, claim and evidence descriptor are
   validated: shapes (gate `rvr.gate.schema_invalid`, including a result whose
   outcome, reason code and `pass` contradict each other), any stored payloads
   against their descriptors and the four identities against the receipt (gate
   `rvr.gate.identity_mismatch`), and the outcome and reason-code projections
   (gate `rvr.gate.result_projection_mismatch`, `resultDigest` preserved).
5. The candidate closure is validated: any outcome-relevant input outside it
   (gate `rvr.gate.evidence_closure_incomplete`), the descriptor's shape and
   media types (gate `rvr.gate.schema_invalid`), the member set and order (gate
   `rvr.gate.evidence_closure_incomplete`), a payload whose length or digest
   differs from its descriptor or an `UNAVAILABLE` member with a payload (gate
   `rvr.gate.identity_mismatch`).
6. to 8. The claim and evidence-set digests are recomputed and section 6 is
   run, deriving exactly one canonical result.
9. `REPRODUCED` only when the claim, evidence-set, Verification Profile and
   canonical-result identities all equal the receipt's.
10. Otherwise `DIVERGED`: evaluation completed under the fixed profile, and a
   candidate identity or the canonical result differs from the receipt's. A
   changed deliverable and a changed chain snapshot are both `DIVERGED` even when
   the derived result is the same, because the evidence-set identity differs.

## 10. Word characters

For `contains` with `wholeWords`, a word character is U+005F LOW LINE or a code
point in the table below: every code point whose General_Category is L* (Lu, Ll,
Lt, Lm, Lo) or N* (Nd, Nl, No) in Unicode 17.0.0, merged into inclusive ranges of
hexadecimal code points. The table is part of this specification. A recomputer
MUST use it and MUST NOT consult its own Unicode Character Database, so the
answer is the same on every runtime. Every other code point, including an
unassigned one, is not a word character.

The table was generated from
`https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt`
(SHA-256 `d62e5bab70ca74f099343f71224fa051cb1fdd61a1ab45c0488c44cfc0b6102e`) by
`rvr/word_ranges.py` in the judge-protocol repository. The live judge and the
in-browser verifier carry the same ranges.

```judge-protocol-word-ranges
0030-0039
0041-005A
0061-007A
00AA
00B2-00B3
00B5
00B9-00BA
00BC-00BE
00C0-00D6
00D8-00F6
00F8-02C1
02C6-02D1
02E0-02E4
02EC
02EE
0370-0374
0376-0377
037A-037D
037F
0386
0388-038A
038C
038E-03A1
03A3-03F5
03F7-0481
048A-052F
0531-0556
0559
0560-0588
05D0-05EA
05EF-05F2
0620-064A
0660-0669
066E-066F
0671-06D3
06D5
06E5-06E6
06EE-06FC
06FF
0710
0712-072F
074D-07A5
07B1
07C0-07EA
07F4-07F5
07FA
0800-0815
081A
0824
0828
0840-0858
0860-086A
0870-0887
0889-088F
08A0-08C9
0904-0939
093D
0950
0958-0961
0966-096F
0971-0980
0985-098C
098F-0990
0993-09A8
09AA-09B0
09B2
09B6-09B9
09BD
09CE
09DC-09DD
09DF-09E1
09E6-09F1
09F4-09F9
09FC
0A05-0A0A
0A0F-0A10
0A13-0A28
0A2A-0A30
0A32-0A33
0A35-0A36
0A38-0A39
0A59-0A5C
0A5E
0A66-0A6F
0A72-0A74
0A85-0A8D
0A8F-0A91
0A93-0AA8
0AAA-0AB0
0AB2-0AB3
0AB5-0AB9
0ABD
0AD0
0AE0-0AE1
0AE6-0AEF
0AF9
0B05-0B0C
0B0F-0B10
0B13-0B28
0B2A-0B30
0B32-0B33
0B35-0B39
0B3D
0B5C-0B5D
0B5F-0B61
0B66-0B6F
0B71-0B77
0B83
0B85-0B8A
0B8E-0B90
0B92-0B95
0B99-0B9A
0B9C
0B9E-0B9F
0BA3-0BA4
0BA8-0BAA
0BAE-0BB9
0BD0
0BE6-0BF2
0C05-0C0C
0C0E-0C10
0C12-0C28
0C2A-0C39
0C3D
0C58-0C5A
0C5C-0C5D
0C60-0C61
0C66-0C6F
0C78-0C7E
0C80
0C85-0C8C
0C8E-0C90
0C92-0CA8
0CAA-0CB3
0CB5-0CB9
0CBD
0CDC-0CDE
0CE0-0CE1
0CE6-0CEF
0CF1-0CF2
0D04-0D0C
0D0E-0D10
0D12-0D3A
0D3D
0D4E
0D54-0D56
0D58-0D61
0D66-0D78
0D7A-0D7F
0D85-0D96
0D9A-0DB1
0DB3-0DBB
0DBD
0DC0-0DC6
0DE6-0DEF
0E01-0E30
0E32-0E33
0E40-0E46
0E50-0E59
0E81-0E82
0E84
0E86-0E8A
0E8C-0EA3
0EA5
0EA7-0EB0
0EB2-0EB3
0EBD
0EC0-0EC4
0EC6
0ED0-0ED9
0EDC-0EDF
0F00
0F20-0F33
0F40-0F47
0F49-0F6C
0F88-0F8C
1000-102A
103F-1049
1050-1055
105A-105D
1061
1065-1066
106E-1070
1075-1081
108E
1090-1099
10A0-10C5
10C7
10CD
10D0-10FA
10FC-1248
124A-124D
1250-1256
1258
125A-125D
1260-1288
128A-128D
1290-12B0
12B2-12B5
12B8-12BE
12C0
12C2-12C5
12C8-12D6
12D8-1310
1312-1315
1318-135A
1369-137C
1380-138F
13A0-13F5
13F8-13FD
1401-166C
166F-167F
1681-169A
16A0-16EA
16EE-16F8
1700-1711
171F-1731
1740-1751
1760-176C
176E-1770
1780-17B3
17D7
17DC
17E0-17E9
17F0-17F9
1810-1819
1820-1878
1880-1884
1887-18A8
18AA
18B0-18F5
1900-191E
1946-196D
1970-1974
1980-19AB
19B0-19C9
19D0-19DA
1A00-1A16
1A20-1A54
1A80-1A89
1A90-1A99
1AA7
1B05-1B33
1B45-1B4C
1B50-1B59
1B83-1BA0
1BAE-1BE5
1C00-1C23
1C40-1C49
1C4D-1C7D
1C80-1C8A
1C90-1CBA
1CBD-1CBF
1CE9-1CEC
1CEE-1CF3
1CF5-1CF6
1CFA
1D00-1DBF
1E00-1F15
1F18-1F1D
1F20-1F45
1F48-1F4D
1F50-1F57
1F59
1F5B
1F5D
1F5F-1F7D
1F80-1FB4
1FB6-1FBC
1FBE
1FC2-1FC4
1FC6-1FCC
1FD0-1FD3
1FD6-1FDB
1FE0-1FEC
1FF2-1FF4
1FF6-1FFC
2070-2071
2074-2079
207F-2089
2090-209C
2102
2107
210A-2113
2115
2119-211D
2124
2126
2128
212A-212D
212F-2139
213C-213F
2145-2149
214E
2150-2189
2460-249B
24EA-24FF
2776-2793
2C00-2CE4
2CEB-2CEE
2CF2-2CF3
2CFD
2D00-2D25
2D27
2D2D
2D30-2D67
2D6F
2D80-2D96
2DA0-2DA6
2DA8-2DAE
2DB0-2DB6
2DB8-2DBE
2DC0-2DC6
2DC8-2DCE
2DD0-2DD6
2DD8-2DDE
2E2F
3005-3007
3021-3029
3031-3035
3038-303C
3041-3096
309D-309F
30A1-30FA
30FC-30FF
3105-312F
3131-318E
3192-3195
31A0-31BF
31F0-31FF
3220-3229
3248-324F
3251-325F
3280-3289
32B1-32BF
3400-4DBF
4E00-A48C
A4D0-A4FD
A500-A60C
A610-A62B
A640-A66E
A67F-A69D
A6A0-A6EF
A717-A71F
A722-A788
A78B-A7DC
A7F1-A801
A803-A805
A807-A80A
A80C-A822
A830-A835
A840-A873
A882-A8B3
A8D0-A8D9
A8F2-A8F7
A8FB
A8FD-A8FE
A900-A925
A930-A946
A960-A97C
A984-A9B2
A9CF-A9D9
A9E0-A9E4
A9E6-A9FE
AA00-AA28
AA40-AA42
AA44-AA4B
AA50-AA59
AA60-AA76
AA7A
AA7E-AAAF
AAB1
AAB5-AAB6
AAB9-AABD
AAC0
AAC2
AADB-AADD
AAE0-AAEA
AAF2-AAF4
AB01-AB06
AB09-AB0E
AB11-AB16
AB20-AB26
AB28-AB2E
AB30-AB5A
AB5C-AB69
AB70-ABE2
ABF0-ABF9
AC00-D7A3
D7B0-D7C6
D7CB-D7FB
F900-FA6D
FA70-FAD9
FB00-FB06
FB13-FB17
FB1D
FB1F-FB28
FB2A-FB36
FB38-FB3C
FB3E
FB40-FB41
FB43-FB44
FB46-FBB1
FBD3-FD3D
FD50-FD8F
FD92-FDC7
FDF0-FDFB
FE70-FE74
FE76-FEFC
FF10-FF19
FF21-FF3A
FF41-FF5A
FF66-FFBE
FFC2-FFC7
FFCA-FFCF
FFD2-FFD7
FFDA-FFDC
10000-1000B
1000D-10026
10028-1003A
1003C-1003D
1003F-1004D
10050-1005D
10080-100FA
10107-10133
10140-10178
1018A-1018B
10280-1029C
102A0-102D0
102E1-102FB
10300-10323
1032D-1034A
10350-10375
10380-1039D
103A0-103C3
103C8-103CF
103D1-103D5
10400-1049D
104A0-104A9
104B0-104D3
104D8-104FB
10500-10527
10530-10563
10570-1057A
1057C-1058A
1058C-10592
10594-10595
10597-105A1
105A3-105B1
105B3-105B9
105BB-105BC
105C0-105F3
10600-10736
10740-10755
10760-10767
10780-10785
10787-107B0
107B2-107BA
10800-10805
10808
1080A-10835
10837-10838
1083C
1083F-10855
10858-10876
10879-1089E
108A7-108AF
108E0-108F2
108F4-108F5
108FB-1091B
10920-10939
10940-10959
10980-109B7
109BC-109CF
109D2-10A00
10A10-10A13
10A15-10A17
10A19-10A35
10A40-10A48
10A60-10A7E
10A80-10A9F
10AC0-10AC7
10AC9-10AE4
10AEB-10AEF
10B00-10B35
10B40-10B55
10B58-10B72
10B78-10B91
10BA9-10BAF
10C00-10C48
10C80-10CB2
10CC0-10CF2
10CFA-10D23
10D30-10D39
10D40-10D65
10D6F-10D85
10E60-10E7E
10E80-10EA9
10EB0-10EB1
10EC2-10EC7
10F00-10F27
10F30-10F45
10F51-10F54
10F70-10F81
10FB0-10FCB
10FE0-10FF6
11003-11037
11052-1106F
11071-11072
11075
11083-110AF
110D0-110E8
110F0-110F9
11103-11126
11136-1113F
11144
11147
11150-11172
11176
11183-111B2
111C1-111C4
111D0-111DA
111DC
111E1-111F4
11200-11211
11213-1122B
1123F-11240
11280-11286
11288
1128A-1128D
1128F-1129D
1129F-112A8
112B0-112DE
112F0-112F9
11305-1130C
1130F-11310
11313-11328
1132A-11330
11332-11333
11335-11339
1133D
11350
1135D-11361
11380-11389
1138B
1138E
11390-113B5
113B7
113D1
113D3
11400-11434
11447-1144A
11450-11459
1145F-11461
11480-114AF
114C4-114C5
114C7
114D0-114D9
11580-115AE
115D8-115DB
11600-1162F
11644
11650-11659
11680-116AA
116B8
116C0-116C9
116D0-116E3
11700-1171A
11730-1173B
11740-11746
11800-1182B
118A0-118F2
118FF-11906
11909
1190C-11913
11915-11916
11918-1192F
1193F
11941
11950-11959
119A0-119A7
119AA-119D0
119E1
119E3
11A00
11A0B-11A32
11A3A
11A50
11A5C-11A89
11A9D
11AB0-11AF8
11BC0-11BE0
11BF0-11BF9
11C00-11C08
11C0A-11C2E
11C40
11C50-11C6C
11C72-11C8F
11D00-11D06
11D08-11D09
11D0B-11D30
11D46
11D50-11D59
11D60-11D65
11D67-11D68
11D6A-11D89
11D98
11DA0-11DA9
11DB0-11DDB
11DE0-11DE9
11EE0-11EF2
11F02
11F04-11F10
11F12-11F33
11F50-11F59
11FB0
11FC0-11FD4
12000-12399
12400-1246E
12480-12543
12F90-12FF0
13000-1342F
13441-13446
13460-143FA
14400-14646
16100-1611D
16130-16139
16800-16A38
16A40-16A5E
16A60-16A69
16A70-16ABE
16AC0-16AC9
16AD0-16AED
16B00-16B2F
16B40-16B43
16B50-16B59
16B5B-16B61
16B63-16B77
16B7D-16B8F
16D40-16D6C
16D70-16D79
16E40-16E96
16EA0-16EB8
16EBB-16ED3
16F00-16F4A
16F50
16F93-16F9F
16FE0-16FE1
16FE3
16FF2-16FF6
17000-18CD5
18CFF-18D1E
18D80-18DF2
1AFF0-1AFF3
1AFF5-1AFFB
1AFFD-1AFFE
1B000-1B122
1B132
1B150-1B152
1B155
1B164-1B167
1B170-1B2FB
1BC00-1BC6A
1BC70-1BC7C
1BC80-1BC88
1BC90-1BC99
1CCF0-1CCF9
1D2C0-1D2D3
1D2E0-1D2F3
1D360-1D378
1D400-1D454
1D456-1D49C
1D49E-1D49F
1D4A2
1D4A5-1D4A6
1D4A9-1D4AC
1D4AE-1D4B9
1D4BB
1D4BD-1D4C3
1D4C5-1D505
1D507-1D50A
1D50D-1D514
1D516-1D51C
1D51E-1D539
1D53B-1D53E
1D540-1D544
1D546
1D54A-1D550
1D552-1D6A5
1D6A8-1D6C0
1D6C2-1D6DA
1D6DC-1D6FA
1D6FC-1D714
1D716-1D734
1D736-1D74E
1D750-1D76E
1D770-1D788
1D78A-1D7A8
1D7AA-1D7C2
1D7C4-1D7CB
1D7CE-1D7FF
1DF00-1DF1E
1DF25-1DF2A
1E030-1E06D
1E100-1E12C
1E137-1E13D
1E140-1E149
1E14E
1E290-1E2AD
1E2C0-1E2EB
1E2F0-1E2F9
1E4D0-1E4EB
1E4F0-1E4F9
1E5D0-1E5ED
1E5F0-1E5FA
1E6C0-1E6DE
1E6E0-1E6E2
1E6E4-1E6E5
1E6E7-1E6ED
1E6F0-1E6F4
1E6FE-1E6FF
1E7E0-1E7E6
1E7E8-1E7EB
1E7ED-1E7EE
1E7F0-1E7FE
1E800-1E8C4
1E8C7-1E8CF
1E900-1E943
1E94B
1E950-1E959
1EC71-1ECAB
1ECAD-1ECAF
1ECB1-1ECB4
1ED01-1ED2D
1ED2F-1ED3D
1EE00-1EE03
1EE05-1EE1F
1EE21-1EE22
1EE24
1EE27
1EE29-1EE32
1EE34-1EE37
1EE39
1EE3B
1EE42
1EE47
1EE49
1EE4B
1EE4D-1EE4F
1EE51-1EE52
1EE54
1EE57
1EE59
1EE5B
1EE5D
1EE5F
1EE61-1EE62
1EE64
1EE67-1EE6A
1EE6C-1EE72
1EE74-1EE77
1EE79-1EE7C
1EE7E
1EE80-1EE89
1EE8B-1EE9B
1EEA1-1EEA3
1EEA5-1EEA9
1EEAB-1EEBB
1F100-1F10C
1FBF0-1FBF9
20000-2A6DF
2A700-2B81D
2B820-2CEAD
2CEB0-2EBE0
2EBF0-2EE5D
2F800-2FA1D
30000-3134A
31350-33479
```
