# Assessment 13: Financial API contracts

**Status:** complete.

- **OpenAPI 3.1:** generated from the same Zod schemas the API uses to validate requests (`apps/api/src/openapi.ts`). Served at `/api/v1/openapi.json`, with Swagger UI at `/api/docs`. The analytics service has its own spec at `/analytics/v1/openapi.json`.
- **Contract test** (`apps/api/test/ops.test.ts`): every documented operation is routed, requires authentication, and returns the error envelope.
- **Written guide:** [../API.md](../API.md) covers the transaction lifecycle, ledger semantics, idempotency, error codes, webhook signatures, pagination, statement exports and test-mode setup.
