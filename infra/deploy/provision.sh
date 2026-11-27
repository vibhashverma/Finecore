#!/usr/bin/env bash
# One-time hardening of a fresh Ubuntu 24.04 VM for FinCore (Assessment 14). Run as root.
# Result: SSH key-only, firewall allows ONLY 22/80/443, Docker installed, unprivileged deploy user,
# unattended security updates, daily encrypted backup timer. PostgreSQL/Redis are NEVER exposed.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-fincore}"

apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw unattended-upgrades fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker Engine + compose plugin (official repo)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Deploy user (no password login), owns /opt/fincore
id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 /opt/fincore /opt/fincore/backups
install -d -o root -g root -m 0700 /etc/fincore   # secret env files live here (root-only)

# SSH: keys only, no root login
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh

# Firewall: default deny; only SSH and HTTP(S). Docker publishes only Caddy's 80/443 (compose.yaml).
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# Daily encrypted backup at 02:15 UTC (systemd timer)
cat > /etc/systemd/system/fincore-backup.service <<'UNIT'
[Unit]
Description=FinCore encrypted database backup
[Service]
Type=oneshot
User=root
WorkingDirectory=/opt/fincore
ExecStart=/opt/fincore/infra/deploy/backup-in-container.sh
UNIT
cat > /etc/systemd/system/fincore-backup.timer <<'UNIT'
[Unit]
Description=Daily FinCore backup
[Timer]
OnCalendar=*-*-* 02:15:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now fincore-backup.timer
echo "provisioned: firewall=$(ufw status | head -1) docker=$(docker --version)"
