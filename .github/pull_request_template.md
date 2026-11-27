## What and why

<!-- One or two sentences. Link the issue or assessment (e.g. Assessment 07). -->

## Type

- [ ] feat
- [ ] fix / hotfix
- [ ] refactor / chore
- [ ] docs
- [ ] migration (complete the migration checklist below)

## Checklist

- [ ] Tests added or updated: success path, invalid input, auth/boundary, at least one failure path
- [ ] Server-side validation; errors use the catalog; no stack traces or secrets in responses or logs
- [ ] No floats for money; amounts are `bigint` minor units / `Decimal`
- [ ] Anything mocked or simulated is labelled `SIMULATED`/`MOCK` and listed in `docs/LIMITATIONS.md`
- [ ] Docs updated (assessment doc, ADR if the decision is non-obvious, API spec if the contract changed)
- [ ] No secrets committed (`.env` untouched; gitleaks green)

## Ledger / money changes (fill in if this touches ledger, transfers, payments, refunds or calculations)

- [ ] Global ledger invariant check passes after the new tests
- [ ] Idempotency and retry behaviour considered
- [ ] Lock ordering / concurrency impact explained

## Migration review (fill in if `db/migrations/` changed)

- [ ] New file only. No edits to an already-applied migration
- [ ] Forward-safe on a populated database (no table rewrites or long locks without a plan)
- [ ] `down` section present, or irreversibility justified
- [ ] Grants for app / worker / analytics_ro roles reviewed; no UPDATE/DELETE on `ledger_entries`
- [ ] Indexes justified by a query (attach `EXPLAIN ANALYZE` when performance-motivated)

## Evidence

<!-- Test output, screenshots, or the CI run link. -->
