# Setup on Ubuntu / Debian

```bash
curl -fsSL https://raw.githubusercontent.com/Roenan-b/cc-hub/main/install.sh | bash
```

The installer clones cc-hub to `~/cc-hub`, runs `scripts/setup.sh` (tmux, git, Postgres, Node 22, Claude Code, `.env` with random tokens, the vault at `~/Vault` by default), logs Claude Code in if needed, and installs a **systemd user service** so cc-hub starts at boot, even before you log in, and restarts if it crashes. Then open http://localhost:8787 and sign in with the admin token it printed.

## Everyday

| Task                                  | Command                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Status / logs                         | `systemctl --user status cc-hub` · `journalctl --user -u cc-hub -f`                 |
| Restart the hub (agents keep running) | `systemctl --user restart cc-hub`                                                   |
| Update to the latest version          | `~/cc-hub/scripts/update.sh` (rolls back if the new version fails its health check) |
| Watch a session                       | Terminal button in the dashboard, or `tmux attach -t cc-<name>` (detach: Ctrl-b d)  |
| Stop everything                       | `systemctl --user stop cc-hub && ~/cc-hub/scripts/stop.sh --all`                    |
| Disable autostart                     | `systemctl --user disable cc-hub`                                                   |
| Back up                               | `pg_dump "$(grep ^DATABASE_URL ~/cc-hub/.env                                        | cut -d= -f2-)" > cchub.sql`; the vault is already a git repo |

The vault is a normal folder: open it in Obsidian (Open folder as vault). Phone access: install Tailscale on the machine and your phone, then `sudo tailscale serve --bg 8787` and open the `https://<machine>.<tailnet>.ts.net` address.

Sleep and reboots are handled like on Windows: on wake the watchdog resets its stall timers and briefs the lead; after a reboot the workers that were running are restarted in the same folders and branches.
