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

Planned for later phases:

- 008 Idempotency storage
- 009 Outbox and jobs
- 010 Payment provider adapter
- 011 Rounding and day-count conventions
- 012 Risk scoring model
- 013 Hosting
- 014 Backup strategy
