# ERC-8412 reference vectors

Copied unchanged from the ERC-8412 reference implementation by Richard (@richard7463),
`assets/erc-8412/vectors/` at commit `ff9fbc7e2de497d3dec2595a90b262aecd576f5d` of
https://github.com/ethereum/ERCs/pull/2002. They are CC0, like the specification.

- `offchain/*.json`: the 23 complete document packages (chain state, criteria document,
  evidence bundle, attestation document) with the violations a conforming checker must report.
- `onchain-ID.json`, `onchain-meta.json`: the `preregistrationId` formula case and its actors.
- `reference-digests.json`: the keccak256 of the JCS form of every document in every package,
  computed by the reference Python code (`model/ethcrypto.py`, `doc_digest`), so our independent
  JavaScript canonicalization is checked against theirs byte for byte:

```python
from ethcrypto import doc_digest   # run from assets/erc-8412 with model/ on sys.path
{case["name"]: {k: doc_digest(case[k]) for k in ("criteria", "bundle", "attestation")}}
```

- `reference/verifier/verify.py`, `reference/model/{ethcrypto,registry}.py`: the reference
  off-chain verifier and the model code it imports, unchanged, so the tests can run the
  packages our profile emits through the ERC's own verifier (when `python3` is available).
