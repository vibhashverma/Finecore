# Deployment (staging and production)

**Status:** prepared, **not yet executed**. It needs a VM, a domain and GitHub secrets.

## One-time setup

1. **Create the VM:** Ubuntu 24.04, 2 vCPU / 4 GB. Point DNS A records `fincore.<domain>` (prod) and `staging.fincore.<domain>` at it.
2. **Harden it:** `scp infra/deploy/provision.sh root@vm: && ssh root@vm ./provision.sh`. This sets up UFW (22/80/443), SSH keys only, Docker and the backup timer.
3. **Clone the repo** to `/opt/fincore` as the `fincore` user.
4. **Create `/etc/fincore/production.env`** (root, mode 0600) from `.env.example`:
   - every password and secret freshly generated, e.g. `openssl rand -base64 32`;
   - `MFA_ENC_KEY`: `openssl rand -base64 32`;
   - `JWT_PRIVATE_KEY_PEM` / `JWT_PUBLIC_KEY_PEM`: `openssl genpkey -algorithm ed25519` and `openssl pkey -pubout`, with newlines escaped as `\n`;
   - `APP_ENV=production`, `SITE_ADDRESS=fincore.<domain>`, `ACME_EMAIL=…`, `REGISTRY=ghcr.io/<owner>/fincore`;
   - `ANALYTICS_TOKEN` and `WEBHOOK_SECRET`.
5. **Backup passphrase:** `openssl rand -base64 48 > /etc/fincore/backup.pass && chmod 600 /etc/fincore/backup.pass`. Also store a copy in a password manager.
6. **GitHub setup:**
   - Environments `staging` and `production`; production has required reviewers.
   - Secrets `STAGING_HOST`, `STAGING_SSH_KEY`, `PRODUCTION_HOST`, `PRODUCTION_SSH_KEY`.

## Releases

Tag `vX.Y.Z` → `release.yml`:

1. Build, sign and scan the images.
2. Deploy to staging and smoke-test.
3. Wait for approval.
4. Deploy to production, with automatic rollback.

For a manual rollback, run the workflow with `rollback_to=vX.Y.Z`.

## Evidence to capture (Assessment 14)

- `curl -sI https://fincore.<domain>` and an SSL Labs report.
- `nmap -p 1-10000 fincore.<domain>`: only 22, 80 and 443 open.
- A Grafana screenshot (SSH tunnel `-L 3001:127.0.0.1:3001`).
- `infra/deploy/backup-in-container.sh`, then the restore drill (`scripts/restore-drill.sh`) run on the VM, with timings.
