# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-27

### Added

- Phase 0 plan, ERD and ADRs 001–004 (money representation, data access, concurrency, auth).
- pnpm + Turborepo monorepo: `apps/api`, `apps/workers`, `apps/web`, `packages/contracts`, `services/analytics`.
- API skeleton: request ids, structured logs with redaction, error envelope and catalog, health/readiness/metrics, graceful shutdown.
- Workers skeleton: BullMQ system queue, health server, graceful drain.
- Web skeleton: Next.js App Router with a persistent SIMULATED FUNDS banner.
- Analytics skeleton: FastAPI with the same envelope, request ids, health and metrics.
- Docker images (multi-stage, non-root), Compose stack with isolated internal networks, Caddy single origin.
- CI: commitlint, lint/typecheck/test/build, Python checks, gitleaks, compose smoke test.
- Governance: CODEOWNERS, PR template with a migration checklist, rulesets, Conventional Commits.
