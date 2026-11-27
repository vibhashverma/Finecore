# Known limitations, mocks and simulations

This list is kept current every phase. Anything here is labelled `SIMULATED` or `MOCK` in code and UI.

## Simulated by design (educational scope)

| Item                             | Status                | Notes                                                                                              |
| -------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| All balances and funds           | SIMULATED             | No real money. Demo funding comes from a labelled `SIMULATED_FUNDING` equity account (Phase 2).    |
| Customer identities / KYC        | SIMULATED             | Synthetic data only; `kyc_status` is simulated.                                                    |
| Email delivery                   | SANDBOX               | Mailpit catches all mail; nothing is delivered.                                                    |
| SMS delivery                     | MOCK                  | An adapter logs the message (redacted); no SMS provider.                                           |
| Payment provider                 | SIMULATED + test mode | A local simulator with failure injection, plus a Stripe **test-mode** adapter (Phase 7).           |
| MFA delivery                     | SIMULATED             | Real RFC 6238 TOTP. The dev-only `GET /auth/mfa/dev-code` endpoint exists only outside production. |
| FX / multi-currency transactions | Out of scope          | Each transaction is single-currency (enforced by a composite FK).                                  |

## Current gaps (updated in Phase 2)

| Gap                                                                                                                                                                                                                                    | Planned                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Docker is not installed on the dev machine. DB tests and local dev use embedded PostgreSQL 16 instead (ADR-005); the Compose stack (including the `migrate` service and role bootstrap) is verified only by the CI `compose-smoke` job | Once Docker Desktop with WSL2 is installed                         |
| Testcontainers (named in the brief) is replaced by embedded PostgreSQL 16, which also runs real Postgres                                                                                                                               | ADR-005; can be added if Docker becomes available                  |
| The embedded-postgres Linux binaries have not yet run on a CI runner                                                                                                                                                                   | Verified by the first CI run after pushing                         |
| `state_transitions.entity_id` and `transactions.reference_id` are polymorphic (no FK)                                                                                                                                                  | Accepted trade-off (ADR-007)                                       |
| The invariant check does full table scans; audit inserts are serialised by one advisory lock                                                                                                                                           | Acceptable at this scale (ADR-006)                                 |
| The repo has no GitHub remote yet; rulesets and CI runs are not yet evidenced                                                                                                                                                          | When the repo is pushed                                            |
| Single maintainer: required approvals are 0 (see Assessment 10 doc). CODEOWNERS uses a placeholder handle                                                                                                                              | Replace with real handles; add a reviewer if one becomes available |
| The Caddy container runs as root (it needs to bind ports 80/443)                                                                                                                                                                       | Phase 10: run as non-root with `NET_BIND_SERVICE` file capability  |
| DB and Redis passwords are passed as env vars (visible in `docker inspect`)                                                                                                                                                            | Phase 10/11: Docker secrets / `_FILE` variables                    |
| Images use floating tags (`mailpit:latest`, `caddy:2-alpine`, ...)                                                                                                                                                                     | Phase 10: pin digests                                              |
| Graceful SIGTERM shutdown verified only in CI (Linux); Windows doesn't deliver POSIX signals                                                                                                                                           | n/a                                                                |
| Starlette warns that `httpx` with `TestClient` is deprecated in favour of `httpx2`                                                                                                                                                     | Revisit when FastAPI's TestClient defaults change                  |
