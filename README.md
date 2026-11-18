# cc-hub

**Give one Claude a problem. It plans the work, staffs a team of Claude Code sessions, runs them for days, and reports back to your phone.**

cc-hub turns [Claude Code](https://code.claude.com) into a team: a **lead** session that plans and coordinates, and **worker** sessions (researchers, engineers, reviewers, writers) that it starts, assigns, reviews, and stops. You talk to the lead from a browser or phone. Every message is kept in Postgres, and everything worth knowing lands in an Obsidian vault that links your projects together.

```
          you (phone / browser)                     observers (read-only dashboard)
                  │  HTTPS via Tailscale or Cloudflare Tunnel        │
                  ▼                                                   ▼
        ┌──────────────────────── hub (Node) ────────────────────────────┐
        │ web UI · REST · task board · approvals · watchdog · auth        │
        └───────┬───────────────────────┬──────────────────┬──────────────┘
                │ loopback WebSocket     │ SQL              │ git autocommit
                │ (per-session secret)   ▼                  ▼
                │                  Postgres            Obsidian vault
                │                  (every message,     (plans, decisions,
                │                   tasks, audit)       notes, reports)
   tmux ────────┼────────────────────────────────────────────────
   cc-orchestrator   claude + channel.mjs   ← lead: plans, assigns, reviews
   cc-eng-parser     claude + channel.mjs   ← engineer in its own git worktree
   cc-lit-review     claude + channel.mjs   ← researcher
   cc-rev-1          claude + channel.mjs   ← reviewer
```

## What it does

| | |
|---|---|
| **One conversation in, a team's work out** | Describe a problem to the lead. It writes a plan, asks you to approve it (one tap on your phone), breaks it into tasks with dependencies and acceptance criteria, and starts the right workers. |
| **Push, not polling** | Each session loads a Claude Code [channel](https://code.claude.com/docs/en/channels-reference). Your messages, task assignments, and teammates' messages are pushed straight into the session. Nobody burns turns checking an inbox. |
| **Shared task board** | Postgres-backed board with owners, priorities, dependencies, results, and a full audit trail. Workers can't mark their own work done: a different session reviews it against the acceptance criteria. |
| **Isolated git worktrees** | Engineers each get their own worktree and branch, so parallel work never collides. Nothing is pushed or merged without the lead (and, for shared branches, you). |
| **Two kinds of memory** | Postgres keeps every message forever with full-text search ("search the history for what we decided about X"). The Obsidian vault keeps the curated knowledge: one folder per project (plan, decisions, task notes, daily reports, sources), linked into a shared `Knowledge/` graph. The vault is auto-committed to git. |
| **Runs while you sleep** | A watchdog reads every terminal, detects stalls, open dialogs, and usage limits, and gives the lead periodic board check-ins so it keeps starting unblocked work, assigning reviews, and restarting stuck workers. Every evening the lead writes a daily report. |
| **You stay in control** | Plan approval, risky steps, and tool permission prompts reach your phone as Approve / Deny cards. Roles are enforced by the hub, not by trusting the model. |
| **Observer dashboard** | A second, read-only login shows projects, boards, agent status, and live activity without exposing message text or any controls. Safe to share. |

## Quick start

Requirements: Linux or macOS, Node 20+, tmux, git, Docker (for Postgres), and Claude Code **2.1.80+** signed in (`claude` once, then `/login`). Channels are a Claude Code research preview; on Team/Enterprise plans an admin must enable them.

```bash
git clone https://github.com/<you>/cc-hub && cd cc-hub
npm ci
./scripts/start.sh        # first run: writes .env with random tokens and prints them
$EDITOR .env              # set HUB_WORKSPACE_ROOTS (where your repos live) and HUB_VAULT
./scripts/start.sh        # starts Postgres + the hub; the lead session starts automatically
```

Open http://127.0.0.1:8787 and sign in with the admin token. To use it from your phone or keep it up 24/7, see **[docs/DEPLOY.md](docs/DEPLOY.md)**.

Prefer containers? `docker compose --profile docker up -d --build`, then log Claude Code in once with `docker compose exec -it hub claude`. Details in the deploy guide.

## Your first project

Open the **orchestrator** chat and describe the problem the way you would to a capable team lead:

> I'm researching how control flow graphs and data dependence graphs can improve binary vulnerability detection. Repo is `~/projects/cfg-ddg`. I need (1) a literature review of the last 5 years with a comparison table, (2) a working prototype that extracts CFGs and DDGs from the test binaries with angr and flags the patterns from the review, with tests, and (3) a 6-page write-up. My advisor cares most about the evaluation methodology. Ask me anything you need, then send me a plan.

What happens next:

1. The lead asks only the questions that change the plan, creates the project (`Projects/cfg-ddg/` in your vault), writes `Plan.md`, and sends you an **approval card**.
2. After you approve, it fills the **board** (Dashboard → project) and starts workers: researchers on the literature, an engineer in a worktree on `feature/cfg-extract`, later a reviewer and a writer.
3. You'll see results arrive as review requests, unblocked tasks, permission prompts for anything not pre-approved, and a **daily report** at 21:00 (configurable).
4. Ask the lead anything at any time ("where are we?", "drop the GNN baseline", "what did the reviewer find?").

## Using it well

- **Write the definition of done.** The lead plans against it, and reviewers check against it.
- **Pre-approve your routine commands.** Add your build and test commands to `settings/worker.json` so workers don't wait on permission prompts overnight. The deny list blocks destructive commands and credential reads regardless.
- **Size the team to your plan limits.** Every session draws on the same Claude account. Many parallel sessions hit usage limits sooner; the watchdog detects this and the dashboard flags it. Start with 3 to 4 workers (`HUB_MAX_WORKERS`).
- **Keep the vault clean.** It's yours too: open it in Obsidian (desktop or mobile) to read plans, decisions, and reports, and see the graph grow.
- **Check the work.** Reviews catch a lot, but treat results as a strong team's draft, not ground truth. The lead is instructed to separate verified results from inferences and assumptions; hold it to that.

## Reference

### Roles (`roles/*.md`)
Appended to each session's system prompt, so they survive context compaction. Edit freely or add your own; new files become templates automatically.

| Template | Does | Can mark tasks |
|---|---|---|
| `lead` | Intake, plan, approval, task board, staffing, reviews, reports | anything |
| `researcher` | Literature, docs, prior art; sourced findings in the vault | in_progress, review, blocked |
| `engineer` | Code + tests in its own worktree; never pushes to shared branches | in_progress, review, blocked |
| `reviewer` | Independent verification against acceptance criteria | done, or back to in_progress |
| `writer` | Deliverables from verified findings | in_progress, review, blocked |
| `general` | Anything else | in_progress, review, blocked |

### Tools each session gets (via the channel)
All sessions: `reply`, `send_message`, `list_sessions`, `search_history`, `read_history`, `request_approval`, `project_list`, `task_list`, `task_get`, `task_create`, `task_update`.
Lead only: `project_create`, `project_update`, `spawn_session`, `stop_session`, `restart_session`, `peek_session`, `send_keys`.

### Vault layout
```
Home.md · Conventions.md · Knowledge/ · People/ · Templates/
Projects/<slug>/<slug>.md   index (lead)
                Plan.md     approved plan (lead)
                Decisions/  one note per decision
                Notes/      T<id> <title>.md per task
                Reports/    YYYY-MM-DD.md daily reports (lead)
                Sources.md  every external source and what it supports
```

### Configuration
Everything is in `.env`; see [.env.example](.env.example) for every option with comments.

### Layout
```
src/hub.mjs        HTTP API, WebSockets, agent RPC, auth (admin / observer)
src/core.mjs       sessions, projects, tasks, approvals, messaging, role enforcement
src/channel.mjs    MCP channel server loaded by every Claude session
src/watchdog.mjs   activity, stall and usage-limit detection, check-ins, daily report, vault commits
src/tmux.mjs       tmux control and startup-dialog auto-accept
src/git.mjs        worktrees and vault commits
src/vault.mjs      vault and project scaffolding
db/schema.sql      Postgres schema (applied on every start, idempotent)
public/index.html  dashboard, boards, chat, approvals (no build step)
roles/             role briefs   settings/   permission presets   vault-template/
deploy/            systemd unit  docs/       deployment and security
test/              end-to-end suite with a stand-in Claude CLI
```

## Testing

The suite runs a real hub, Postgres, tmux, and git with a stand-in `claude` (`test/fake-claude.mjs`) that speaks the same MCP and channel protocol. It covers the full team loop (project, approval, board, worktree spawn, assignment, review, unblocking), role enforcement, permission relay, watchdog check-ins, vault commits, observer redaction, auth and input rejection, and hub restarts with queued delivery.

```bash
createdb cchub_test   # any Postgres; the name must contain "test" (it is wiped)
TEST_DATABASE_URL=postgres://localhost/cchub_test npm test
CCHUB_TEST_KEEP=1 TEST_DATABASE_URL=... npm test   # keep the demo hub running to click around
```

CI runs the same suite on every push. The stand-in does not prove behavior against every Claude Code release: dialog wording and CLI flags can change between versions. If a session sticks at "starting", open **Terminal** in the UI.

## Security

Read **[SECURITY.md](SECURITY.md)** before exposing the hub beyond your machine. In short: the admin token can run code in your workspace, so keep the hub on loopback behind Tailscale or Cloudflare Access, and keep secrets out of chats and the vault.

## License

MIT
