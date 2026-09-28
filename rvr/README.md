# ERC-8404 profile

This folder uses the layout of the ERC-8404 reference repository
(pipavlo82/recomputable-verification-receipts), so `profiles/judge-protocol-rvr-v0` can be copied
into that repository unchanged. [`docs/ERC-8404.md`](../docs/ERC-8404.md) explains what the
profile covers and its limits.

- `profiles/judge-protocol-rvr-v0/`: the profile package; its `SPEC.md` is the authority.
- `conformance/rvr-v0/verification-profile-manifest.schema.json`: the ERC's generic manifest
  schema, vendored unchanged under the Apache License 2.0 (`LICENSE-rvr-core-Apache-2.0`).
- `mutants.py`: 112 changes to the adapter, each of which the gate must catch in the case written
  for it. Not part of the package.
- `word_ranges.py`: rebuilds the pinned Unicode 17.0.0 word-character table in `SPEC.md` and the two
  JavaScript copies (the judge's and the verifier's) from the Unicode Character Database, and
  checks that all three match.

Run from this folder, standard library only:

```bash
python3 profiles/judge-protocol-rvr-v0/adapter.py --check
python3 profiles/judge-protocol-rvr-v0/test_profile.py
python3 mutants.py
```
