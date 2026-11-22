-- cc-hub schema. Idempotent: safe to run on every hub start.

-- A project is one body of work (e.g. a research question) with its own
-- vault folder, task board, and sessions.
CREATE TABLE IF NOT EXISTS projects (
  slug        TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  title       TEXT NOT NULL,
  goal        TEXT NOT NULL DEFAULT '',
  repos       TEXT[] NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'planning'
              CHECK (status IN ('planning', 'active', 'paused', 'done')),
  created_by  TEXT NOT NULL DEFAULT 'user',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The project's own working folder on disk (absolute, resolved). Chats, agents
-- and outputs are grouped under it. NULL only for projects created before
-- folders existed; the hub backfills those on start.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dir TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS projects_dir_idx ON projects (dir) WHERE dir IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  name            TEXT PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  role            TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('orchestrator', 'worker')),
  cwd             TEXT NOT NULL,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  secret_hash     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'starting'
                  CHECK (status IN ('starting', 'online', 'offline', 'stopped')),
  created_by      TEXT NOT NULL DEFAULT 'user',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS template      TEXT NOT NULL DEFAULT 'general';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project       TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS worktree      JSONB;      -- {repo, branch, path}
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ;
-- Expert role the lead gave this agent (free text, appended to its brief) and
-- the key of the planned team slot it fills (see agent_events kind 'team_plan').
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expertise     TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expert_key    TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expert_title  TEXT;

CREATE TABLE IF NOT EXISTS messages (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  sender       TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'chat',
  body         TEXT NOT NULL,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivered_at TIMESTAMPTZ,
  tsv          TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
);
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN (
  'chat', 'system', 'permission_request', 'permission_verdict', 'approval_request', 'approval_response')) NOT VALID;

CREATE INDEX IF NOT EXISTS messages_tsv_idx       ON messages USING GIN (tsv);
CREATE INDEX IF NOT EXISTS messages_sender_idx    ON messages (sender, id DESC);
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient, id DESC);
CREATE INDEX IF NOT EXISTS messages_undelivered_idx
  ON messages (recipient, id) WHERE delivered_at IS NULL AND kind IN ('chat', 'system');

-- Shared task board. depends_on lists task ids that must be 'done' first.
CREATE TABLE IF NOT EXISTS tasks (
  id          BIGSERIAL PRIMARY KEY,
  project     TEXT NOT NULL REFERENCES projects(slug) ON UPDATE CASCADE,
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL DEFAULT '',
  acceptance  TEXT NOT NULL DEFAULT '',
  milestone   TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled')),
  priority    INT  NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),  -- 0 = highest
  assignee    TEXT,
  depends_on  BIGINT[] NOT NULL DEFAULT '{}',
  result      TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_project_idx  ON tasks (project, status);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee) WHERE assignee IS NOT NULL;

-- Append-only audit trail of every task change.
CREATE TABLE IF NOT EXISTS task_events (
  id       BIGSERIAL PRIMARY KEY,
  task_id  BIGINT NOT NULL REFERENCES tasks(id),
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor    TEXT NOT NULL,
  change   JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, id);

-- Decisions a session asks the human to approve (plans, risky steps).
CREATE TABLE IF NOT EXISTS approvals (
  id         BIGSERIAL PRIMARY KEY,
  session    TEXT NOT NULL,
  project    TEXT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'changes_requested')),
  response   TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

-- Live activity stream for the agent view: what the lead is thinking, the team
-- it planned, agents starting and stopping, tool use, task and approval changes.
--   summary: written by the hub from validated fields; safe for observers
--   text:    free text written by an agent (thinking, tool input preview, message
--            excerpt); redacted for observers unless HUB_OBSERVER_READ_MESSAGES=1
--   detail:  structured metadata; detail->'private' is removed for observers
CREATE TABLE IF NOT EXISTS agent_events (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  project  TEXT,
  session  TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN (
             'thinking', 'progress', 'team_plan', 'spawn', 'stop', 'status', 'tool',
             'task', 'approval', 'message', 'project')),
  summary  TEXT NOT NULL,
  text     TEXT NOT NULL DEFAULT '',
  detail   JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS agent_events_project_idx ON agent_events (project, id);
CREATE INDEX IF NOT EXISTS agent_events_plan_idx ON agent_events (project, id DESC) WHERE kind = 'team_plan';
