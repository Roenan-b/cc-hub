# Roadmap

Where cc-hub is headed. Each phase ships behind tests and a security review, and nothing in it changes the rule that irreversible actions (submit, send, upload, pay, delete, post) need a human approval.

Status: ✅ shipped · 🚧 in progress · 📋 planned

## ✅ Foundation (v0.2)

Lead and worker sessions over Claude Code channels, Postgres history with full-text search, task board with role enforcement, git worktrees, Obsidian vault with autocommit and private-remote sync, watchdog, recovery after sleep or power-off, admin and observer dashboards, one-command setup for Windows (WSL2) and Ubuntu.

## 📋 Phase 0.5: Cross-platform core

- A session-runner interface with two backends: **tmux** (Linux, macOS, WSL) and a **pty** backend (ConPTY on native Windows).
- Node launchers instead of shell scripts; per-OS app-data folders; owner-only ACLs for secrets on Windows.
- Native **Windows (PowerShell, no WSL)** and **macOS** support, checked by the e2e suite on all three operating systems in CI.

## 📋 Phase 1: Operator role and browser control

- An `operator` role that drives a real browser through Playwright MCP.
- Persistent per-site browser profiles. You log in once, including MFA; agents reuse the session and never see passwords or codes.
- Per-task domain allowlists, profile locking, and a full audit log of every browser action.

## 📋 Phase 2: Site skills

- A documented skill format (entry URL, logged-in check, navigation, extraction, which actions are irreversible).
- First skill: a learning management system (D2L), to find a course and assignment and save the prompt, rubric, and due date to the vault.
- A guide to writing your own (Canvas, Workday, USAJOBS, webmail).

## 📋 Phase 3: Workflows and deliverables

- Multi-step requests become task chains: fetch, draft, render, approve, submit.
- Markdown to PDF rendering.
- Deliverable approval cards with a preview, the source prompt, and Approve / Request changes / Reject.
- Writers build personal or graded work from the user's own input and never invent experiences or results.

## 📋 Phase 4: Multi-machine and multi-user

- Real user accounts (argon2id, optional TOTP), with every row scoped per user.
- Machines as first-class records. Start a chat on one computer and **Continue here** on another, with the transcript, open tasks, decisions, and vault links carried over.
- Ownership leases so two machines never drive one session; single-use, expiring join codes; revocable machine credentials.
- A guest-machine mode for shared or lab computers that never syncs personal notes or stores browser profiles.

## 📋 Phase 5: One command, any OS

- `irm | iex` on Windows (winget, Task Scheduler), `curl | bash` on macOS (Homebrew, launchd) and Linux (apt or dnf, systemd).
- A non-technical mode: no questions beyond logging in to Claude and choosing a password.
- `cchub` CLI: `doctor`, `join`, `login <site>`, `status`, `update`, `uninstall`.
- An unattended installer run on Windows, macOS, and Linux runners in CI.

## 📋 Phase 6: Desktop control (optional)

Research desktop app control, then ship it behind the same approval and audit model, or document why not.

---

Want to help? Pick an item, open an issue to agree on the approach, then follow [CONTRIBUTING.md](../CONTRIBUTING.md).
