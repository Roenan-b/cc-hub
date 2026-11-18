import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config, ROOT } from './config.mjs';

// BIGINT ids come back as strings by default; they fit safely in JS numbers here.
pg.types.setTypeParser(20, (v) => Number(v));
const parseBigintArray = pg.types.getTypeParser(1016);
pg.types.setTypeParser(1016, (v) => parseBigintArray(v).map(Number));
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function initSchema() {
  const sql = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// ---------------------------------------------------------------- messages
const MSG_COLS = 'id, ts, sender, recipient, kind, body, meta, delivered_at';

export async function insertMessage({ sender, recipient, kind = 'chat', body, meta = {}, delivered = false }) {
  const { rows } = await pool.query(
    `INSERT INTO messages (sender, recipient, kind, body, meta, delivered_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END) RETURNING ${MSG_COLS}`,
    [sender, recipient, kind, body, meta, delivered],
  );
  return rows[0];
}

export async function markDelivered(id) {
  await pool.query('UPDATE messages SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL', [id]);
}

export async function undeliveredFor(name) {
  const { rows } = await pool.query(
    `SELECT ${MSG_COLS} FROM messages
     WHERE recipient = $1 AND kind IN ('chat', 'system') AND delivered_at IS NULL ORDER BY id`,
    [name],
  );
  return rows;
}

export async function threadFor(name, { beforeId = null, limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${MSG_COLS} FROM messages
     WHERE (sender = $1 OR recipient = $1) AND ($2::bigint IS NULL OR id < $2)
     ORDER BY id DESC LIMIT $3`,
    [name, beforeId, Math.min(limit, 500)],
  );
  return rows.reverse();
}

export async function searchMessages({ query, session = null, limit = 20 }) {
  const { rows } = await pool.query(
    `SELECT ${MSG_COLS},
            ts_headline('english', body, q, 'MaxFragments=2,MaxWords=30,MinWords=10') AS snippet
     FROM messages, websearch_to_tsquery('english', $1) q
     WHERE (tsv @@ q OR body ILIKE '%' || $4 || '%' ESCAPE '\\')
       AND ($2::text IS NULL OR sender = $2 OR recipient = $2)
     ORDER BY ts_rank(tsv, q) DESC, id DESC
     LIMIT $3`,
    [query, session, Math.min(limit, 100), query.replace(/[\\%_]/g, (c) => '\\' + c)],
  );
  return rows;
}

// ---------------------------------------------------------------- sessions
export async function listSessions() {
  const { rows } = await pool.query(
    `SELECT s.name, s.role, s.template, s.project, s.cwd, s.worktree, s.permission_mode, s.status,
            s.created_by, s.created_at, s.last_seen, s.last_activity
     FROM sessions s ORDER BY (s.role = 'orchestrator') DESC, s.created_at`,
  );
  return rows;
}

export async function getSession(name) {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE name = $1', [name]);
  return rows[0] || null;
}

export async function upsertSession(s) {
  await pool.query(
    `INSERT INTO sessions (name, role, cwd, permission_mode, secret_hash, status, created_by, template, project, worktree, last_activity)
     VALUES ($1, $2, $3, $4, $5, 'starting', $6, $7, $8, $9, now())
     ON CONFLICT (name) DO UPDATE SET role = $2, cwd = $3, permission_mode = $4, secret_hash = $5,
       status = 'starting', created_by = $6, template = $7, project = $8, worktree = $9,
       created_at = now(), last_activity = now()`,
    [s.name, s.role, s.cwd, s.permissionMode, s.secretHash, s.createdBy, s.template, s.project, s.worktree],
  );
}

export async function setStatus(name, status) {
  await pool.query(
    `UPDATE sessions SET status = $2, last_seen = CASE WHEN $2 = 'online' THEN now() ELSE last_seen END
     WHERE name = $1`,
    [name, status],
  );
}

export async function touchActivity(name) {
  await pool.query('UPDATE sessions SET last_activity = now() WHERE name = $1', [name]);
}

export async function deleteSession(name) {
  await pool.query('DELETE FROM sessions WHERE name = $1', [name]);
}

// ---------------------------------------------------------------- projects
export async function createProject({ slug, title, goal, repos, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO projects (slug, title, goal, repos, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [slug, title, goal, repos, createdBy],
  );
  return rows[0];
}

export async function updateProject(slug, { status, goal, title }) {
  const { rows } = await pool.query(
    `UPDATE projects SET status = COALESCE($2, status), goal = COALESCE($3, goal), title = COALESCE($4, title),
       updated_at = now() WHERE slug = $1 RETURNING *`,
    [slug, status ?? null, goal ?? null, title ?? null],
  );
  return rows[0] || null;
}

export async function getProject(slug) {
  const { rows } = await pool.query('SELECT * FROM projects WHERE slug = $1', [slug]);
  return rows[0] || null;
}

export async function listProjects() {
  const { rows } = await pool.query(
    `SELECT p.*,
       (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM tasks t WHERE t.project = p.slug GROUP BY status) c) AS task_counts
     FROM projects p ORDER BY (p.status IN ('active', 'planning')) DESC, p.updated_at DESC`,
  );
  return rows;
}

// ---------------------------------------------------------------- tasks
export async function createTask(t) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (project, title, spec, acceptance, milestone, priority, assignee, depends_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [t.project, t.title, t.spec, t.acceptance, t.milestone, t.priority, t.assignee, t.depends_on, t.created_by],
  );
  await logTaskEvent(rows[0].id, t.created_by, { created: true, assignee: t.assignee });
  return rows[0];
}

export async function getTask(id) {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  return rows[0] || null;
}

const TASK_FIELDS = new Set(['title', 'spec', 'acceptance', 'milestone', 'status', 'priority', 'assignee', 'depends_on', 'result']);

export async function updateTask(id, fields, actor) {
  const sets = []; const vals = [id];
  for (const [k, v] of Object.entries(fields)) {
    if (!TASK_FIELDS.has(k)) throw new Error(`invalid task field ${k}`);
    vals.push(v); sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return getTask(id);
  const { rows } = await pool.query(
    `UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals,
  );
  await logTaskEvent(id, actor, fields);
  return rows[0];
}

