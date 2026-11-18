# Setup on a Windows laptop (WSL)

This runs cc-hub on your own Windows computer, inside WSL (Ubuntu). The team works whenever the computer is on and awake, pauses when it sleeps, and picks back up on its own when it wakes or restarts.

## One-command setup

1. Download `cc-hub.zip` (or a ZIP of your GitHub repo) to your **Downloads** folder.
2. Open **PowerShell** (normal, not admin) and paste:

```powershell
$z = Get-ChildItem "$HOME\Downloads\cc-hub*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -First 1; "Using $($z.Name) ($([math]::Round($z.Length/1KB)) KB, $($z.LastWriteTime))"; $d = "$env:TEMP\cc-hub-src"; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive $z.FullName $d; $b = Get-ChildItem $d -Recurse -Filter bootstrap.ps1 | Select-Object -First 1; if ($b) { powershell -ExecutionPolicy Bypass -File $b.FullName } else { "That zip is an older version without the Windows installer. Download the newest cc-hub.zip and run this again." }
```
```

Already cloned the repo somewhere on Windows? Run `powershell -ExecutionPolicy Bypass -File <repo>\deploy\windows\bootstrap.ps1` instead.

It asks you for three things:

| Prompt | What to enter |
|---|---|
| Ubuntu sudo password | Your Linux password (for installing packages and Postgres) |
| Folders agents may work in | Press Enter to allow your whole WSL home, or list folders like `/home/you/research:/home/you/capstone` |
| Claude Code login | Type `/login`, finish in the browser, then `/exit` |
| Tailscale (optional) | `Y` to set up phone access; sign in when the browser opens |

What it does, in order: copies cc-hub to `~/cc-hub` in WSL, installs tmux, git, Postgres, Node 22, and Claude Code (native installer) as needed, enables systemd in WSL (restarting WSL once), creates the database and `.env` with random tokens, creates the vault at `Documents\Vault`, installs the start-at-login launcher, keeps Windows awake while plugged in, installs and opens Obsidian with the vault, optionally sets up Tailscale, puts a **cc-hub** shortcut on your Desktop, copies the admin token to your clipboard, and opens the dashboard.

Re-run the same command any time to update to a newer ZIP. It keeps your `.env`, database, and vault.

## How it behaves on a laptop

| Situation | What happens |
|---|---|
| You log into Windows | A hidden launcher starts WSL, Postgres, and the hub. A background process keeps WSL from shutting down when no terminal is open. |
| Laptop sleeps | Everything pauses. On wake, the watchdog recognizes the gap, resets its stall timers (so healthy workers aren't restarted), and tells the lead to check the board. |
| Laptop shuts down or restarts | On next login the hub starts, the lead starts fresh, workers that were running are restarted in their same folders and branches, and the lead gets a briefing to rebuild context from the board, vault, and history. |
| Hub crashes | It restarts within 5 seconds; agent sessions keep running. |
| You're away and the laptop is off | Nothing runs, and the phone URL won't load until it's back on. |

Claude sessions lose their conversation context on a restart (not on sleep). That's by design: the task board, the vault, and the searchable message history are the team's memory, and the role briefs tell every session to rebuild from them.

**Power settings:** the setup sets "never sleep" and "lid close does nothing" **only when plugged in**. On battery your normal settings apply. To undo: Settings → System → Power & battery, or re-run `install-autostart.ps1` without `-NoSleepOnAC` and change the settings back by hand.

## Everyday commands (inside Ubuntu)

```bash
cd ~/cc-hub
./scripts/start.sh            # start (normally automatic)
./scripts/stop.sh             # stop the hub; agents keep running
./scripts/stop.sh --all       # stop the hub and every agent (they won't auto-resume)
tail -f hub.log               # hub log
tmux attach -t cc-orchestrator   # watch the lead's terminal (detach: Ctrl-b then d)
```

Remove autostart: `./scripts/windows-autostart.sh --uninstall`.

## Troubleshooting

- **Dashboard doesn't load at localhost:8787:** in Ubuntu run `tail -50 ~/cc-hub/autostart.log ~/cc-hub/hub.log`. If the hub is up inside WSL but Windows can't reach it, add `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig`, then `wsl --shutdown`.
- **A session sits at "starting":** open it, tap **Terminal**, and use the key buttons to answer the dialog, or `tmux attach -t cc-<name>`.
- **`claude: command not found` or `node: not found`:** the native install lives in `~/.local/bin`; open a new Ubuntu terminal, or run `export PATH="$HOME/.local/bin:$PATH"`. Make sure you are not calling a Windows copy of `claude` from `/mnt/c/...` (`which claude` should show a path under your Linux home).
- **Obsidian opened an empty window:** choose "Open folder as vault" and pick `Documents\Vault`.
- **Tailscale serve asks to enable HTTPS:** open the link it prints, enable Serve for your tailnet, and run `tailscale serve --bg 8787` again in PowerShell.

## Want it running when the laptop is closed?

Move the hub to an always-on machine (a lab PC, home server, or small cloud server) with [DEPLOY.md](DEPLOY.md). The vault can stay on your laptop through Obsidian Sync or a git remote.
