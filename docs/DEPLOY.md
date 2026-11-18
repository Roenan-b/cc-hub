# Deploying cc-hub 24/7

GitHub hosts the code; it cannot run the agents. The hub, tmux, and Claude Code need a machine that stays on: a desktop or lab PC, a home server, or a small cloud server (2 vCPU / 4 GB is enough for a lead and about 4 workers; builds and tests in your repos may need more). That machine serves the web UI and dashboard, and you reach it through a private tunnel.

## 1. Pick how it runs

### Option A: native + systemd (simplest on a Linux box you own)

```bash
./scripts/start.sh                 # once, to create .env; edit it; then:
mkdir -p ~/.config/systemd/user && cp deploy/cc-hub.service ~/.config/systemd/user/
sed -i "s|%CCHUB_DIR%|$PWD|" ~/.config/systemd/user/cc-hub.service
systemctl --user daemon-reload && systemctl --user enable --now cc-hub
sudo loginctl enable-linger "$USER"   # start on boot, keep running after logout
journalctl --user -u cc-hub -f        # logs
```

Claude sessions live in tmux and survive hub restarts (`KillMode=process`); their channels reconnect and queued messages are delivered.

### Option B: Docker (isolated, reproducible)

```bash
cp .env.example .env    # set tokens and POSTGRES_PASSWORD (or run ./scripts/start.sh once)
mkdir -p workspace vault && git clone <your repos> workspace/
docker compose --profile docker up -d --build
docker compose exec -it hub claude     # one-time: finish onboarding and /login, then /exit
docker compose restart hub
```

Agents can only touch `/workspace`, `/vault`, and their own home inside the container, which makes the container a real boundary for long unattended runs. Claude Code's login persists in the `agent-home` volume. This image has not been built and run in CI yet; treat the first build as the check, and pin `CLAUDE_CODE_VERSION` once it works.

## 2. Reach it from your phone

Keep `HUB_HOST=127.0.0.1` (or the Docker port bound to `127.0.0.1`) and put an authenticated tunnel in front. Set `HUB_TRUST_PROXY=1` behind either option so cookies are marked Secure and client IPs are logged correctly.

### Tailscale (private: only your devices)

Install Tailscale on the server and your phone, sign in to the same tailnet, then on the server:

```bash
tailscale serve --bg 8787
tailscale serve status        # shows https://<machine>.<tailnet>.ts.net
```

Only devices in your tailnet can reach it. This is the recommended setup. Do **not** use `tailscale funnel` for the admin UI: Funnel publishes to the whole internet.

### Cloudflare Tunnel + Access (a public URL, gated by login)

Use this when you want a normal URL (e.g. `hub.yourdomain.com`), for example to share the observer dashboard.

1. Add your domain to Cloudflare, install `cloudflared` on the server, and create a named tunnel that routes `hub.yourdomain.com` to `http://localhost:8787` (Cloudflare Zero Trust → Networks → Tunnels).
2. **Before** routing traffic, create a Cloudflare Access application for `hub.yourdomain.com` with a policy that allows only your email (and anyone you share the dashboard with). Access then requires a login before any request reaches the hub.
3. Run `cloudflared` as a service so the tunnel survives reboots.

The hub's own token login stays on behind Access, so a misconfigured policy is not enough to take it over. Never use an unauthenticated quick tunnel (`cloudflared tunnel --url ...`) for this.

## 3. Share the dashboard

Give people the **observer token** (in `.env` as `HUB_OBSERVER_TOKEN`). Observers see projects, boards, agent status, approvals (titles only), and the activity feed. Message text is hidden unless you set `HUB_OBSERVER_READ_MESSAGES=1`. Observers cannot send messages, approve anything, see terminals, or search history. Rotate the token by changing it in `.env` and restarting the hub.

## 4. Operate it

| Task | Command |
|---|---|
| Hub logs | `journalctl --user -u cc-hub -f` or `tmux attach -t cchub-server` |
| Watch a session | Terminal button in the UI, or `tmux attach -t cc-<name>` (detach: Ctrl-b d) |
| Stop everything | `./scripts/stop.sh --all` |
| Back up | `docker compose exec db pg_dump -U cchub cchub > backup.sql`; the vault is already a git repo (push it to a private remote) |
| Clean old worktrees | `git -C <repo> worktree list`, then `git worktree remove <path>` once merged |
| Upgrade | `git pull && npm ci && systemctl --user restart cc-hub` (schema migrations apply on start) |
