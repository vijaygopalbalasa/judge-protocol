# Judge Protocol kit

One file (`judge-kit.js`, depends only on viem) that plugs Judge Protocol into an
ERC-8183 job on Arc testnet. It is not published to npm: copy it into your project.

```bash
npm ci
CLIENT_KEY=0x... PROVIDER_KEY=0x... node example.js   # the whole flow on Arc testnet, about a minute
npm test                                             # no network, no keys; needs npm ci in ../judge-service first
```

Both keys need a little testnet USDC (Arc uses USDC for gas): https://faucet.circle.com

## What is in it

| Who | Function | What it does |
|---|---|---|
| client | `createJudgedJob({ walletClient, publicClient, provider, criteria, title })` | Creates the job on Circle's ERC-8183 contract with Judge Protocol as the evaluator and the criteria in the description. Refuses criteria the judge would refuse. |
| provider | `setBudget({ ..., jobId, amount })` | Proposes the price (USDC, 6 decimals). |
| client | `fundJob({ ..., jobId, amount })` | Approves USDC and funds the escrow. |
| provider | `submitDeliverable({ ..., jobId, content, uri })` | Commits `keccak256(content)`. Without `uri` the work is inlined as a `data:` URI (up to 48 KB); with `uri` (https or ipfs, at most 1 MB, no credentials) the judge fetches it from there. |
| anyone | `requestRuling({ jobId, submitTx })` | Asks the hosted judge to rule now and retries a temporary failure. An abstention is an error carrying the judge's reason; every other answer comes back as it is, so check `result` (it can be `skipped`, `not-ours` or `closed`, for example). |
| anyone | `waitForRuling({ jobId })` | Polls until the verdict is on chain, or the job can no longer be judged. A network blip or a temporary error just means another poll. |
| anyone | `dryRun({ criteria, content, jobId })` | The exact score and decision the judge would give. Never signs, never settles. |
| anyone | `validateCriteria`, `criteriaBlock`, `extractCriteria`, `criteriaHash`, `deliverable` | The judge's own rules for criteria and deliverables, without any network. |

The kit validates and encodes; it does not score. To recompute a ruling, use the verifier
(https://judge-protocol-verifier.vercel.app) or `node judge-service/src/verify.js <jobId>`.

Guide: [docs/INTEGRATION.md](../docs/INTEGRATION.md). Criteria: [docs/CRITERIA.md](../docs/CRITERIA.md).
