# Requirements: the Judge HTTP API never leaks upstream errors

## Introduction
`src/http.js` answers every unexpected error with `500 { error: e.message }`. When the chain RPC fails, viem's error message includes the RPC URL, and `ARC_RPC_URL` can carry a provider API key, so a caller of `GET /verdict/:jobId` can read it. Separately, `GET /evidence/:jobId` serves any file starting `job-<id>-`, so a sibling such as `job-186820-arbitration.json` can be served as the job's evidence.

## Requirement 1: Upstream failures say nothing about the upstream
**User story:** As the operator of a Judge API, I want RPC failures reported without their details, so that a caller can never read my RPC URL or its key.
### Acceptance criteria
1. WHEN reading the chain fails while answering `GET /verdict/:jobId` THE SYSTEM SHALL respond 502 with the fixed body `{"error":"upstream chain read failed"}`, containing no URL, host, key or text from the upstream error.
2. WHEN any other unexpected error happens while answering a request THE SYSTEM SHALL respond 500 with the fixed body `{"error":"internal error"}`, containing no text from the error.
3. WHEN either of those happens THE SYSTEM SHALL write the full error to the server log (stderr), so the operator can still debug it.
4. WHEN a request fails with an error the API raises on purpose (invalid criteria 422, body too large 413, bad input 400) THE SYSTEM SHALL keep its current status and message.

## Requirement 2: Evidence is the job's evidence file and nothing else
**User story:** As a verifier, I want `GET /evidence/:jobId` to serve only that job's evidence files, so that I never re-check the wrong document.
### Acceptance criteria
1. WHEN `GET /evidence/:jobId` looks for files THE SYSTEM SHALL consider only names of the form `job-<jobId>-<hash>.json`, where `<hash>` is hexadecimal, and SHALL ignore other files that start with `job-<jobId>-` (for example `job-<jobId>-arbitration.json`).
2. WHEN only such other files exist for a job THE SYSTEM SHALL respond 404 as it does when no evidence exists.
