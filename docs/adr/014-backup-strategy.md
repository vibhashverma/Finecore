# ADR-014: Backup strategy

- Status: Accepted (Phase 11)
- Date: 2026-11-28

**Decision.**

- A daily logical backup, `pg_dump -Fc`, run **inside the postgres:16 container** so client and server major versions match.
- Encrypted with **gpg AES-256** (symmetric passphrase in `/etc/fincore/backup.pass`, root 0600) plus a SHA-256 checksum.
- Retained for 14 days, with an off-host copy to versioned object storage recommended.
- A **timed restore drill** (`scripts/restore-drill.sh`) restores into a scratch database and verifies:
  - the checksum;
  - ledger invariants;
  - the audit hash chain;
  - row counts and totals against the source.

**Targets.** RPO ≤ 24 h and RTO ≤ 30 min. The local drill measured **5.3 s** of restore time.

**Lesson recorded.** The first drill failed: pg_restore 18 against a PostgreSQL 16 server emits `SET transaction_timeout`, which 16 rejects. The script now warns on version skew, and production always uses the server's own tools.

**Upgrade path.** pgBackRest or WAL-G for point-in-time recovery (RPO in minutes), when a managed object store is available.
