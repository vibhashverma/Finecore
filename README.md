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

| Task              | make                         | Without make                                                                 |
| ----------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| Install deps      | `make install`               | `pnpm install && (cd services/analytics && uv sync)`                         |
| Start stack       | `make up`                    | `docker compose up -d --build --wait`                                        |
| Stop stack        | `make down`                  | `docker compose down`                                                        |
| Lint              | `make lint`                  | `pnpm lint && (cd services/analytics && uv run ruff check . && uv run mypy)` |
| Typecheck         | `make typecheck`             | `pnpm typecheck`                                                             |
| Test              | `make test`                  | `pnpm test && (cd services/analytics && uv run pytest)`                      |
| Migrations / seed | `make migrate` / `make seed` | _(Phase 2)_                                                                  |
| Capstone scenario | `make capstone`              | _(Phase 12)_                                                                 |

## Repository layout

```
apps/web            Next.js UI
apps/api            Express API (domain modules under src/modules)
apps/workers        BullMQ workers
services/analytics  FastAPI analytics (Decimal calculations, risk scoring)
packages/contracts  Shared TypeScript contracts (error catalog, envelopes)
db/                 SQL migrations and seed (Phase 2)
infra/              Dockerfiles, compose overrides, Caddy, deploy, monitoring
docs/               Plan, ADRs, per-assessment docs, runbooks, postmortems
evidence/NN/        Captured evidence per assessment
```

## Contributing

Branch from `main`. Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and are checked by commitlint. Open a PR using the template; CI must be green. See [docs/assessments/10-git-governance.md](docs/assessments/10-git-governance.md) for branch rules, releases and the hotfix flow.

## Status

| Phase | Scope                                                                                    | Status             |
| ----- | ---------------------------------------------------------------------------------------- | ------------------ |
| 0     | Plan, ERD, ADRs                                                                          | ✅ approved        |
| 1     | Scaffold, tooling, Compose, CI, governance                                               | ✅ awaiting review |
| 2+    | See [docs/PLAN.md §8](docs/PLAN.md#8-phase-map-the-briefs-section-12-with-exit-evidence) | ⏳                 |
