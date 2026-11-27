# Architecture Decision Records

Format: Context → Options → Decision → Consequences. Status is one of `Proposed`, `Accepted`, `Superseded by NNN`.

| #                                              | Title                                                                  | Status   |
| ---------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| [001](001-money-representation.md)             | Money representation                                                   | Accepted |
| [002](002-database-access-and-migrations.md)   | Database access layer and migrations                                   | Accepted |
| [003](003-transfer-concurrency-control.md)     | Transfer concurrency control                                           | Accepted |
| [004](004-authentication-and-session-model.md) | Authentication and session model                                       | Accepted |
| [005](005-test-database-strategy.md)           | Test database strategy (embedded PostgreSQL instead of Testcontainers) | Accepted |
| [006](006-database-enforced-integrity.md)      | Database-enforced ledger integrity, roles and tamper-evident audit     | Accepted |
| [007](007-database-state-machines.md)          | State machines enforced in the database                                | Accepted |
| [008](008-idempotency-storage.md)              | Idempotency storage (Postgres, atomic with the ledger)                 | Accepted |
| [009](009-outbox-and-jobs.md)                  | Transactional outbox as a Postgres job queue                           | Accepted |
| [010](010-payment-provider-adapter.md)         | Payment provider adapter (SIMULATED + Stripe test mode)                | Accepted |
| [011](011-rounding-and-day-count.md)           | Rounding and day-count conventions                                     | Accepted |
| [012](012-risk-scoring-model.md)               | Explainable rule-based risk scoring                                    | Accepted |
| [013](013-hosting.md)                          | Hosting (single hardened VM + Compose + Caddy)                         | Accepted |
| [014](014-backup-strategy.md)                  | Encrypted backups and timed restore drills                             | Accepted |
