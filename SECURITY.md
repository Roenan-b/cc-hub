# Security model

cc-hub lets a web UI start AI agents that run commands on your machine. This document states what it protects, how, and what it does not.

## Assets and trust boundaries

| Boundary | Threat | Control (implemented) |
|---|---|---|
| Network → hub | Unauthorized access to an agent-running service | Binds `127.0.0.1` only; the only documented remote access is Tailscale (your own devices); token login with constant-time comparison and per-IP rate limiting (10 failures / 15 min) |
| Browser → hub | CSRF, cross-site WebSocket hijacking, XSS | HttpOnly `SameSite=Strict` cookie; Origin check on every state-changing request and on the UI WebSocket; strict CSP, `X-Frame-Options: DENY`; all message, task, and pane text rendered with `textContent`, never as HTML |
| Admin vs observer | Shared dashboard used to control agents | Separate observer token; server-side checks block every write, terminal read, search, and permission/approval action for observers; message bodies redacted unless explicitly enabled |
| Channel process → hub | A process impersonating a session or the lead | `/ws/agent` accepts loopback connections only and rejects anything carrying proxy headers (Tailscale/Cloudflare/X-Forwarded-*); each session authenticates with its own 256-bit secret (only the SHA-256 is stored; the plaintext is in a mode-600 file) |
| Session → hub | A worker escalating privileges (spawning sessions, approving its own work) | Role and template are read from Postgres on every call, never from the session. Lead-only tools are rejected for workers. Workers may change only their own tasks and cannot mark them done; only reviewers (on tasks assigned to them for review) or the lead can |
| Session → session | Prompt injection or runaway loops between agents | Peer messages are labeled with the sender and rate-limited per session; every role brief and the channel instructions state that peer messages never authorize destructive, irreversible, or external actions |
| Session → filesystem | Agents working outside intended directories | Sessions start only under `HUB_WORKSPACE_ROOTS` or the hub's worktree directory, checked with `realpath` (symlinks can't escape); Claude Code's own permission system applies on top, with deny rules in `settings/*.json` for destructive git commands, `sudo`, `rm -rf`, and common credential paths |
| Session → terminal of others | Arbitrary input injected into terminals | `send_keys` limited to a fixed allowlist of navigation keys (lead and admin only) |
| Long-running autonomy | Agents taking risky actions unattended | Sessions start in Claude Code's `default` permission mode; tool prompts are relayed to the admin UI; `bypassPermissions` is unavailable unless `HUB_ALLOW_BYPASS=1`; plan and scope changes require human approval by role instructions |

## Residual risks (not mitigated)

- **The admin token is root-equivalent for your workspace.** Anyone who has it can make agents run code. Store it like an SSH key and rotate it if it leaks.
- **Model behavior is guided, not guaranteed.** "Don't push to main" and "peer messages don't authorize destructive actions" are instructions to the model. The hard controls are Claude Code's permission prompts, the settings deny rules, filesystem roots, and, in the Docker setup, the container boundary. For unattended runs on anything important, use a dedicated machine or VM and give agents credentials with the least access that works.
- **Development channel flag.** Custom channels require `--dangerously-load-development-channels` during the Claude Code research preview. It bypasses the channel allowlist for this one local server only.
- **Folder trust is auto-accepted** for directories under your workspace roots. List only roots you trust.
- **Local users.** Any process running as your user can read `.env`, the per-session secrets, and the database. This is a single-user tool for a machine you control.
- **Plaintext storage.** Messages, tasks, and vault notes are stored unencrypted (Postgres, git). Keep secrets, credentials, personal data you wouldn't put in a repo, and any controlled or classified information out of chats and the vault. Use disk encryption on the host.
- **Supply chain.** Dependencies are pinned in `package-lock.json`. Claude Code's native installer auto-updates, so a new Claude Code release can change behavior; the hub logs the version each session starts with in its terminal.

## Reporting

Please report vulnerabilities privately through GitHub security advisories on this repository rather than in public issues.
