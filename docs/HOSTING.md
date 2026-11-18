# Hosting cc-hub at a public URL with auto-deploy

The result: cc-hub runs 24/7 on a server at `https://hub.<your-domain>`, every push to `main` that passes the tests deploys automatically (rolling back if the new version fails its health check), and your Obsidian vault syncs between the server and your devices through a private GitHub repo.

```
you (laptop / phone) ──HTTPS──▶ Cloudflare Access (email login) ──tunnel──▶ cloudflared ──▶ hub :8787 (server)
GitHub push to main ──▶ Actions: tests ──▶ joins tailnet ──SSH──▶ server: scripts/update.sh (health check, rollback)
server vault ⇄ private GitHub repo (vault) ⇄ Obsidian on laptop / phone
```

This follows the same pattern as a typical Cloudflare Tunnel deployment (no open ports on the server), with two deliberate differences:

| | Why |
|---|---|
| **Cloudflare Access in front of the site** | cc-hub controls agents that run code. Nobody reaches the hub, even its login page, without passing your Access policy first. The hub's own token login stays on behind it. |
| **SSH over Tailscale instead of a self-hosted runner** | This repo is public. GitHub advises against self-hosted runners on public repositories because pull requests from forks can run workflow code on them. Here, only pushes to `main` deploy, and the runner reaches the server over your private tailnet. |

## 1. Server

Ubuntu 24.04, 2 vCPU / 4 GB RAM minimum (4 vCPU / 8 GB if agents build and test large projects). Any always-on machine works: a cloud VM, a home server, or a lab machine you're allowed to use. Don't share it with other projects whose admins could read your Claude Code login or vault.

Create a user for cc-hub and run the one-line installer as that user:

```bash
sudo adduser --disabled-password cchub && sudo usermod -aG sudo cchub   # sudo only for setup; remove after
sudo -iu cchub
curl -fsSL https://raw.githubusercontent.com/<you>/cc-hub/main/install.sh | bash
```

On a server, the installer sets cc-hub up as a systemd service that starts at boot and restarts on failure. Log Claude Code in once (`claude`, then `/login`; on a headless server it prints a link to open on another device).

## 2. Public URL: Cloudflare Tunnel + Access

In the Cloudflare dashboard for your domain:

1. **Zero Trust > Networks > Tunnels > Create tunnel** (`cc-hub`), connector **Debian/Ubuntu**. Run the `cloudflared service install <token>` command it shows on the server.
2. Add a **public hostname**: `hub.<your-domain>` → service `http://localhost:8787`. Use a subdomain, not the bare domain.
3. **Zero Trust > Access > Applications > Add (Self-hosted)** for `hub.<your-domain>`:
   - Policy **Allow**: your email (and anyone you share the observer dashboard with).
   - Policy **Bypass**, path `/healthz` only, so deploys can check the site.
4. In `~/cc-hub/.env` on the server set `HUB_TRUST_PROXY=1`, then `systemctl --user restart cc-hub`.

Open `https://hub.<your-domain>`: Cloudflare asks for your email code, then cc-hub asks for its token.

## 3. Auto-deploy from GitHub

**Tailscale** (free plan is fine):
1. Install Tailscale on the server: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`.
2. In the Tailscale admin console, add a tag `tag:ci` (Access controls, `tagOwners`) and an ACL rule that lets `tag:ci` reach only the server on port 22.
3. Settings > OAuth clients: create one with the `auth_keys` write scope for `tag:ci`.

**Deploy key** (on your laptop):
```bash
ssh-keygen -t ed25519 -f cchub_deploy -N "" -C "cc-hub deploy"
```
On the server, add `cchub_deploy.pub` to `~/.ssh/authorized_keys` **restricted to the update command**:
```
command="cd ~/cc-hub && ./scripts/update.sh main",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... cc-hub deploy
```
Even if the key leaked, it could only run the update.

**GitHub repo settings** (Settings > Environments > `production`; restrict deployment branches to `main`):

| Kind | Name | Value |
|---|---|---|
| Variable | `DEPLOY_HOST` | the server's Tailscale name, e.g. `cc-hub-server` |
| Variable | `DEPLOY_USER` | `cchub` |
| Variable | `SITE_URL` | `https://hub.<your-domain>` |
| Secret | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | from Tailscale |
| Secret | `DEPLOY_SSH_KEY` | contents of `cchub_deploy` (private key) |
| Secret | `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan <tailscale-name>` run from a tailnet device |

Push to `main`: the **deploy** workflow runs the tests, updates the server, and checks the public URL. The workflow does nothing in forks or clones that don't set `DEPLOY_HOST`.

What a deploy does on the server (`scripts/update.sh`): fetch `main`, install dependencies if the lockfile changed, restart the hub, wait for `/healthz`, and **roll back to the previous commit** if it doesn't come up. Agent sessions keep running through deploys; restart a session from the dashboard to give it the new channel code.

## 4. Vault sync

1. Create a **private** GitHub repo for the vault (e.g. `<you>/vault`). Never make it public.
2. On the server: `ssh-keygen -t ed25519 -f ~/.ssh/vault_deploy -N ""` and add the public key to that repo as a **deploy key with write access**. Add to `~/.ssh/config`:
   ```
   Host github-vault
     HostName github.com
     IdentityFile ~/.ssh/vault_deploy
   ```
3. In `~/cc-hub/.env`: `HUB_VAULT_REMOTE=git@github-vault:<you>/vault.git`, then restart. The hub now commits, pulls, and pushes on every autocommit (default every 5 minutes). If the vault changed in two places at once, it never discards either side: it tells you on the dashboard.
4. **Laptop:** clone the vault repo and open it in Obsidian; install the **Obsidian Git** community plugin with auto pull/push every few minutes. **Phone:** Obsidian Git also works on mobile, or use Obsidian Sync on the laptop copy.

Moving from a laptop install: push your current vault to the new private repo first (`cd ~/Vault && git remote add origin ... && git push -u origin main`), then point the server at it. Turn off the laptop hub (`./scripts/windows-autostart.sh --uninstall` and `./scripts/stop.sh --all`) so two hubs aren't running against the same vault.

## Checklist

- [ ] `https://hub.<your-domain>` asks for Cloudflare login first, then the cc-hub token
- [ ] `https://hub.<your-domain>/healthz` returns `{"ok":true}` without login
- [ ] A trivial commit to `main` shows a green **deploy** run, and the dashboard still works
- [ ] A note created on the laptop appears on the server's vault within ~5 minutes, and vice versa
