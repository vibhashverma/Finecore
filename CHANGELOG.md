# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-28

### Added

- Auth: Argon2id, RFC 6238 TOTP (SIMULATED delivery), EdDSA JWT cookies, rotating refresh with reuse detection, step-up, CSRF, lockout and rate limits, audited RBAC.
- Transfer engine: idempotent, ordered locking, Decimal fees, fail-safe risk review with holds, reversals.
- Payments: SIMULATED provider plus Stripe test adapter, signed and deduplicated webhooks, refunds, settlements, reconciliation into suspense.
- Disputes, statements (CSV/PDF), risk alert workflow, audit log, failed-job replay, admin roles.
- Postgres outbox job queue (workers); OpenAPI 3.1; Postman collection with Newman smoke.
- Analytics: Decimal fees, interest, statements and reconciliation; explainable risk; synthetic data; benchmark.
- Web: customer and ops dashboards; Playwright + axe E2E on the real stack.
- Capstone and incident scripts with invariant proofs; runbooks; postmortems.
- CI: scans, E2E, Trivy. Release: signed images, staging, approval, production, rollback.
- Deploy: VM provisioning, backups, restore drill, monitoring and alerts.
- ADR-008 to ADR-014.

## [0.2.0] - 2026-11-27

### Added

- Double-entry ledger schema (10 dbmate migrations): currencies, roles, users, customers, accounts, account balances, wallets, transactions, ledger entries, holds, settlements, state history, hash-chained audit log.
- Integrity enforced in PostgreSQL:
  - a deferred balanced-journal check;
  - append-only triggers plus grants;
  - a same-transaction line rule;
  - exact-mirror single reversals;
  - an overdraft CHECK on trigger-maintained balances;
  - DB-enforced state machines with automatic history;
  - a tamper-evident audit chain.
- Least-privilege role bootstrap (owner, app, analytics read-only) and column-level grants.
- `ledger_invariant_violations()`, `scripts/invariant-check.sql`, `scripts/ledger-proof.sql`.
- `@fincore/db`: bigint-safe pool, SQLSTATE catalog, embedded PostgreSQL 16 harness, idempotent synthetic seed, Kysely codegen with drift check, `db:local`.
- 59 DB tests on real PostgreSQL 16, run as the app role, with a global invariant check after every test.
- Compose: role bootstrap, `migrate` one-shot service; the API connects as `fincore_api`.
- CI: migration immutability guard, codegen drift check, invariant check in the compose smoke test.
- ADR-005 (embedded Postgres), ADR-006 (DB-enforced integrity), ADR-007 (DB state machines).

## [0.1.0] - 2026-11-27

### Added

- Phase 0 plan, ERD and ADRs 001–004 (money representation, data access, concurrency, auth).
- pnpm + Turborepo monorepo: `apps/api`, `apps/workers`, `apps/web`, `packages/contracts`, `services/analytics`.
- API skeleton: request ids, structured logs with redaction, error envelope and catalog, health/readiness/metrics, graceful shutdown.
- Workers skeleton: BullMQ system queue, health server, graceful drain.
- Web skeleton: Next.js App Router with a persistent SIMULATED FUNDS banner.
- Analytics skeleton: FastAPI with the same envelope, request ids, health and metrics.
- Docker images (multi-stage, non-root), Compose stack with isolated internal networks, Caddy single origin.
- CI: commitlint, lint/typecheck/test/build, Python checks, gitleaks, compose smoke test.
- Governance: CODEOWNERS, PR template with a migration checklist, rulesets, Conventional Commits.
