# ADR-013: Hosting

- Status: Accepted (Phase 11). Provider choice is pending the user's account.
- Date: 2026-11-28

**Decision.** A single Linux VM (Ubuntu 24.04, 2 vCPU / 4 GB, e.g. Hetzner CX22, DigitalOcean or Lightsail) running Docker Compose with Caddy for automatic HTTPS. It is provisioned by `infra/deploy/provision.sh`:

- SSH keys only;
- UFW allowing only 22/80/443;
- fail2ban;
- unattended upgrades;
- a daily encrypted backup timer.

Postgres and Redis are on internal Docker networks only; they publish no ports. Deployments use **signed, versioned GHCR images** through `release.yml` (staging, approval, production) and `deploy.sh`, which smoke-tests and rolls back automatically.

**Why not a managed PaaS.** It hides exactly what Assessment 14 must demonstrate: firewall rules, a private database, backups and restore drills, and least-privilege roles.

**Staging vs production.** Same compose files, different `/etc/fincore/<env>.env` (root 0600), and a separate VM or domain.
