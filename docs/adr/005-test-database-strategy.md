# ADR-005: Test database strategy (embedded PostgreSQL instead of Testcontainers)

- Status: Accepted (2026-11-27, Phase 2; the user asked to proceed without Docker)
- Date: 2026-11-27

## Context

The brief lists Testcontainers for real-Postgres integration tests. The development machine has no Docker, and the user asked to proceed without it. Mocking the database is not acceptable here: the ledger's guarantees live in triggers, deferred constraints, column grants and roles, which only a real PostgreSQL server enforces.

## Options

| Option                               | Real Postgres 16?                                   | Needs Docker? | Notes                                                                       |
| ------------------------------------ | --------------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| Testcontainers                       | Yes                                                 | Yes           | The original plan. Blocked on this machine.                                 |
| The developer's system Postgres (18) | No (wrong major version)                            | No            | Needs the superuser password. Test roles would be left on a shared cluster. |
| PGlite (WASM)                        | Partial                                             | No            | Single-user, so roles and GRANTs can't be tested meaningfully. Rejected.    |
| **embedded-postgres 16.16**          | **Yes** (official binaries, packaged per OS on npm) | No            | A throwaway cluster per test run, started as a normal user process.         |

## Decision

Use `embedded-postgres` (pinned to `16.16.0-beta.19`; "beta" is the npm wrapper's version label, the PostgreSQL binaries are the official 16.16 release).

- `packages/db/src/testing.ts` starts a fresh cluster in a temp directory on a free port.
- It initialises the cluster with `--encoding=UTF8 --locale=C`, the same as the Docker image.
- It runs the **same** `db/bootstrap/roles.sql` as the container (psql variables rendered safely), then applies migrations with **dbmate** as `fincore_owner`.
- Tests connect as the restricted runtime role `fincore_api`.
- The same harness powers `pnpm db:local`: a persistent local database for development without Docker.

## Consequences

- DB tests run identically on Windows, Linux CI and macOS, and they test what production runs: Postgres 16 with the real roles and grants.
- The first run downloads around 30 MB of binaries per OS, which pnpm caches.
- Redis-dependent integration tests (Phase 4 onward) still need a real Redis. With no Docker available, CI will use a GitHub Actions service container for Redis. If Docker is installed later, Testcontainers can be added without changing any test, because tests only consume connection URLs.
