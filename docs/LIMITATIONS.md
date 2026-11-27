# Known limitations, mocks and simulations

Anything listed here is labelled `SIMULATED`, `MOCK` or `SANDBOX` in code and UI.

## Simulated by design (educational scope)

| Item                   | Status                            | Notes                                                                                                                             |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| All balances and funds | SIMULATED                         | Demo money comes from the `SIMULATED_FUNDING` account or SIMULATED card top-ups                                                   |
| Customers / KYC        | SIMULATED                         | Synthetic people on `.test` emails; `kyc_status` is simulated                                                                     |
| Payment provider       | SIMULATED (+ Stripe test adapter) | `SimulatedProvider` is used everywhere. `StripeTestProvider` (sk_test_ only) is **not exercised**: it needs a Stripe test account |
| Card details           | none                              | Only named test payment methods (`pm_simulated_success` / `pm_simulated_decline`); no card numbers anywhere                       |
| Email                  | SANDBOX                           | Mailpit catches all mail                                                                                                          |
| SMS                    | MOCK                              | Logs a redacted line only                                                                                                         |
| MFA delivery           | SIMULATED                         | Real RFC 6238 TOTP. Seed users share a documented demo secret; the dev-code endpoint exists only in development/test              |
| FX                     | Out of scope                      | Each transaction is single-currency (enforced by a composite FK)                                                                  |
| Risk scores            | Decision support                  | Rule-based, tuned on synthetic data; never proof of fraud                                                                         |

## Environment gaps (honest status)

| Gap                                                         | Impact / plan                                                                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Docker not installed** on the dev machine                 | The Compose stack, Dockerfiles, Trivy and graceful-shutdown checks have **not been run**. They run in CI's `compose-smoke` job once the repo is pushed                   |
| **Repo not on GitHub yet**                                  | CI/CD, rulesets, signed releases and the hotfix flow are written but **not evidenced**. Push, apply the rulesets, then capture runs into `evidence/10` and `evidence/11` |
| **No VM / domain**                                          | HTTPS, firewall, monitoring dashboards and on-VM backups are prepared (`infra/deploy`) but **not deployed**. The restore drill **was** run locally (`evidence/14`)       |
| Testcontainers replaced by embedded PostgreSQL 16 (ADR-005) | Same engine and role model, with no Docker required                                                                                                                      |
| BullMQ replaced by a Postgres outbox queue (ADR-009)        | Redis is used only for rate limiting (in-memory fallback when absent: single instance only)                                                                              |
| Embedded-postgres Linux binaries have not yet run in CI     | Verified on Windows only so far                                                                                                                                          |
| Single maintainer                                           | Ruleset requires 0 approvals; CODEOWNERS uses a placeholder handle                                                                                                       |
| Caddy runs as root; images use some floating tags           | Harden with non-root Caddy and digest pinning                                                                                                                            |
| Database passwords are passed as env vars in Compose        | Move to Docker secrets or `_FILE` variables                                                                                                                              |

## Design trade-offs accepted

- `state_transitions.entity_id` and `transactions.reference_id` are polymorphic, so they have no foreign key (ADR-007).
- The invariant check does full scans, and audit writes are serialised by one lock. Both are fine at this scale (ADR-006).
- Disputes only move money for transfers. Disputes on payment intents can be recorded, but no chargeback money flow is modelled.
- Interest is calculated (analytics, ACT/365) but no scheduled interest-posting job exists. The calculation endpoint and its tests are complete.
- A statement for an open month is a snapshot; a new snapshot is created when new entries arrive.
- A TOTP code is reusable within its 30 s window (single-use challenges and attempt limits mitigate this).
- Starlette warns that `httpx` with `TestClient` is deprecated in favour of `httpx2`.
