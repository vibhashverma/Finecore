# ADR-006: Database-enforced ledger integrity, least-privilege roles and tamper-evident audit

- Status: Accepted (2026-11-27, Phase 2)
- Date: 2026-11-27

## Context

The brief treats ledger balance, append-only entries and authorization as non-negotiable: "a high score does not offset a data-integrity failure". Application code has bugs. The question is which rules must hold **even if the API is wrong**.

## Decision

Each rule is enforced in PostgreSQL, so that no application path, retry or race can violate it. Most rules have two independent layers.

| Rule                                     | Layer 1                                                                                      | Layer 2                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Σ debits = Σ credits, ≥ 2 lines          | Deferred constraint trigger on `transactions`, checked at COMMIT                             | `ledger_invariant_violations()` in CI and monitoring                                            |
| Ledger rows can't be changed or deleted  | App role has no UPDATE/DELETE grant                                                          | `forbid_mutation()` triggers, which also stop the schema owner, plus TRUNCATE triggers          |
| No late lines appended to an old journal | `transactions.db_xact = pg_current_xact_id()`, checked per line                              |                                                                                                 |
| Currency consistency                     | Composite FKs `(account_id, currency)` and `(transaction_id, currency)`                      |                                                                                                 |
| Reversal at most once, and exact         | UNIQUE `reverses_transaction_id`                                                             | Deferred mirror check (FC004); invariant #6                                                     |
| No overdraft                             | `CHECK (posted − held ≥ floor)` on `account_balances`, maintained by triggers                | The app's lock-and-check in Phase 4 (ADR-003)                                                   |
| Balances can't be forged                 | App role has only `UPDATE(version)` on `account_balances` (enough for `SELECT … FOR UPDATE`) | Balance triggers are `SECURITY DEFINER` with a pinned `search_path`                             |
| Passwords never plaintext                | `CHECK (password_hash LIKE '$argon2id$%')`                                                   | Argon2id hashing in the app                                                                     |
| State machines                           | `state_machine_transitions` table plus `enforce_state_transition()` (ADR-007)                |                                                                                                 |
| Audit trail tamper-evident               | Append-only grants and triggers                                                              | SHA-256 hash chain; `audit_log_verify_chain()` detects edits and deletions, even by a superuser |

**Roles** (created by `db/bootstrap/roles.sql`; privileges granted by migrations):

- `fincore_owner` owns the schema. Only the migration job logs in as it.
- `fincore_app` is a NOLOGIN group, with `fincore_api` and `fincore_workers` as its login members. It has the column-level grants listed in migration `…001000_grants.sql`. Runtime logins have `statement_timeout` and `idle_in_transaction_session_timeout` set.
- `fincore_analytics_ro` is a NOLOGIN group, with `fincore_analytics` as its login member. It has nothing yet (it will get views in Phase 6), and `default_transaction_read_only = on`.
- `PUBLIC` has no schema or table access.

**Custom SQLSTATEs**, so the API can map them precisely:

| SQLSTATE | Meaning                                  |
| -------- | ---------------------------------------- |
| FC001    | Append-only table modified               |
| FC002    | Journal unbalanced or has too few lines  |
| FC003    | Line added after the journal was created |
| FC004    | Invalid reversal                         |
| FC005    | Immutable column changed                 |
| FC006    | Invalid state transition                 |
| FC007    | Invalid wallet account                   |

The overdraft CHECK raises `23514` with constraint `available_not_below_floor`.

**Audit chain.** A per-database advisory lock serialises audit inserts until commit. Under it, `chain_seq` is assigned as previous + 1, and `hash = sha256(prev_hash || jsonb_build_array(row…))`. The audit insert must be the **last** statement of a transaction, so the global lock is held only briefly and never inverts the lock order.

## Consequences

- Correctness doesn't depend on every code path remembering a rule. Tests in `packages/db/test` prove each rule against the restricted runtime role.
- Some logic lives in PL/pgSQL. This is mitigated by keeping it small and commented, covered by tests, and reviewed through the CODEOWNERS path on `db/migrations/`.
- Costs:
  - The overdraft CHECK is evaluated per line, so a journal must not _transiently_ overdraw an account. Lines for the same wallet should credit before they debit (documented for the Phase 4 posting service).
  - Audit writes are serialised globally. That's acceptable at this scale; at higher scale, chaining would move to an async sealing job.
  - The invariant function does full scans. That's fine for this dataset and CI; at scale it would become incremental, checkpointed by entry id.
- A superuser can still disable triggers. That is outside the threat model the app can control, but the audit hash chain makes such tampering **detectable**, and production keeps superuser credentials out of every service.
