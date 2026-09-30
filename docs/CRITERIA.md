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
criteria the judge would refuse. If you write the block by hand, keep it one valid
JSON object and write any backtick inside a term as `\u0060` (valid JSON for the same
character): three backticks in a row would end the block early.

## Top-level fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `checks` | array, at least 1 | required | The checks to run, in order. |
| `passThreshold` | integer 0 to 100 | `100` | Minimum score to pass. `100` means every check must pass. |
| `version` | number | none | Free-form; hashed with everything else. |
| `jobType` | string | none | Free-form label; hashed with everything else. |

Any other top-level field is free-form too: hashed with everything else, otherwise ignored.
So a misspelled `passThreshold` is not caught, and the default of 100 applies. The dry run
returns the `threshold` it used; check it before you create the job.

Each check: `{ "kind": "...", "params": { ... }, "weight": 1 }`, and nothing else. `weight`
is optional (default 1) and must be a number greater than 0 and at most 1000.

## Scoring

`score = round(100 * sum(weights of passing checks) / sum(all weights))`, and
the job passes when `score >= passThreshold`. PASS releases the escrow to the
provider; REJECT refunds the client.

A score of 100 means every check passed. If any check failed, the score is at most 99,
even when the failed check's weight is too small to move the rounded number (weights 1000
and 1 with the light check failing score 99, not 100). So a `passThreshold` of 100 always
means every check must pass.

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
| `wholeWords` | `true` or `false` (default `false`) | When `true`, each term must stand on its own: not preceded or followed by a letter, digit or underscore, so `"Arc"` does not match inside `"Architecture"`. Letters and digits are those of Unicode 17.0.0 (a table the judge carries, so the answer never depends on the runtime). Terms stay case-sensitive. |

### `schema`
The deliverable must parse as a JSON object. Valid JSON that is not a JSON object
(for example `42` or `null`) fails the check, and a JSON array fails it too. Fields are
the object's own keys: inherited names such as `constructor` do not count.

| Param | Type | Meaning |
|---|---|---|
| `required` | list of up to 256 field names, each up to 1024 characters | Keys that must exist on the parsed object. |
| `types` | object `{ key: type }`, up to 256 fields | For keys that exist, `typeof value` must equal `type`, one of `"string"`, `"number"`, `"boolean"`, `"object"`. |

### `json`
The deliverable must parse as JSON and, when `shape` is given, match it. Use it for lists and
nested records, which `schema` cannot describe. A shape is a small subset of JSON Schema, pinned so
that the judge, the in-browser verifier and any other implementation give the same answer: nothing
depends on a platform's regular expressions or URL parser.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `shape` | a shape (below) | none: any valid JSON passes | What the parsed JSON must look like. |

A shape is an object made of these keywords. Apart from `type`, `enum` and `anyOf`, each keyword
belongs to one type, and a shape that uses it must declare that type: `{"minItems": 3}` on its own
is refused.

