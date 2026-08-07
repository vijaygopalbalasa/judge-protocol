# Judge Protocol — web

A single-page explorer and **in-browser verifier** for Judge Protocol verdicts on Arc testnet.

## Why it exists
The product claim is that a verdict can be recomputed by anyone from public data. This page is the
proof: it takes a job id, reads the job from Circle's canonical ERC-8183 contract, pulls the
**provider's** deliverable out of that provider's own `submit()` transaction calldata, re-derives
every hash locally, re-runs the deterministic checks, and compares the result against the signed
verdict on chain. Seven checks, all shown. If the judge had lied, one would go red.

## Design constraints
- **No build step, no CDN, no backend.** Plain ES modules served as static files.
- **No hand-rolled crypto.** keccak256 is `@noble/hashes` (MIT), the same implementation viem uses,
  vendored into `vendor/noble/` with one bare import rewritten for the browser.
- **No `innerHTML`.** Job descriptions and RPC errors are attacker-controlled strings, so all
  rendering goes through `textContent` helpers in `ui.js`, and links are origin-checked.
- A CSP in the page head restricts `connect-src` to the Arc RPC and blocks inline script.

## Run
```
python3 -m http.server 8787 --directory web
```
Then open http://localhost:8787 and verify job `171507` (PASS) or `170856` (REJECT).

## Files
| File | Purpose |
|---|---|
| `index.html` | markup, styles, CSP |
| `main.js` | page wiring and safe rendering |
| `app.js` | RPC, ABI decoding, criteria/evidence hashing, the verification routine |
| `ui.js` | textContent-only DOM helpers, origin-checked links |
| `vendor/noble/` | vendored `@noble/hashes` keccak256 (MIT, license included) |

## Known limits
- The public RPC caps `eth_getLogs` at 20k blocks, so the automatic deliverable lookup walks back
  ~6 windows. For older jobs the page asks you to paste the deliverable, and still refuses it unless
  it hashes to the on-chain commitment.
- The `checksum` and `http-endpoint` checkers are not reproduced in-browser (one needs sha256, the
  other is a live probe and so not reproducible by design). Jobs using them verify via the CLI.
