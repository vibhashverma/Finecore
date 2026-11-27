# Assessment 11: Secure financial CI/CD

**Status:** the pipelines are written but **have not run yet**: the repo hasn't been pushed and Docker isn't available locally.

**`ci.yml` checks, in order:**

- commitlint, and a guard that blocks edits to already-applied migrations;
- format, lint, typecheck;
- unit and integration tests on real Postgres 16, and the build;
- a check that the database types haven't drifted from the migrations;
- Python: ruff, mypy, pytest;
- `pnpm audit` and `pip-audit`;
- gitleaks over the full history;
- E2E (Playwright + axe) and the capstone scenario;
- a Compose smoke test from a clean clone:
  - services healthy and running as non-root;
  - no database ports exposed;
  - the invariant check, Trivy image scans, and a graceful-shutdown check.

**`release.yml`, on a `vX.Y.Z` tag:**

1. Build GHCR images with SBOM and provenance.
2. Sign them with **keyless cosign** (OIDC).
3. Scan with Trivy.
4. Verify signatures, deploy to staging, and smoke-test.
5. Wait for **manual approval** (the `production` environment requires reviewers).
6. Deploy to production. `deploy.sh` smoke-tests and rolls back automatically on failure.
7. A manual `workflow_dispatch` rollback can redeploy any earlier signed tag.

**Evidence still to capture after pushing:** a green run, a red run, and a rollback run, saved in `evidence/11/`.