| Keyword | Type | Meaning |
|---|---|---|
| `type` | any | `"object"`, `"array"`, `"string"`, `"number"` (finite: a literal too large for a double, such as `1e400`, is not a number), `"integer"` (a whole number; `1.0` counts), `"boolean"` or `"null"`. |
| `enum` | any | 1 to 256 strings, numbers, booleans or nulls. The value must equal one exactly: `"1"` is not `1`, and `"arc"` is not `"Arc"`. |
| `anyOf` | none | 2 to 4 shapes, of which the value must match at least one. It stands alone (no other keyword beside it) and may not directly hold another `anyOf`. |
| `required` | object | Field names that must be present (the object's own fields). |
| `properties` | object | `{ field: shape }`. Each of these fields that is present must match its shape. |
| `additionalProperties` | object | `false` refuses any field not named in `properties`. |
| `items` | array | A shape that every item must match. |
| `minItems`, `maxItems` | array | Whole numbers: inclusive bounds on the number of items. |
| `uniqueBy` | array | `{ "field": name, "key": "value" or "domain" }`. No two items may share that field's value (strings, numbers and booleans, compared exactly) or, with `"domain"`, the domain of its URL. Items where the field is missing, or not a value of that kind, are not compared. |
| `minLength`, `maxLength` | string | Whole numbers: inclusive bounds on the length in Unicode code points. |
| `format` | string | `"url"` or `"email"`, as defined below. |
| `minimum`, `maximum` | number or integer | Inclusive bounds. |

The formats are defined here, not by any library:

- **url**: `http://` or `https://` (any letter case), a host, an optional `:port` of 1 to 5 digits,
  then optionally a path, query or fragment of printable ASCII with no spaces; at most 2048
  characters. A host is two or more dot-separated labels of ASCII letters, digits and inner hyphens
  (1 to 63 characters each, 253 in all), and its last label is not all digits. So a user name, an IP
  address, `localhost` and a non-ASCII host (write its `xn--` form) are not URLs.
- **email**: exactly one `@`. Before it, up to 64 characters made of dot-separated runs of letters,
  digits and `` !#$%&'*+/=?^_`{|}~- `` (no leading, trailing or double dot); after it, a host as for
  URLs; at most 254 characters in all. A `mailto:` link is not an email address.
- **domain** (for `uniqueBy`): the URL's host, lowercased, with one leading `www.` removed.
  `blog.example.com` and `example.com` are different domains: there is no public-suffix list,
  because that list changes over time.

One `json` check may hold at most 128 shapes (every nested shape counts), and the criteria's
12-level nesting limit applies. The check's detail counts every problem and names the first five
by path, for example `$[3].network: "arc" is not one of "Arc", "Base"`.

### `checksum`
The SHA-256 of the exact deliverable bytes must match. Useful for files.

| Param | Type | Meaning |
|---|---|---|
| `sha256` | 64 hex characters | Expected digest (case-insensitive, no `0x`). Required. |

### `http-endpoint`
A live network probe: the judge fetches a URL once, at judging time.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `url` | string, up to 2048 characters | the deliverable's URL | Address to probe (http or https only; internal addresses are blocked). A `data:` deliverable has no URL, so give one here or the check fails. |
| `expectStatus` | integer from 100 to 599 | 200 | Required HTTP status. |
| `bodyIncludes` | list of up to 256 strings, each up to 1024 characters | none | Substrings the response body must contain. |
| `timeoutMs` | number from 1 to 10000 | 5000 | Probe timeout in milliseconds. |

This is the one kind that is **not** recomputable later: a URL can change after
the judge probed it. Its pass or fail is recorded inside the signed evidence, so
verifiers can confirm everything else and see what the judge recorded, but they
cannot re-run the probe as the judge saw it. Prefer the other kinds when you can.

## What the judge refuses (it abstains; no verdict, no settlement)

- `checks` missing, not an array, or empty
- a check that is not an object, or an unknown `kind` (for example `code-test`)
- a `weight` that is 0, negative, non-numeric, not finite, or above 1000
- a `passThreshold` that is not an integer from 0 to 100
- `params` that are not an object, or a param of the wrong type or out of range (the
  tables above say what each kind accepts; a param set to `null` counts as absent)
- an unknown param, one the kind does not define (for example `wholeword` instead of
  `wholeWords`), and an unknown field on a check (anything but `kind`, `params` and `weight`,
  for example `param`): a misspelled field would otherwise drop the check's params, and a
  check without params passes almost anything
- a `json` shape that breaks the rules above: an unknown keyword, a keyword without its `type`,
  a bound of the wrong kind, a minimum above its maximum, or more than 128 shapes
- too many checks: the judge takes at most 64 checks, and at most 4 `http-endpoint` checks
- criteria nested deeper than 12 levels
- an object anywhere in the criteria with a member named `__proto__` (JavaScript would drop it
  from the criteria hash, so two different criteria sets could share one hash)
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

A list of records: exactly three teams, each with a name, a website on a domain no other entry
uses, and a contact that is an email address or a URL, with no other fields:

```json
{"version":1,"checks":[{"kind":"json","params":{"shape":{"type":"array","minItems":3,"maxItems":3,"uniqueBy":{"field":"website","key":"domain"},"items":{"type":"object","additionalProperties":false,"required":["name","website","contact"],"properties":{"name":{"type":"string","minLength":1},"website":{"type":"string","format":"url"},"contact":{"anyOf":[{"type":"string","format":"email"},{"type":"string","format":"url"}]}}}}}}]}
```

## Writing good criteria

- Check what can be checked mechanically: format, presence, size, structure, exact files.
- Keep subjective quality (tone, taste, "is this good") out of the criteria; a
  deterministic judge cannot rule on it. Escalate those jobs to a human or a dispute process.
- No JSON needed: the checklist builder at https://judge-protocol-verifier.vercel.app/build writes the
  block from a few plain answers and tests a sample deliverable against it in your browser, with the
  same checks (it runs no `http-endpoint` probe; only the judge does, when it rules).
- Try your criteria against a sample deliverable first: `POST /api/evaluate` or the
  kit's `dryRun()` returns exactly the score the judge would give. The hosted dry run does
  not run `http-endpoint` checks: with one in the criteria, `score` and `pass` come back `null`.
