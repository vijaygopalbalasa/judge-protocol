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
re-derives both and requires each recorded on-chain verdict to agree on the
seven fields a derivation can check (all but the signing timestamp), including
the keccak256 `criteriaHash` and `evidenceHash`.

## Unicode data

The word-character table in `SPEC.md` section 10 is derived from the Unicode
Character Database 17.0.0 (`extracted/DerivedGeneralCategory.txt`) and is used
under the Unicode License V3, whose notice follows.

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```
