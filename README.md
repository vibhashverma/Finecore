# FinCore

A **SIMULATED** digital wallet, double-entry ledger and payment processing platform, built for an educational technical assessment.

> ⚠️ No real money, cards, bank credentials or personal data are used anywhere. All data is synthetic, and every third-party integration runs in sandbox/test mode. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

| Layer                | Tech                                              |
| -------------------- | ------------------------------------------------- |
| UI                   | Next.js (App Router), React, TypeScript, Tailwind |
| Core API and workers | Node 22, Express 5, TypeScript, BullMQ            |
| Analytics            | Python 3.13, FastAPI, Pydantic v2                 |
| Data                 | PostgreSQL 16 (system of record), Redis 7         |
| Edge                 | Caddy (single origin, automatic HTTPS)            |

The architecture, ERD and data ownership are in [docs/PLAN.md](docs/PLAN.md). Decisions are in [docs/adr/](docs/adr/README.md).

## Prerequisites

| Tool           | Version                  | Notes                                                                      |
| -------------- | ------------------------ | -------------------------------------------------------------------------- |
| Docker Desktop | recent, **WSL2 backend** | Required for `docker compose` and integration tests (Testcontainers)       |
| Node.js        | 22.x (see `.nvmrc`)      |                                                                            |
| pnpm           | 10.x                     | `npm i -g pnpm@10` (or `corepack enable`)                                  |
| uv             | ≥ 0.11                   | Python toolchain for `services/analytics`                                  |
| make           | optional                 | Available in WSL2/Linux/macOS; every target has a pnpm/uv equivalent below |

On Windows, develop inside **WSL2** so shell scripts, `make` and file permissions match CI and the Linux server.

## Quick start without Docker (database only)

```bash
pnpm install
pnpm --filter @fincore/db db:local   # real PostgreSQL 16 on 127.0.0.1:54320: roles, migrations, synthetic seed
```

This runs the same role bootstrap and migrations as the Docker stack ([ADR-005](docs/adr/005-test-database-strategy.md)). Demo users and wallets are listed in [docs/assessments/03-ledger-database.md](docs/assessments/03-ledger-database.md#setup-and-demo-no-docker-needed).

## Quick start (full stack in Docker)

```bash
cp .env.example .env          # local placeholders only
docker compose up -d --build --wait
open http://localhost:8080    # UI through Caddy; the API is at http://localhost:8080/api/v1
```

Development override, which publishes Postgres, Redis and Mailpit on `127.0.0.1` only:

```bash
docker compose -f compose.yaml -f infra/compose/compose.dev.yaml up -d --build --wait
# Mailpit (email sandbox) UI: http://localhost:8025
```

## Commands

| Task               | make             | Without make                                                                 |
| ------------------ | ---------------- | ---------------------------------------------------------------------------- |
| Install deps       | `make install`   | `pnpm install && (cd services/analytics && uv sync)`                         |
| Start stack        | `make up`        | `docker compose up -d --build --wait`                                        |
| Stop stack         | `make down`      | `docker compose down`                                                        |
| Lint               | `make lint`      | `pnpm lint && (cd services/analytics && uv run ruff check . && uv run mypy)` |
| Typecheck          | `make typecheck` | `pnpm typecheck`                                                             |
| Test               | `make test`      | `pnpm test && (cd services/analytics && uv run pytest)`                      |
| Local DB + seed    | `make db-local`  | `pnpm --filter @fincore/db db:local` (no Docker)                             |
| DB types (codegen) | `make codegen`   | `pnpm --filter @fincore/db codegen`                                          |
| Capstone scenario  | `make capstone`  | _(Phase 12)_                                                                 |

## Repository layout

```
apps/web            Next.js UI
apps/api            Express API (domain modules under src/modules)
apps/workers        BullMQ workers
services/analytics  FastAPI analytics (Decimal calculations, risk scoring)
packages/contracts  Shared TypeScript contracts (error catalog, envelopes)
packages/db         DB access helpers, embedded-Postgres harness, seed, generated types
db/                 SQL migrations (dbmate) and role bootstrap
infra/              Dockerfiles, compose overrides, Caddy, deploy, monitoring
docs/               Plan, ADRs, per-assessment docs, runbooks, postmortems
evidence/NN/        Captured evidence per assessment
```

## Contributing

Branch from `main`. Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and are checked by commitlint. Open a PR using the template; CI must be green. See [docs/assessments/10-git-governance.md](docs/assessments/10-git-governance.md) for branch rules, releases and the hotfix flow.

## Documentation map

| Topic                        | Where                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| Architecture, data flow, ERD | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PLAN.md](docs/PLAN.md)                 |
| API guide and OpenAPI        | [docs/API.md](docs/API.md), `/api/v1/openapi.json`, `/api/docs`, [postman/](postman/)      |
| Decisions                    | [docs/adr/](docs/adr/README.md) (ADR-001 to ADR-014)                                       |
| Per-assessment docs          | [docs/assessments/](docs/assessments/) (01–15)                                             |
| Test matrix                  | [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md)                                                 |
| Security (OWASP)             | [docs/SECURITY.md](docs/SECURITY.md)                                                       |
| Runbooks and postmortems     | [docs/runbooks/](docs/runbooks/README.md), [docs/postmortems/](docs/postmortems/README.md) |
| Deployment                   | [infra/deploy/README.md](infra/deploy/README.md)                                           |
| Limitations and mocks        | [docs/LIMITATIONS.md](docs/LIMITATIONS.md)                                                 |
| Review preparation           | [docs/REVIEW_PREP.md](docs/REVIEW_PREP.md)                                                 |
| Evidence                     | [evidence/](evidence/)                                                                     |

## Run everything locally without Docker

```bash
pnpm install && (cd services/analytics && uv sync)
pnpm test                                      # TS suites incl. DB tests on embedded PostgreSQL 16
(cd services/analytics && uv run pytest)       # analytics
pnpm --filter @fincore/api scenario capstone   # brief §10: proves balanced ledger, no double posting
pnpm --filter @fincore/api scenario incidents  # Assessment 15 reproductions
API_INTERNAL_URL=http://127.0.0.1:4400 pnpm build && pnpm --filter @fincore/web test:e2e   # Playwright + axe
```

Demo users: `alice@`, `bob@`, `chandra@`, `support@`, `ops@`, `finance@`, `admin@fincore.test`. Password `FinCore-Demo-2026!`; SIMULATED TOTP secret `JBSWY3DPEHPK3PXP`.

## Status

All 15 assessments are implemented and tested locally. Docker, GitHub and the VM steps are prepared but not yet executed; see [docs/LIMITATIONS.md](docs/LIMITATIONS.md#environment-gaps-honest-status).
