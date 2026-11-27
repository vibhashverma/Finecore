# ADR-002: Database access layer and migrations

- Status: Accepted (2026-11-27, Phase 0 review)
- Date: 2026-11-27

## Context

The ledger depends on PostgreSQL features that many ORMs hide or fight:

- `SELECT … FOR UPDATE` with deterministic ordering;
- explicit transactions with `SET LOCAL lock_timeout`, savepoints and retry on SQLSTATE `40001`/`40P01`;
- deferred constraint triggers;
- composite FKs;
- per-role GRANTs (no UPDATE/DELETE on `ledger_entries`);
- views for the analytics read-only role.

Migrations must be reviewable by a human (CODEOWNERS, Assessment 10) and must never be edited after they are applied.

## Options

| Option                                                      | Fit                                                                                                                                                                                                                                     | Problems                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma                                                      | Great DX, typed client                                                                                                                                                                                                                  | Row locks need `$queryRaw`. Interactive transactions have timeouts and limited isolation control. Its schema language can't express triggers or grants, so these end up as hand-edited SQL beside generated migrations, with drift risk. Heavy engine binary in images. |
| Drizzle                                                     | Typed, SQL-like, has `.for('update')`                                                                                                                                                                                                   | Migrations are generated from TS schema diffs, so triggers and grants still live outside the model. A younger migration story.                                                                                                                                          |
| TypeORM / Sequelize                                         | Mature ORMs                                                                                                                                                                                                                             | Active-record style encourages implicit writes. Weak typing (Sequelize). Not suited to ledger code.                                                                                                                                                                     |
| Raw `pg`                                                    | Full control                                                                                                                                                                                                                            | No compile-time column/type checking, so typos show up only at runtime.                                                                                                                                                                                                 |
| **Kysely + plain-SQL migrations (dbmate) + kysely-codegen** | Type-safe query builder that is "just SQL": `.forUpdate()`, `.orderBy()`, `sql\`\`` escape hatch, first-class transactions with isolation level. The DB is the source of truth, and codegen produces TS types from the migrated schema. | Not an ORM: no relation loading magic. That is a plus here, because it makes N+1 queries visible. Codegen is one extra step.                                                                                                                                            |

## Decision

1. **Kysely** on `pg` (node-postgres) for api and workers, with no ORM.
   - Repositories live per module (`modules/ledger/ledger.repo.ts`).
   - A single `withTransaction(fn, {isolation, retries})` helper owns retry-on-serialization/deadlock.
2. **dbmate** with plain `.sql` migrations in `db/migrations/`. Each file has `-- migrate:up` and `-- migrate:down` sections, a timestamped name, and is forward-only in prod.
   - dbmate is available as an npm package and a Docker image, so it works in Compose, CI and on the VM.
3. **kysely-codegen** runs against a Testcontainers/Compose DB after migrating and generates `packages/db-types`. CI fails if the generated types differ from the committed ones, which catches schema drift.
4. **Python analytics** uses `psycopg` 3 (async pool) with hand-written parameterised SQL against `analytics.*` views only, through a read-only role. It has no ORM, because it never writes.

## Consequences

- Reviewers see exactly the DDL that runs, including triggers and GRANTs, which is ideal for migration review.
- Developers must write SQL-shaped code. This is acceptable and makes `EXPLAIN ANALYZE` work straightforward.
- A CI check refuses any change to a migration file that already exists on `main`.
