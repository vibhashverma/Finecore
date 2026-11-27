# Assessment 14: Secure deployment and recovery

**Status:** recovery is **demonstrated locally**. Deployment is **ready but not executed**: it needs a VM, a domain and DNS.

**Done, with evidence:**

- Encrypted backups (gpg AES-256 plus a SHA-256 checksum).
- A **timed restore drill**:
  - restore took 5.3 s;
  - ledger invariants passed and the audit chain verified;
  - the restored data is identical to the source.

  See `evidence/14/restore-drill.txt`.

- The version-skew lesson from the first drill attempt is recorded in ADR-014.

**Prepared, not yet run:**

- `infra/deploy/provision.sh`:
  - UFW allowing only ports 22, 80 and 443;
  - SSH keys only, fail2ban, automatic security updates;
  - a daily backup timer.
- `deploy.sh`: smoke-tests each deploy and rolls back automatically on failure.
- `Caddyfile.prod`: HTTPS and HSTS.
- `compose.prod.yaml`: signed images.
- `compose.monitoring.yaml`: Prometheus, Alertmanager, blackbox uptime and TLS-expiry checks, and Grafana (reached over an SSH tunnel).
- Alerts on ledger invariants, dead letters, backlog, p95 latency, error rate, site down and certificate expiry.

**Database access:** the database sits on internal Docker networks only and is reached through least-privilege roles.

**Configuration:** each environment has its own `/etc/fincore/<env>.env`, readable only by root (0600).

**Evidence to capture after deploying:**

- an SSL Labs report;
- an nmap scan showing only 22, 80 and 443 open;
- a Grafana screenshot;
- the restore drill run on the VM.
