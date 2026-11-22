# Design: project folders and the live agent view

Status: implemented on branch `feature/project-folders-live-view`. Items marked *proposed* are not built.

## Problem

1. The sidebar was a flat list of chats. Projects existed (a Postgres row, a task board and a vault folder) but had no working folder, and chats were only loosely tagged with a project.
2. You could not see what the agents were doing: how the lead understood the problem, which experts it decided it needed, when it started them, and what each one was working on.

## Goals

- Every project has its own folder on disk, created for it or imported, and its chats, agents and outputs are grouped under it.
- A live view per project shows the lead thinking the project through, choosing experts, starting agents briefed as those experts, and what each agent is doing, as it happens.
- No new dependencies, no build step, cross-platform where the hub already is, and no weakening of the existing security model.

## 1. Data model and migration

All changes are additive and idempotent in `db/schema.sql`, which runs on every start.

| Change | Purpose |
|---|---|
| `projects.dir TEXT` plus a unique partial index | The project's working folder. One folder belongs to one project. |
| `sessions.expertise`, `expert_key`, `expert_title` | The expert role a session was started as. Kept across restarts. |
| New table `agent_events (id, ts, project, session, kind, summary, text, detail jsonb)` | The live view's event stream. Indexed by `(project, id)`, plus a partial index for the latest team plan. |

Event kinds: `thinking`, `progress`, `team_plan`, `spawn`, `stop`, `status`, `tool`, `task`, `approval`, `message`, `project`.

