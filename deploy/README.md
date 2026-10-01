# Deployment

Pushes to `master` build the app in GitHub Actions and upload `dist/` to the Hetzner server,
where Caddy serves it at `https://geoscanner.lithovox.nl`.

```
/etc/caddy/Caddyfile              import /etc/caddy/apps/*.caddy
/etc/caddy/apps/geoscanner.caddy  site block for geoscanner.lithovox.nl
/var/www/apps/geoscanner/
  releases/<timestamp>-<sha>/     last 5 builds
  current -> releases/...         what Caddy serves (switched atomically)
```

## One-time server setup

1. Create a Hetzner server (Ubuntu 24.04).
2. Add a DNS A record `geoscanner.lithovox.nl` pointing to the server's IP (and an AAAA record for IPv6 if you like).
   Tip: a wildcard record `*.lithovox.nl` saves you a DNS change for every new app.
3. On your machine, create a key pair for GitHub Actions:
   ```
   ssh-keygen -t ed25519 -f github-deploy -N "" -C github-deploy
   ```
4. Copy the setup files to the server:
   ```
   scp deploy/server-setup.sh deploy/geoscanner.caddy github-deploy.pub root@<server-ip>:
   ```
5. Log in as root, run the setup and install this app's site block
   (Caddy fetches the HTTPS certificate once DNS resolves):
   ```
   ssh root@<server-ip>
   bash server-setup.sh "$(cat github-deploy.pub)"
   mv geoscanner.caddy /etc/caddy/apps/
   systemctl reload caddy
   ```

## GitHub secrets

In the repo, go to Settings → Secrets and variables → Actions and add:

| Secret               | Value                                          |
|----------------------|------------------------------------------------|
| `DEPLOY_HOST`        | server IP or hostname                          |
| `DEPLOY_USER`        | `deploy`                                       |
| `DEPLOY_SSH_KEY`     | contents of the private key `github-deploy`    |
| `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan <server-ip>`            |

Tip: on the GitHub organization (`lithovox`), add them as organization secrets so every app repo can use them.

## Adding another app

1. Copy `.github/workflows/deploy.yml` into the new repo and change `APP_NAME` / `APP_DIR`
   (and the build steps if it is not a Node/Vite app).
2. Add a DNS record `<app>.lithovox.nl` (not needed with a wildcard record).
3. Copy `geoscanner.caddy` to `<app>.caddy`, replace `geoscanner` with the app name, put it in
   `/etc/caddy/apps/` and run `systemctl reload caddy`.

For apps with a backend (e.g. a Docker container on port 8001), use a reverse proxy instead:
```
myapp.lithovox.nl {
	reverse_proxy localhost:8001
}
```

## Rollback

```
ssh deploy@<server-ip>
cd /var/www/apps/geoscanner
ls releases
ln -sfn /var/www/apps/geoscanner/releases/<older-release> current
```
