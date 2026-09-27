# Judge Protocol: web

A single-page explorer and **in-browser verifier** for Judge Protocol verdicts on Arc testnet.

## Why it exists
The product claim is that a verdict can be recomputed by anyone from public data. This page is the
proof: it takes a job id, reads the job from Circle's canonical ERC-8183 contract, pulls the
**provider's** deliverable out of that provider's own `submit()` transaction calldata, re-derives
every hash locally, re-runs the deterministic checks, and compares the result against the signed
verdict on chain. Nine checks, all shown. If the judge lied about anything the page can recompute, a
check goes red; anything it cannot recompute (a live `http-endpoint` probe, or a deliverable it could
not load) shows as NOT REPLAYABLE HERE or INCOMPLETE, never VERIFIED. The command-line verifier,
`node judge-service/src/verify.js <jobId>`, runs this same code.

## Design constraints
- **No build step, no CDN.** Plain ES modules served as static files. On the deployed site, chain
  reads pass through `api/rpc.js`, a read-only same-origin relay; open the page with `?rpc=direct`
  (or serve it locally) to read the Arc RPC straight from your browser instead.
- **No hand-rolled crypto.** keccak256 is `@noble/hashes` (MIT), the same implementation viem uses,
  vendored into `vendor/noble/` with one bare import rewritten for the browser.
- **No `innerHTML`.** Job descriptions and RPC errors are attacker-controlled strings, so all
  rendering goes through `textContent` helpers in `ui.js`, and links are origin-checked.
- A CSP in the page head restricts `connect-src` to the page's own origin (the `/api/rpc` read-only
  relay used when deployed) and the Arc RPC (used locally or with `?rpc=direct`), and blocks inline
  script.

## Run
```
python3 -m http.server 8787 --directory web
```
Then open http://localhost:8787 and verify job `171925` (PASS) or `170856` (REJECT).

## Files
| File | Purpose |
|---|---|
| `index.html` | markup, styles, CSP |
| `main.js` | page wiring and safe rendering |
| `app.js` | RPC, ABI decoding, criteria/evidence hashing, the verification routine |
| `present.js` | what the page says for each outcome (pure, unit-tested) |
| `measurement.js` | the market measurement table (kept in sync with `judge-service/acp-measurement.json` by a test) |
| `ui.js` | textContent-only DOM helpers, origin-checked links |
| `api/rpc.js` | same-origin, read-only JSON-RPC proxy (method allowlist, no batches, 16KB body cap) |
| `vendor/noble/` | vendored `@noble/hashes` keccak256 (MIT, license included) |
| `test/` | `node --test 'web/test/*.test.mjs'` from the repo root: CSP, proxy, public copy, and the verifier run against a fake chain built from recorded Arc testnet data, including tampered inputs that must never verify |

## Known limits
- Every verdict is bound to the provider's own on-chain commitment (the bytes32 in their
  `submit()` and its `JobSubmitted` log), not just to whatever content the page was shown.
- The public RPC refuses `eth_getLogs` ranges wider than 10,000 blocks and no longer serves older
  transactions by hash. So the page finds the block near the verdict's own timestamp, searches back
  from one window past it in 5,000-block windows (about 8 hours of chain), and loads the provider's
  `submit()` by block number and index. If the submission cannot be found or read, the result shows
  INCOMPLETE with the reason, and never VERIFIED.
- Deliverables at `https://` or `ipfs://` URIs are not fetched by the page. Paste the content or
  choose the file to finish; it only counts if it hashes to the provider's commitment. A chosen file
  is hashed as its exact bytes (binary content, or text whose line endings a text box would change).
- `checksum` (sha256) is recomputed in the browser. `http-endpoint` is a live network probe that
  cannot be replayed. Its recorded pass bit is inside the signed evidence, so the page tries both
  outcomes: if one reproduces the verdict, everything else is verified and the page says what the
  judge recorded (NOT REPLAYABLE HERE); if neither does, the verdict is a MISMATCH.
- The browser checkers and criteria validation mirror `judge-service` exactly; a parity test runs
  both implementations on the same inputs so they cannot drift.