async function logTaskEvent(taskId, actor, change) {
  await pool.query('INSERT INTO task_events (task_id, actor, change) VALUES ($1, $2, $3)', [taskId, actor, change]);
}

export async function listTasks({ project = null, status = null, assignee = null } = {}) {
  const { rows } = await pool.query(
    `SELECT t.*,
       COALESCE((SELECT bool_and(d.status = 'done') FROM tasks d WHERE d.id = ANY(t.depends_on)), true) AS deps_done
     FROM tasks t
     WHERE ($1::text IS NULL OR project = $1) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR assignee = $3)
     ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'review' THEN 1 WHEN 'blocked' THEN 2 WHEN 'todo' THEN 3 ELSE 4 END,
              priority, id`,
    [project, status, assignee],
  );
  return rows;
}

export async function taskEvents(taskId) {
  const { rows } = await pool.query('SELECT ts, actor, change FROM task_events WHERE task_id = $1 ORDER BY id', [taskId]);
  return rows;
}

// ---------------------------------------------------------------- approvals
export async function createApproval({ session, project, title, body }) {
  const { rows } = await pool.query(
    'INSERT INTO approvals (session, project, title, body) VALUES ($1, $2, $3, $4) RETURNING *',
    [session, project, title, body],
  );
  return rows[0];
}

export async function decideApproval(id, status, response) {
  const { rows } = await pool.query(
    `UPDATE approvals SET status = $2, response = $3, decided_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, status, response],
  );
  return rows[0] || null;
}

export async function pendingApprovals() {
  const { rows } = await pool.query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id");
  return rows;
}

// ---------------------------------------------------------------- dashboard
export async function activity({ limit = 60, includeBodies = true } = {}) {
  const { rows } = await pool.query(
    `(SELECT 'task' AS type, e.ts, e.actor AS who, t.project, t.id AS task_id, t.title AS text, e.change AS detail
        FROM task_events e JOIN tasks t ON t.id = e.task_id ORDER BY e.id DESC LIMIT $1)
     UNION ALL
     (SELECT 'message', m.ts, m.sender, NULL, NULL,
             CASE WHEN $2 THEN left(m.body, 200) ELSE '[' || length(m.body) || ' chars]' END,
             jsonb_build_object('recipient', m.recipient, 'kind', m.kind)
        FROM messages m WHERE m.kind <> 'system' ORDER BY m.id DESC LIMIT $1)
     ORDER BY ts DESC LIMIT $1`,
    [limit, includeBodies],
  );
  return rows;
}

export async function stats() {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*) FROM messages WHERE ts > now() - interval '24 hours')::int AS messages_24h,
       (SELECT count(*) FROM task_events WHERE change->>'status' = 'done' AND ts > now() - interval '24 hours')::int AS tasks_done_24h,
       (SELECT count(*) FROM tasks WHERE status = 'in_progress')::int AS tasks_in_progress,
       (SELECT count(*) FROM tasks WHERE status = 'blocked')::int AS tasks_blocked,
       (SELECT count(*) FROM approvals WHERE status = 'pending')::int AS approvals_pending`,
  );
  return rows[0];
}

if (process.argv.includes('--init')) {
  initSchema().then(() => { console.log('schema ready'); return pool.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
