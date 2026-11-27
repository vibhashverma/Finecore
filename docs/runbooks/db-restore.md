# Runbook: database restore (disaster recovery)

**Targets:**

- **RPO ≤ 24 h.** Backups are daily and encrypted. WAL archiving (pgBackRest) would tighten this further.
- **RTO ≤ 30 min.**

A drill on the demo dataset measured **5.3 s** to restore (`evidence/14/restore-drill.txt`).

**Steps:**

1. Stop the writers with `docker compose stop api workers`. Caddy keeps serving the UI; API calls return 502.
2. Pick a backup from `/opt/fincore/backups` and verify it with `sha256sum -c <file>.sha256`.
3. **Drill first.** `scripts/restore-drill.sh` restores into a scratch database, then runs the invariant check and audit-chain verification.
   - Use client tools whose major version matches the server: run them inside the postgres:16 container.
   - The first drill failed because pg_restore 18 was used against Postgres 16.
4. **Real restore into a fresh cluster:**
   1. Run the role bootstrap (`db/bootstrap/roles.sql`).
   2. `pg_restore` into `fincore`.
   3. Run `scripts/invariant-check.sql`.
   4. Run `SELECT * FROM audit_log_verify_chain()`.
5. **Restart api and workers.** Workers drain the outbox. Webhooks sent after the backup point are redelivered by the provider, and deduplication makes that safe.
6. **Reconcile the RPO window** with the provider: reconcile the settlements dated after the backup timestamp.
