# Tasks: api-errors

- [x] 1. Replace the catch-all `500 { error: e.message }` with the fixed body `{"error":"internal error"}` and log the full error to stderr; keep 400/413/422 unchanged (Req 1.2, 1.3, 1.4)
- [x] 2. Report a failing chain read in `GET /verdict/:jobId` as `502 {"error":"upstream chain read failed"}`, logging the full error to stderr (Req 1.1, 1.3)
- [x] 3. Make `GET /evidence/:jobId` match only `job-<jobId>-<hex>.json`, so other `job-<jobId>-*` files are ignored and a job with only those gets 404 (Req 2.1, 2.2)