- `summary` is written by the hub (for example "eng1 used Bash", "orchestrator planned a team of 3 experts: ...") and is safe to show anyone who can see the dashboard.
- `text` is agent-written (a thought, a tool preview, a message body) and is redacted for observers.
- `detail.private` holds agent-written fields that must also be redacted for observers (an expert's expertise and the reason the lead chose it).

**Migration.** On start, `ensureProjectFolders()` gives every project without a `dir` a folder at `<projects dir>/<slug>`. Existing chats already carry `sessions.project`, so they appear under their project with no data change. Chats with no project, or a project that no longer exists, show under **Unfiled chats** and can be moved with **Move** in the chat menu (`PATCH /api/sessions/:name {project}`). Events only exist from this change onward; the graph is built from current sessions plus the latest team plan, so it is useful immediately for running projects.

## 2. Project folders

- `HUB_PROJECTS_DIR` (default `<first workspace root>/cc-projects`) must be inside a workspace root; the hub refuses to start otherwise.
- **Create:** `<projects dir>/<slug>`. The slug is validated (`^[a-z0-9][a-z0-9-]{0,39}$`), and after `mkdir` the hub checks that the folder's real parent is the projects folder, so a pre-planted symlink cannot redirect it.
- **Import** (`dir` on `project_create`, or the Folder field in the New project dialog): resolved with `realpath`, must exist, must be inside a workspace root, and must not be a workspace root itself, the projects folder itself, or overlap the hub state directory or the vault. A folder already owned by another project is rejected (409).
- Sessions spawned for a project start in its folder unless a `cwd` or `repo` is given. If they start elsewhere (a worktree), the project folder is added with `--add-dir` so deliverables can still be written there.
- The lead's brief and each worker's brief name the working folder.

## 3. Where events come from

| Source | Events | Trust |
|---|---|---|
| The hub itself | spawn, stop, online/offline, watchdog flags (stalled, usage limit, waiting dialog), task create/update, approval request/decision, chat messages between agents, project created/imported, chat filed, read-only hub tool calls | Authoritative |
| The lead and workers, through channel tools | `share_progress(text, phase, project)` becomes `thinking` (lead) or `progress` (worker); `plan_team(project, rationale, experts[])` becomes `team_plan` (lead only) | Authenticated per session; rate limited (`HUB_PROGRESS_RATE_LIMIT`); phase and roster validated |
| A Claude Code hook in each session | PreToolUse writes the tool name and a one-line preview; Stop writes "idle" | Unauthenticated, display only (see Security) |

**Expert flow.** The lead's role brief now says: decide which expert disciplines the project needs, record them with `plan_team` (key, title, closest template, expertise, why), then `spawn_session(expert_key, expertise)` each one. The spawned session's system prompt gets a "Your expert role" section, its title is filled from the plan, and the live graph turns that planned slot into a running agent.

**Hook.** The hub writes a per-session settings file (`<state>/run/<name>.settings.json`) that merges the role's permission preset with a PreToolUse (matcher `*`) and a Stop hook running `node src/activity-hook.mjs <activity file>`. The hook reads the hook JSON from stdin (capped at 1 MB), appends one JSONL line to a mode-600 file, prints nothing, always exits 0, has a 3 second self-timeout and a 5 second hook timeout, and stops appending if the file passes 2 MB. It never blocks or changes a tool call. The hub drains each file every `HUB_ACTIVITY_POLL_SEC` by renaming and then reading it, so no line is read twice. `HUB_ACTIVITY_HOOKS=0` turns this off.

**Retention.** Tool events are pruned after `HUB_EVENT_RETENTION_DAYS` (default 30) by the watchdog; other events are kept like messages are.

## 4. Transport

No new socket. Events are pushed over the existing authenticated `/ws/ui` WebSocket as `{type: 'agent_event', event}`; the existing Origin check and cookie auth apply. The page loads history with:

- `GET /api/projects/:slug` returns the project, its sessions plus the lead, the latest team plan, and pending approvals.
- `GET /api/projects/:slug/events?after=&before=&limit=` returns event pages (newest 300 first, then "Load older").
- `GET /api/events` returns the same across all projects.
- `GET /api/projects/:slug/files` (admin only) returns a names-and-sizes listing.

Live events are merged by id, so a reconnect or a reload never duplicates a row.

## 5. GUI

All in `public/index.html`, vanilla DOM, no build step, rendered with `textContent` only.

- **Sidebar:** Dashboard, the lead, then **Projects** as folders. Each folder shows status, tasks done and running agents, and expands (caret) to its chats; the expand state is kept in `localStorage` when the browser allows it. Chats without a project are under **Unfiled chats**.
- **Project page** with tabs **Live | Board | Files**, and the folder path in the header (admins).
- **Live tab:**
  - A phase stepper: understand, plan, approve, staff, build, review, report. It follows the latest `phase` the lead or a worker reported, falling back to what the team state implies.
  - A team graph. The lead card shows its latest thought. Under it is one card per planned expert: dashed while planned, solid once an agent is running in that slot, with a status dot, the agent name and template, and a **now:** line with its latest tool call, progress note or status. Agents started without a plan get cards too. Curves link the lead to each expert and flash when that agent does something; cards pulse. Clicking a card opens that agent's chat. At phone width the curves are replaced by an indented column.
  - A timeline, newest first, with filters All, Thinking, Team, Tools, Tasks and Messages. Thoughts are shown as quotes and tool calls as one monospace line.
- **Files tab:** a tree of the project folder (depth 4, at most 1000 entries). Heavy folders such as `node_modules` and `.git` are listed but not walked, and links are shown and never followed.
- **New project dialog:** a Folder field. Leave it empty to create `<projects dir>/<slug>` (the dialog shows the path), or give an existing folder to import.
- **Chat menu (⋯):** move the chat to another project or to Unfiled.
- Observers get the same pages with agent-written text shown as `[N chars]`, no expert reasons, no Files tab, and no folder path.

## 6. Security

- **Path traversal.** Every folder the hub creates, imports or lists goes through `realpath` and the workspace-root check. Imports cannot target the hub's own state or the vault. The listing uses `lstat`/`readdir` without following symlinks and never returns file contents. Slugs and session names are regex-validated before they become paths.
- **What agent output is shown.** Hub-written summaries go to everyone. Agent-written text, tool previews and expert reasons go to admins only (or observers with `HUB_OBSERVER_READ_MESSAGES=1`), on both the API and the WebSocket. Tool previews are passed through a secret-masking filter (Authorization headers, bearer tokens, `*token*`/`*secret*`/`*password*`/`*key*` assignments, known token prefixes, long opaque strings) and clipped to 300 characters before storage. The filter is best effort.
- **Auth on the live feed.** The same cookie or bearer auth and Origin check as the rest of the UI; nothing new is exposed without login. `plan_team` is lead-only and enforced from the database role, like the other lead tools.
- **Hook reports are unauthenticated.** Any process running as the same OS user can append to an activity file, so tool-call rows could be forged. They are display-only and change no state. This is recorded in SECURITY.md.

## 7. Testing

- `test/unit.mjs` (new, no database): secret masking, tool previews, team-plan validation, observer redaction, the hook script (one line per call, no output, exit 0, mode 600, bad input ignored), and the folder listing (sizes, skipped folders, links not followed, depth and entry limits).
- `test/e2e.mjs` (extended): project folder creation, the lead sharing its thinking and planning a team, an expert spawned with its role brief, settings hooks and `--add-dir`, a worker landing in the project folder, tool calls arriving through the real hook with a secret masked, live WebSocket delivery with observer redaction, filing chats, the Files tab, import confinement (outside roots, `..`, symlink to `/etc`, workspace root, missing folder, bad slug, duplicates), the backfill of a legacy project across a restart, and the expert role surviving a restart.
- The UI was checked with a jsdom smoke script against a live demo hub at desktop and phone width, as admin and observer. That script is not committed because it needs jsdom, which the repo does not depend on.

## 8. Limitations and proposed follow-ups

- *Proposed:* show the lead's thinking from before a project exists (today `share_progress` without a project is stored but only shown when it carries the project slug).
- *Proposed:* a per-agent detail drawer in the live view (recent tools and messages) instead of jumping to the chat.
- *Proposed:* replay mode (scrub the timeline and watch the graph rebuild).
- The graph is a simple two-level tree (lead, experts). Experts that start their own sub-agents through Claude Code's Task tool show as tool calls, not as nodes.
- How well the live view reflects the lead's reasoning depends on the lead following its brief and calling `share_progress`; the hub-observed events and hook events appear regardless.
