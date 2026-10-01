#!/usr/bin/env bash
# One-time setup of a fresh Hetzner Ubuntu 24.04 server for hosting multiple apps.
# Run as root:  bash server-setup.sh "ssh-ed25519 AAAA... github-deploy"
set -euo pipefail

DEPLOY_PUBKEY="${1:?usage: server-setup.sh <deploy-public-key>}"

apt-get update
apt-get -y upgrade
apt-get install -y rsync ufw

# Firewall: SSH + HTTP(S) only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# Caddy - handles HTTPS certificates automatically.
# Installed from Ubuntu's own archive: Caddy's apt repo is signed with an expired subkey.
apt-get install -y caddy

# Deploy user used by GitHub Actions (no password, key-only)
if ! id deploy &>/dev/null; then
  adduser --disabled-password --gecos "" deploy
fi
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo "$DEPLOY_PUBKEY" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# App files live here, one folder per app
install -d -o deploy -g deploy /var/www/apps

# Each app has its own site block (own subdomain) in /etc/caddy/apps/*.caddy
install -d /etc/caddy/apps
echo "import /etc/caddy/apps/*.caddy" > /etc/caddy/Caddyfile

systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "Done. Add app snippets to /etc/caddy/apps/ and run: systemctl reload caddy"
