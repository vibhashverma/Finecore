# Architecture Decision Records

Format: Context → Options → Decision → Consequences. Status is one of `Proposed`, `Accepted`, `Superseded by NNN`.

| #                                              | Title                                | Status   |
| ---------------------------------------------- | ------------------------------------ | -------- |
| [001](001-money-representation.md)             | Money representation                 | Accepted |
| [002](002-database-access-and-migrations.md)   | Database access layer and migrations | Accepted |
| [003](003-transfer-concurrency-control.md)     | Transfer concurrency control         | Accepted |
| [004](004-authentication-and-session-model.md) | Authentication and session model     | Accepted |

Planned for later phases:

- 005 Idempotency storage
- 006 Outbox and jobs
- 007 Polymorphic state history
- 008 Payment provider adapter
- 009 Rounding and day-count conventions
- 010 Risk scoring model
- 011 Hosting
- 012 Backup strategy
