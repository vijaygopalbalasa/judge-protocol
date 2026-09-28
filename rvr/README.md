# ERC-8404 profile

This folder uses the layout of the ERC-8404 reference repository
(pipavlo82/recomputable-verification-receipts), so `profiles/judge-protocol-rvr-v0` can be copied
into that repository unchanged. [`docs/ERC-8404.md`](../docs/ERC-8404.md) explains what the
profile covers and its limits.

- `profiles/judge-protocol-rvr-v0/`: the profile package; its `SPEC.md` is the authority.
- `conformance/rvr-v0/verification-profile-manifest.schema.json`: the ERC's generic manifest
  schema, vendored unchanged under the Apache License 2.0 (`LICENSE-rvr-core-Apache-2.0`).
- `mutants.py`: 20 changes to the adapter that the gate must catch. Not part of the package.

Run from this folder, standard library only:

```bash
python3 profiles/judge-protocol-rvr-v0/adapter.py --check
python3 profiles/judge-protocol-rvr-v0/test_profile.py
python3 mutants.py
```
