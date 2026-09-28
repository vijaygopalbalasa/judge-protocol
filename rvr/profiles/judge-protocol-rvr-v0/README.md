# judge-protocol-rvr-v0

An ERC-8404 (Recomputable Verification Receipts) profile for Judge Protocol
rulings on Circle's ERC-8183 contract on Arc testnet. Status: experimental, for
review.

A receipt says whether the deliverable the provider committed to on chain meets
the job's acceptance criteria under the Judge's four deterministic checks
(`length`, `contains`, `schema`, `checksum`), and anyone holding the evidence
closure (a canonical chain snapshot and the deliverable bytes) can recompute it
without reading a chain. `http-endpoint` is outside v0: a recorded probe result
is not a reproduced probe.

`SPEC.md` is the authority. `adapter.py` is an independent, standard-library
Python implementation; it does not import the Judge Protocol service. Its
generic scaffolding is changed from the reference profiles in
pipavlo82/recomputable-verification-receipts (Apache License 2.0).

Run the gate from the package root (the directory holding `profiles/` and
`conformance/`):

```bash
python profiles/judge-protocol-rvr-v0/adapter.py --check
python profiles/judge-protocol-rvr-v0/test_profile.py
```

The base vectors are two real rulings on Arc testnet, frozen at a named block:
job 186779 (PASS, `VERIFIED`) and job 186780 (REJECT, `REFUTED`). The gate
re-derives both and requires the recorded on-chain verdict to agree field by
field, including the keccak256 `criteriaHash` and `evidenceHash`.
