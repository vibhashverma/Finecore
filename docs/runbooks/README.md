# Runbooks

Every alert in `infra/monitoring/alerts.yml` links to one of these. General rules:

- Find the `request_id` first (response header `x-request-id`, error body or audit log), then search the JSON logs of api, workers and analytics for it.
- **Never edit the ledger.** Corrections are new journals (a reversal or adjustment) posted through the API by finance.
- Keep a timeline from minute one. Every incident ends with a postmortem in `docs/postmortems/`.

| Runbook                                          | Alert / symptom                                    |
| ------------------------------------------------ | -------------------------------------------------- |
| [duplicate-events.md](duplicate-events.md)       | Webhook storm, `WEBHOOK_ANOMALY` alerts            |
| [unbalanced-ledger.md](unbalanced-ledger.md)     | `LedgerInvariantViolated`, FC002 errors            |
| [settlement-mismatch.md](settlement-mismatch.md) | `SETTLEMENT_MISMATCH` / `SETTLEMENT_FAILED` alerts |
| [latency.md](latency.md)                         | `ApiHighLatencyP95`, 503 `UPSTREAM_UNAVAILABLE`    |
| [stuck-jobs.md](stuck-jobs.md)                   | `DeadLetteredJobs`, `OutboxBacklog`                |
| [db-restore.md](db-restore.md)                   | Data loss, corruption, disaster recovery           |
