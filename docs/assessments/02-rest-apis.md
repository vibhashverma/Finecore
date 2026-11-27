# Assessment 02: Financial REST APIs

**Status:** complete. 46 operations under `/api/v1`, documented in OpenAPI (`GET /api/v1/openapi.json`, Swagger UI at `/api/docs`).

**Conventions:**

- Response envelopes: `{data, meta.request_id}` on success and `{error:{code,message,details,request_id}}` on error.
- The full error catalog is in `packages/contracts`.
- Cursor pagination on `(created_at, id)`, with `limit` ≤ 100.
- Filters: status, kind and customer.
- Every input is validated with Zod. Amounts are strings of minor units.

**Tests:**

- 75 Supertest/Vitest tests run on real Postgres (`apps/api/test`).
- They include a contract test: every documented operation is routed, requires auth and returns the envelope.
- A Newman smoke run on the real stack: **17 requests, 36 assertions, 0 failures**.

**Evidence:** `evidence/02/newman-run.txt` and `postman/fincore.postman_collection.json` (generated from OpenAPI by `scripts/generate-postman.mjs`).
