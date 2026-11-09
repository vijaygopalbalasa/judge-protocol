# Design: the Judge HTTP API never leaks upstream errors

All changes are in `src/http.js`. No new dependencies, no new files in `src/`.

## Error handling (Req 1)

- Wrap the `client().readContract(...)` call in `GET /verdict/:jobId` in its own `try/catch`. On failure, log the original error and `send(502, { error: "upstream chain read failed" })`. Only the read is wrapped, so a failure after the read (for example while shaping the response) is still a 500.
- Change the outer `catch` so its fallback is `send(500, { error: "internal error" })` instead of `e.message`, and log the original error first.
- The deliberate errors keep their branches in the outer `catch` and in the route handlers: `InvalidCriteriaError` (422), `statusCode === 413`, and the 400 responses. Their bodies are unchanged.
- Logging uses `console.error`, which writes to stderr. The log line includes the method, the path and the full error (stack when present). The caller never sees it.
- Logging happens in both fixed-body cases, and only there. Deliberate errors are not logged as failures.

## Evidence lookup (Req 2)

- Replace the `startsWith("job-<id>-") && endsWith(".json")` filter with an anchored match: `^job-<jobId>-[0-9a-fA-F]+\.json$`. `jobId` is already validated as digits only by `parseJobId`, so it is safe to interpolate into the pattern.
- The rest is unchanged: newest matching file by mtime wins, no match gives the existing 404 body.

## Verification

- Contracts live in `contracts/api-errors/*.contract.test.js`, one `node:test` test per acceptance criterion, named `R<n>.<m> ...`.
- Each contract starts `createJudgeApi` on port 0, calls it with `fetch`, uses a stub `publicClient` and a temp `evidenceDir`. None of them touches a real RPC or key.
- Run them with `node --test contracts/api-errors/*.contract.test.js`. They are not part of `npm test`, whose glob is `test/*.test.js`.
- R1.3 is checked by wrapping `process.stderr.write` for the duration of a request.

## Out of scope

- Redacting other fields (`/healthz` exposes `judge` and `acp` addresses by design).
- Changing the 503 for a missing `JUDGE_ADDRESS`, or the 404 route list.
