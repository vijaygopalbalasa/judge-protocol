# Acceptance criteria reference

The client writes down what "done" means before any work exists. Judge Protocol
rules against exactly that, deterministically. This page documents what the judge
actually does with each field; `judge-service/src/checkers/index.js` is the
source of truth, and a test fails if this page falls out of step with it.

## Where the criteria live

In the job description, as one fenced block tagged `judge-criteria`. The job
description on Circle's ERC-8183 contract is immutable, so the criteria are
committed on chain before the provider starts.

````text
Explain ERC-8183 escrow in plain English.
```judge-criteria
{"version":1,"passThreshold":100,"checks":[{"kind":"length","params":{"min":20,"max":400}},{"kind":"contains","params":{"all":["ERC-8183","USDC"]}}]}
```
````

The kit's `criteriaBlock(criteria, { title })` builds this for you and refuses
criteria the judge would refuse.

## Top-level fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `checks` | array, at least 1 | required | The checks to run, in order. |
| `passThreshold` | integer 0 to 100 | `100` | Minimum score to pass. `100` means every check must pass. |
| `version` | number | none | Free-form; hashed with everything else. |
| `jobType` | string | none | Free-form label; hashed with everything else. |

Each check: `{ "kind": "...", "params": { ... }, "weight": 1 }`. `weight` is
optional (default 1) and must be a finite number greater than 0.

## Scoring

`score = round(100 * sum(weights of passing checks) / sum(all weights))`, and
the job passes when `score >= passThreshold`. PASS releases the escrow to the
provider; REJECT refunds the client.

## Check kinds

### `length`
Counts words (default) or characters of the deliverable decoded as UTF-8.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `min` | number, 0 or more | 0 | Inclusive lower bound. |
| `max` | number, 0 or more, not below `min` | no limit | Inclusive upper bound. |
| `unit` | `"chars"`, `"words"` or omitted | words | `"chars"` counts UTF-16 code units (JavaScript `length`); otherwise whitespace-separated words. |

### `contains`
Every term must appear. Literal, case-sensitive match (not a regex): a plain substring by
default, or a whole word with `wholeWords`.

| Param | Type | Meaning |
|---|---|---|
| `all` | list of up to 256 strings, each up to 1024 characters | Terms that must all be present. An empty list passes. |
| `wholeWords` | `true` or `false` (default `false`) | When `true`, each term must stand on its own: not preceded or followed by a letter, digit or underscore, so `"Arc"` does not match inside `"Architecture"`. Terms stay case-sensitive. |

### `schema`
The deliverable must parse as a JSON object. Valid JSON that is not a JSON object
(for example `42` or `null`) fails the check.

| Param | Type | Meaning |
|---|---|---|
| `required` | list of up to 256 field names | Keys that must exist on the parsed object. |
| `types` | object `{ key: type }`, up to 256 fields | For keys that exist, `typeof value` must equal `type`, one of `"string"`, `"number"`, `"boolean"`, `"object"`. |

### `checksum`
The SHA-256 of the exact deliverable bytes must match. Useful for files.

| Param | Type | Meaning |
|---|---|---|
| `sha256` | 64 hex characters | Expected digest (case-insensitive, no `0x`). Required. |

### `http-endpoint`
A live network probe: the judge fetches a URL once, at judging time.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `url` | string, up to 2048 characters | the deliverable's URL | Address to probe (http or https only; internal addresses are blocked). |
| `expectStatus` | integer from 100 to 599 | 200 | Required HTTP status. |
| `bodyIncludes` | list of up to 256 strings | none | Substrings the response body must contain. |
| `timeoutMs` | number from 1 to 10000 | 5000 | Probe timeout in milliseconds. |

This is the one kind that is **not** recomputable later: a URL can change after
the judge probed it. Its pass or fail is recorded inside the signed evidence, so
verifiers can confirm everything else and see what the judge recorded, but they
cannot re-run the probe as the judge saw it. Prefer the other kinds when you can.

## What the judge refuses (it abstains; no verdict, no settlement)

- `checks` missing, not an array, or empty
- a check that is not an object, or an unknown `kind` (for example `code-test`)
- a `weight` that is 0, negative, non-numeric or not finite
- a `passThreshold` that is not an integer from 0 to 100
- `params` that are not an object, or a param of the wrong type or out of range (the
  tables above say what each kind accepts; a param set to `null` counts as absent)
- too many checks: the judge takes at most 64 checks, and at most 4 `http-endpoint` checks
- criteria nested deeper than 12 levels
- no `judge-criteria` block, or a block that is not valid JSON

These bounds keep every ruling small and fast. A check the judge would have to
guess about is refused rather than scored, because a guessed score moves escrow.

If the judge abstains, nobody is paid by it; after `expiredAt` the client can
call `claimRefund` on the ACP.

## The criteria hash

`criteriaHash = keccak256(UTF-8 bytes of the canonical JSON)`, where canonical
JSON sorts object keys recursively (arrays keep their order) with no whitespace.
The verdict commits to this hash, so anyone can recompute it from the job
description. The kit exports `criteriaHash(criteria)`.

## Examples

A short text answer:

```json
{"version":1,"passThreshold":100,"checks":[{"kind":"length","params":{"min":50,"max":300}},{"kind":"contains","params":{"all":["USDC","escrow"]}}]}
```

A structured API response (weights make the schema matter most; 67 still passes if one term is missing):

```json
{"version":1,"passThreshold":67,"checks":[{"kind":"schema","params":{"required":["price","currency"],"types":{"price":"number","currency":"string"}},"weight":2},{"kind":"contains","params":{"all":["USD"]}}]}
```

An exact file:

```json
{"version":1,"checks":[{"kind":"checksum","params":{"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}}]}
```

## Writing good criteria

- Check what can be checked mechanically: format, presence, size, structure, exact files.
- Keep subjective quality (tone, taste, "is this good") out of the criteria; a
  deterministic judge cannot rule on it. Escalate those jobs to a human or a dispute process.
- Try your criteria against a sample deliverable first: `POST /api/evaluate` or the
  kit's `dryRun()` returns exactly the score the judge would give.
