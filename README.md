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
| **Project folders** | Every project has its own working folder (created under `HUB_PROJECTS_DIR`, or an existing folder you import) and its chats are grouped under it in the sidebar. Sessions started for a project begin in its folder. Chats can be moved between projects; older projects get a folder on first start. |
| **Live agent view** | Each project has a **Live** tab: the lead's current thinking, the phase it is in (understand, plan, approve, staff, build, review, report), the team of experts it planned as cards that fill in as each agent starts, what every agent is doing right now, and a filterable timeline of thoughts, team changes, tool calls, tasks and messages. It updates over the existing WebSocket as things happen. |
| **Observer dashboard** | A second, read-only login shows projects, boards, agent status, and live activity without exposing message text or any controls. Safe to share. |

## Quick start

cc-hub runs **locally on each machine**. One command sets everything up: dependencies, a local Postgres database, Claude Code, login tokens, and the Obsidian vault. From then on it starts by itself every time the machine boots (or you log in), so the dashboard is always at **http://localhost:8787** and every agent has the Postgres history and the vault available. Work pauses while the machine is asleep or off and resumes on its own.

**Windows (PowerShell, not admin):**
```powershell
irm https://raw.githubusercontent.com/Roenan-b/cc-hub/main/install.ps1 | iex
```

**Ubuntu / Debian:**
```bash
curl -fsSL https://raw.githubusercontent.com/Roenan-b/cc-hub/main/install.sh | bash
```

You'll be asked for your sudo password, which folders agents may work in, and to `/login` to Claude Code once. Re-run the same command to update; it keeps your `.env`, database, and vault. Using a fork? Set `CCHUB_REPO=<you>/cc-hub` first (`$env:CCHUB_REPO = "<you>/cc-hub"` in PowerShell). Read the installer before piping it to a shell; it is short.

| Platform | Starts automatically via | Guide |
|---|---|---|
| Windows 10/11 + WSL2 (Ubuntu) | Startup-folder launcher that also keeps WSL running | [docs/SETUP-WINDOWS.md](docs/SETUP-WINDOWS.md) |
| Ubuntu / Debian | systemd user service (enabled with linger, so it starts at boot) | [docs/SETUP-LINUX.md](docs/SETUP-LINUX.md) |
| macOS | not supported yet (contributions welcome) | |

Requirements are installed for you: Node 20+, tmux, git, Postgres, and Claude Code **2.1.80+**. Channels are a Claude Code research preview; on Team/Enterprise plans an admin must enable them.

**Optional extras:** reach your machine's dashboard from your phone with Tailscale (`tailscale serve --bg 8787`, private to your devices), and keep the vault in step across machines by setting `HUB_VAULT_REMOTE` to a private git repo.

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
All sessions: `reply`, `send_message`, `list_sessions`, `search_history`, `read_history`, `request_approval`, `project_list`, `task_list`, `task_get`, `task_create`, `task_update`, `share_progress`.
Lead only: `project_create`, `project_update`, `plan_team`, `spawn_session`, `stop_session`, `restart_session`, `peek_session`, `send_keys`.

`share_progress` posts a short thought or progress note (with a phase) to the project's live view; it notifies no one. `plan_team` records the experts the lead decided the project needs (key, title, template, expertise, why); `spawn_session(expert_key=..., expertise=...)` then starts each one briefed as that expert.

### Project folders and the live view
- A project's working folder is `HUB_PROJECTS_DIR/<slug>` (default `<first workspace root>/cc-projects/<slug>`), or an existing folder passed as `dir` to `project_create` or in the New project dialog. Imports must be inside a workspace root, cannot be a workspace root itself or overlap the hub's state or vault, and one folder belongs to one project.
- Events shown in the live view come from three places: the hub itself (spawns, stops, status, tasks, approvals, messages), the lead and workers (`share_progress`, `plan_team`), and a Claude Code hook the hub adds to each session's settings that records which tool was called with a one-line preview (secrets masked). Set `HUB_ACTIVITY_HOOKS=0` to turn the hook off.
- Tool-call events are pruned after `HUB_EVENT_RETENTION_DAYS`; other events are kept.
- The **Files** tab (admin only) lists names, sizes and dates in the project folder. It never serves file contents and never follows symlinks.
- Design notes: [docs/DESIGN-project-folders-live-view.md](docs/DESIGN-project-folders-live-view.md).

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
src/watchdog.mjs   activity, stall and usage-limit detection, check-ins, daily report, vault commits, event pruning
src/events.mjs     live-view helpers: secret masking, tool previews, team plan validation, observer redaction
src/activity-hook.mjs  Claude Code hook that records tool calls for the live view
src/projectfs.mjs  read-only listing of a project folder for the Files tab
src/tmux.mjs       tmux control and startup-dialog auto-accept
src/git.mjs        worktrees and vault commits
src/vault.mjs      vault and project scaffolding
db/schema.sql      Postgres schema (applied on every start, idempotent)
public/index.html  dashboard, project folders, live view, boards, files, chat, approvals (no build step)
roles/             role briefs   settings/   permission presets   vault-template/
deploy/            systemd unit, Windows bootstrap and autostart   docs/   setup guides
test/              unit tests and an end-to-end suite with a stand-in Claude CLI
```

## Testing

The suite runs a real hub, Postgres, tmux, and git with a stand-in `claude` (`test/fake-claude.mjs`) that speaks the same MCP and channel protocol. It covers the full team loop (project, approval, board, worktree spawn, assignment, review, unblocking), project folders (create, import confinement, backfill, filing chats), the live view's event stream (lead thinking, team plans, expert spawns, hook-reported tool calls with secrets masked, live WebSocket delivery and observer redaction), role enforcement, permission relay, watchdog check-ins, vault commits, observer redaction, auth and input rejection, and hub restarts with queued delivery.

```bash
createdb cchub_test   # any Postgres; the name must contain "test" (it is wiped)
TEST_DATABASE_URL=postgres://localhost/cchub_test npm test
npm run test:unit   # helpers only, no database or tmux needed
CCHUB_TEST_KEEP=1 TEST_DATABASE_URL=... npm test   # keep the demo hub running to click around
```

CI runs the same suite on every push. The stand-in does not prove behavior against every Claude Code release: dialog wording and CLI flags can change between versions. If a session sticks at "starting", open **Terminal** in the UI.

## Security

Read **[SECURITY.md](SECURITY.md)**. In short: the hub listens only on localhost; the admin token can run code in your workspace, so treat it like an SSH key; for phone access use Tailscale (private to your devices), never a public port; and keep secrets out of chats and the vault.

## License

MIT
