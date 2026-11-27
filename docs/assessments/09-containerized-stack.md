# Assessment 09: Containerized financial stack

Status: **started in Phase 1**, hardened in Phase 10.

## What exists

| Service   | Image                                              | Runs as                | Networks     | Healthcheck                            |
| --------- | -------------------------------------------------- | ---------------------- | ------------ | -------------------------------------- |
| web       | `infra/docker/web.Dockerfile` (Next.js standalone) | `node` (uid 1000)      | app          | `GET /healthz`                         |
| api       | `infra/docker/node-service.Dockerfile` `APP=api`   | `node` (uid 1000)      | app, data    | `GET /readyz` (Postgres + Redis)       |
| workers   | same Dockerfile, `APP=workers`                     | `node` (uid 1000)      | data, egress | `GET /readyz` (Redis + worker running) |
| analytics | `infra/docker/analytics.Dockerfile` (uv venv)      | `app` (uid 10001)      | app, data    | `GET /readyz`                          |
| postgres  | `postgres:16-alpine`                               | postgres               | data         | `pg_isready`                           |
| redis     | `redis:7.4-alpine` (password, AOF)                 | redis                  | data         | `redis-cli ping`                       |
| mailpit   | email sandbox                                      |                        | data         | `mailpit readyz`                       |
| caddy     | `caddy:2-alpine`                                   | root (see LIMITATIONS) | edge, app    | n/a                                    |

**Design decisions**

- **Multi-stage builds.** Build tools, dev dependencies and sources never reach the runtime image. Node services use `pnpm deploy --prod`; analytics uses `uv sync --no-dev --no-editable`.
- **Non-root, read-only root filesystem.** Also `cap_drop: ALL` and `no-new-privileges`, with tmpfs only where writes are needed.
- **tini as PID 1**, so SIGTERM reaches Node and graceful shutdown drains: stop accepting, finish in-flight work, close pools.
- **Network isolation.** `app` and `data` are `internal: true`. Only Caddy publishes ports. Postgres and Redis are unreachable from the host in the base stack.
  - The dev override publishes them on `127.0.0.1` only, for local tools.
  - Workers alone get `egress`, for the payment sandbox.
- **Secrets.** Values come from `.env`, which is gitignored; only `.env.example` is committed. Docker secrets for staging and prod come in Phase 10/11.
- **Environments.** One base `compose.yaml`, plus `infra/compose/compose.dev.yaml` and `compose.prod.yaml` overrides. Staging and prod differ only by env values.

## How to demo

```bash
cp .env.example .env
docker compose up -d --build --wait
docker compose ps                                   # all services healthy
docker compose exec api id -u                       # 1000 (non-root)
docker image ls | grep fincore                      # image sizes
curl -s localhost:8080/api/v1/nope                  # error envelope through Caddy
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/metrics   # 404: internal only
```

The CI job `compose-smoke` runs exactly this on a clean checkout and also asserts graceful SIGTERM shutdown.

## Evidence

- `evidence/09/`: CI `compose-smoke` log (non-root uids, image sizes, health), added once the repo is pushed.
