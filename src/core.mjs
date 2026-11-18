// Core hub logic shared by the HTTP API, the agent RPC API, and the watchdog:
// live connection state, messaging, session lifecycle, projects, tasks, approvals.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.mjs';
import * as db from './db.mjs';
import * as git from './git.mjs';
import * as tmux from './tmux.mjs';
import * as vault from './vault.mjs';

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', ...(config.allowBypassPermissions ? ['bypassPermissions'] : [])]);
const ROLES_DIR = path.join(ROOT, 'roles');
const CHANNEL_PATH = path.join(ROOT, 'src', 'channel.mjs');
const RUN_DIR = path.join(config.stateDir, 'run');
fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

export function templates() {
  return fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
}

// ---------------------------------------------------------------- live state
export const agents = new Map();        // session name -> ws
export const uiClients = new Set();     // { ws, level }
export const pendingPerms = new Map();  // `${session}:${request_id}` -> request
export const flags = new Map();         // session name -> { usage_limit?, waiting_dialog?, stalled? }
const peerSendLog = new Map();

/** Send an event to every connected UI. Observers get a redacted copy when needed. */
export function broadcastUI(event) {
  const full = JSON.stringify(event);
  let redacted = null;
  for (const c of uiClients) {
    if (c.ws.readyState !== c.ws.OPEN) continue;
    if (c.level === 'admin' || config.observerCanReadMessages) { c.ws.send(full); continue; }
    if (event.type === 'message') {
      redacted ??= JSON.stringify({ type: 'message', msg: redactMessage(event.msg) });
      c.ws.send(redacted);
    } else if (event.type !== 'permissions') {
      c.ws.send(full);
    }
  }
}
export const redactMessage = (m) => ({ ...m, body: `[${m.body.length} chars]`, meta: {} });

export async function sessionsView() {
  const rows = await db.listSessions();
  return rows.map((s) => ({ ...s, connected: agents.has(s.name), flags: flags.get(s.name) || {} }));
}
export async function broadcastSessions() {
  broadcastUI({ type: 'sessions', sessions: await sessionsView() });
}
export async function leadNames() {
  return (await db.listSessions()).filter((s) => s.role === 'orchestrator' && s.status !== 'stopped').map((s) => s.name);
}

// ---------------------------------------------------------------- messaging
export function checkText(text, max = config.maxMessageChars) {
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
  if (text.length > max) throw new HttpError(413, `text exceeds ${max} chars`);
}

/** Persist a message and push it to its recipient (UI or session). */
export async function postMessage({ sender, recipient, body, kind = 'chat', meta = {} }) {
  checkText(body);
  if (recipient !== 'user' && !(await db.getSession(recipient))) {
    throw new HttpError(404, `no session named ${recipient}`);
  }
  const msg = await db.insertMessage({ sender, recipient, kind, body, meta });
  broadcastUI({ type: 'message', msg });
  if (recipient !== 'user' && (kind === 'chat' || kind === 'system')) deliver(recipient, msg);
  if (sender !== 'user' && sender !== 'hub') db.touchActivity(sender).catch(() => {});
  return msg;
}

/** System notice from the hub to a session (delivered as from="hub"). */
export const notify = (recipient, body) => postMessage({ sender: 'hub', recipient, body, kind: 'system' }).catch((e) => log(`notify ${recipient}: ${e.message}`));

export function deliver(name, msg) {
  const ws = agents.get(name);
  if (!ws || ws.readyState !== ws.OPEN) return; // stays queued
  ws.send(JSON.stringify({ type: 'deliver', msg: { id: msg.id, sender: msg.sender, body: msg.body, ts: msg.ts } }));
}

export function checkPeerRate(sender) {
  const now = Date.now();
  const recent = (peerSendLog.get(sender) || []).filter((t) => now - t < 60_000);
  if (recent.length >= config.peerRateLimitPerMin) {
    throw new HttpError(429, `rate limit: ${config.peerRateLimitPerMin} peer messages per minute`);
  }
  recent.push(now);
  peerSendLog.set(sender, recent);
}

// ---------------------------------------------------------------- paths
function allowedRoots() {
  return [...config.workspaceRoots, config.worktreeDir];
}
export function resolveDir(dir, what = 'cwd') {
  if (typeof dir !== 'string' || !dir) throw new HttpError(400, `${what} is required`);
  let real;
  try { real = fs.realpathSync(path.resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME || '~'))); }
  catch { throw new HttpError(400, `directory does not exist: ${dir}`); }
  if (!fs.statSync(real).isDirectory()) throw new HttpError(400, `not a directory: ${dir}`);
  const roots = allowedRoots().map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
  if (!roots.some((root) => real === root || real.startsWith(root + path.sep))) {
    throw new HttpError(403, `${what} must be under one of: ${config.workspaceRoots.join(', ')}`);
  }
  return real;
}

// ---------------------------------------------------------------- sessions
// The human's operating profile, if their vault has one. Loaded into every
// session's system prompt so preferences and hard rules apply to all agents.
const PROFILE_MAX = 12000;
function humanProfile() {
  const file = path.join(config.vault, 'Me', 'Working with me.md');
  try {
    let text = fs.readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    if (text.length > PROFILE_MAX) text = `${text.slice(0, PROFILE_MAX)}\n[truncated; read the full note at ${file}]`;
    return text;
  } catch { return ''; }
}

export function roleBrief(template, { name, project }) {
  const file = path.join(ROLES_DIR, `${template}.md`);
  const brief = fs.readFileSync(file, 'utf8');
  const profile = humanProfile();
  const about = path.join(config.vault, 'Me', 'About me.md');
  return [
    `You are the Claude Code session "${name}" on cc-hub${project ? `, working on project "${project}"` : ''}.`,
    `The shared Obsidian vault is at ${config.vault} (read ${path.join(config.vault, 'Conventions.md')} before writing to it).`,
    project ? `Your project's notes live in ${vault.projectDir(config.vault, project)}.` : '',
    fs.existsSync(about) ? `Who the human is, their projects and constraints: ${about}. Read it before planning or when context about them matters.` : '',
    '',
    brief,
    profile ? `\n# The human's operating profile (from their vault; these rules override defaults)\n\n${profile}` : '',
  ].join('\n');
}

export async function spawnSession(opts) {
  const {
    name, cwd, role = 'worker', template = role === 'orchestrator' ? 'lead' : 'general',
    permissionMode = 'default', prompt = '', createdBy = 'user', project = null, repo = null, branch = null,
  } = opts;
  if (!NAME_RE.test(name || '')) throw new HttpError(400, 'name must match ^[a-z0-9][a-z0-9-]{0,31}$');
  if (['user', 'hub'].includes(name)) throw new HttpError(400, 'reserved name');
  if (!['worker', 'orchestrator'].includes(role)) throw new HttpError(400, 'bad role');
  if (!templates().includes(template)) throw new HttpError(400, `template must be one of: ${templates().join(', ')}`);
  if (role === 'worker' && template === 'lead') throw new HttpError(400, 'workers cannot use the lead template');
  if (!PERMISSION_MODES.has(permissionMode)) throw new HttpError(400, `permission_mode must be one of: ${[...PERMISSION_MODES].join(', ')}`);
  if (project && !(await db.getProject(project))) throw new HttpError(404, `no project ${project}`);
  if (await tmux.hasSession(name)) throw new HttpError(409, `tmux session ${tmux.tmuxName(name)} already exists`);
  // Validate the working directory before anything is created.
  let realCwd; let worktree = null; let realRepo = null;
  if (repo || branch) {
    if (!repo || !branch) throw new HttpError(400, 'repo and branch must be given together');
    if (!git.BRANCH_RE.test(branch)) throw new HttpError(400, 'invalid branch name');
    realRepo = resolveDir(repo, 'repo');
  } else if (!(role === 'orchestrator' && name === 'orchestrator')) {
    realCwd = resolveDir(cwd);
  }
  if (role === 'worker') {
    const live = (await db.listSessions()).filter((s) => s.role === 'worker' && s.status !== 'stopped' && s.name !== name);
    if (live.length >= config.maxWorkers) {
      throw new HttpError(429, `worker limit reached (${config.maxWorkers}); stop a finished worker or raise HUB_MAX_WORKERS`);
    }
  }

  // Working directory: a fresh git worktree when repo+branch are given.
  if (realRepo) {
    try {
      const wt = await git.addWorktree({ repo: realRepo, branch, dest: path.join(config.worktreeDir, name) });
      realCwd = fs.realpathSync(wt.path);
      worktree = { repo: realRepo, branch, path: realCwd, reused: wt.reused };
    } catch (e) { throw new HttpError(400, `worktree: ${e.message}`); }
  } else if (role === 'orchestrator' && name === 'orchestrator') {
    fs.mkdirSync(config.orchestratorCwd, { recursive: true });
    realCwd = config.orchestratorCwd;
  }

  const secret = crypto.randomBytes(32).toString('base64url');
  await db.upsertSession({
    name, role, cwd: realCwd, permissionMode, secretHash: sha256(secret), createdBy, template, project, worktree,
  });

  const mcpFile = path.join(RUN_DIR, `${name}.mcp.json`);
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: {
      hub: {
        command: config.nodeBin,
        args: [CHANNEL_PATH],
        env: {
          HUB_URL: `ws://127.0.0.1:${config.port}/ws/agent`,
          HUB_SESSION: name,
          HUB_SESSION_SECRET: secret,
          HUB_ROLE: role,          // selects which tools are listed; the hub enforces role from the DB
          HUB_TEMPLATE: template,
          HUB_PROJECT: project || '',
        },
      },
    },
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(mcpFile, 0o600);

  // The system prompt can exceed tmux's ~16 KB command limit, so it goes in a
  // file and a small launcher script passes it to claude.
  const promptFile = path.join(RUN_DIR, `${name}.prompt.md`);
  fs.writeFileSync(promptFile, roleBrief(template, { name, project }), { mode: 0o600 });
  const claudeArgs = [
    config.claudeBin,
    '--mcp-config', mcpFile,
    '--dangerously-load-development-channels', 'server:hub',
  ];
  if (fs.existsSync(config.vault) && !realCwd.startsWith(config.vault)) claudeArgs.push('--add-dir', config.vault);
  if (permissionMode !== 'default') claudeArgs.push('--permission-mode', permissionMode);
  const settings = path.join(ROOT, 'settings', `${role === 'orchestrator' ? 'lead' : 'worker'}.json`);
  if (fs.existsSync(settings)) claudeArgs.push('--settings', settings);
  const launcher = path.join(RUN_DIR, `${name}.launch.sh`);
  fs.writeFileSync(launcher, [
    '#!/bin/sh',
    '# Generated by cc-hub for one session; regenerated on every start.',
    `exec ${claudeArgs.map(tmux.shQuote).join(' ')} --append-system-prompt "$(cat ${tmux.shQuote(promptFile)})"`,
    '',
  ].join('\n'), { mode: 0o700 });
  fs.chmodSync(launcher, 0o700);
  const argv = ['/bin/sh', launcher];

  if (prompt && prompt.trim()) await postMessage({ sender: createdBy, recipient: name, body: prompt });
  await tmux.newSession(name, realCwd, argv);
  log(`spawned ${name} (${role}/${template}${project ? `, ${project}` : ''}) in ${realCwd} by ${createdBy}`);
  tmux.autoAcceptStartupDialogs(name, { isDone: () => agents.has(name), log })
    .then((ok) => { if (!ok) log(`[${name}] channel did not connect; check the pane`); })
    .catch((e) => log(`[${name}] dialog watcher error: ${e.message}`));
  await db.insertMessage({
    sender: 'hub', recipient: name, kind: 'system', delivered: true,
    body: `Session started by ${createdBy} (${template}) in ${realCwd}${worktree ? ` on branch ${branch}` : ''}`,
  });
  await broadcastSessions();
  return { name, role, template, project, cwd: realCwd, worktree, permission_mode: permissionMode };
}

export async function stopSession(name, { forget = false } = {}) {
  await tmux.killSession(name);
  agents.get(name)?.close(4000, 'session stopped');
  agents.delete(name);
  flags.delete(name);
  for (const ext of ['mcp.json', 'prompt.md', 'launch.sh']) fs.rmSync(path.join(RUN_DIR, `${name}.${ext}`), { force: true });
  if (forget) await db.deleteSession(name);
  else await db.setStatus(name, 'stopped');
  log(`stopped ${name}${forget ? ' (forgotten)' : ''}`);
  await broadcastSessions();
}

export async function restartSession(name, by = 'user') {
  const s = await db.getSession(name);
  if (!s) throw new HttpError(404, 'no such session');
  await stopSession(name);
  const wt = s.worktree;
  return spawnSession({
    name, cwd: wt ? undefined : s.cwd, role: s.role, template: s.template, project: s.project,
    permissionMode: s.permission_mode, createdBy: by,
    repo: wt?.repo || null, branch: wt?.branch || null,
    prompt: by === 'user' ? '' : 'You were restarted with a fresh context. Check your assigned tasks with task_list and continue.',
  });
}

export async function reconcile() {
  const live = new Set(await tmux.listSessions());
  for (const s of await db.listSessions()) {
    const want = agents.has(s.name) ? 'online' : live.has(s.name) ? (s.status === 'starting' ? 'starting' : 'offline') : 'stopped';
    if (want !== s.status) await db.setStatus(s.name, want);
  }
  await broadcastSessions();
}

// ---------------------------------------------------------------- projects
export async function createProject({ slug, title, goal = '', repos = [], createdBy }) {
  if (!SLUG_RE.test(slug || '')) throw new HttpError(400, 'slug must match ^[a-z0-9][a-z0-9-]{0,39}$');
  if (typeof title !== 'string' || !title.trim()) throw new HttpError(400, 'title is required');
  if (!Array.isArray(repos)) throw new HttpError(400, 'repos must be an array');
  const realRepos = repos.map((r) => resolveDir(r, 'repo'));
  if (await db.getProject(slug)) throw new HttpError(409, `project ${slug} already exists`);
  const project = await db.createProject({ slug, title: title.trim(), goal, repos: realRepos, createdBy });
  const dir = vault.initProjectFolder(config.vault, project);
  broadcastUI({ type: 'projects' });
  log(`project ${slug} created by ${createdBy}`);
  return { ...project, vault_dir: dir };
}

// ---------------------------------------------------------------- tasks
const WORKER_STATUSES = new Set(['in_progress', 'review', 'blocked']);
const fmtTask = (t) => `#${t.id} [${t.project}] ${t.title}`;
const taskBrief = (t) => [
  `Task ${fmtTask(t)} (priority P${t.priority}${t.milestone ? `, milestone ${t.milestone}` : ''})`,
  t.spec && `Spec:\n${t.spec}`,
  t.acceptance && `Acceptance criteria:\n${t.acceptance}`,
  t.depends_on.length ? `Depends on: ${t.depends_on.map((d) => `#${d}`).join(', ')}` : '',
  'Use task_get for details, task_update to change status, and write notes in the project vault folder.',
].filter(Boolean).join('\n\n');

function checkTaskInput(t, partial = false) {
  const str = (k, max) => {
    if (t[k] === undefined) { if (!partial && k === 'title') throw new HttpError(400, 'title is required'); return; }
    if (typeof t[k] !== 'string' || t[k].length > max) throw new HttpError(400, `${k} must be a string up to ${max} chars`);
  };
  str('title', 200); str('spec', 20000); str('acceptance', 5000); str('milestone', 100); str('result', 20000);
  if (t.priority !== undefined && !(Number.isInteger(t.priority) && t.priority >= 0 && t.priority <= 3)) throw new HttpError(400, 'priority must be 0-3');
  if (t.depends_on !== undefined && !(Array.isArray(t.depends_on) && t.depends_on.every((d) => Number.isInteger(d) && d > 0))) {
    throw new HttpError(400, 'depends_on must be an array of task ids');
  }
}

export async function createTask(input, actor) {
  checkTaskInput(input);
  if (!(await db.getProject(input.project))) throw new HttpError(404, `no project ${input.project}`);
  const isLead = actor.role === 'orchestrator' || actor.name === 'user';
  if (input.assignee && !isLead) throw new HttpError(403, 'only the lead can assign tasks when creating them');
  if (input.assignee && !(await db.getSession(input.assignee))) throw new HttpError(404, `no session ${input.assignee}`);
  for (const d of input.depends_on || []) if (!(await db.getTask(d))) throw new HttpError(404, `no task #${d}`);
  const task = await db.createTask({
    project: input.project, title: input.title.trim(), spec: input.spec || '', acceptance: input.acceptance || '',
    milestone: input.milestone || '', priority: input.priority ?? 2, assignee: input.assignee || null,
    depends_on: input.depends_on || [], created_by: actor.name,
  });
  broadcastUI({ type: 'task', task });
  if (task.assignee && task.assignee !== actor.name) notify(task.assignee, `You have been assigned a new task.\n\n${taskBrief(task)}`);
  if (!isLead) for (const l of await leadNames()) notify(l, `${actor.name} proposed a new task ${fmtTask(task)} (unassigned).`);
  return task;
}

/**
 * Apply a task update with role-based rules:
 *  - lead (orchestrator) and the human: any change
 *  - reviewer template: tasks in review assigned to them -> done, or back to in_progress with a new assignee
 *  - other workers: their own tasks -> in_progress / review / blocked, result; or claim an unassigned,
 *    unblocked todo task
 */
export async function updateTask(id, changes, actor) {
  checkTaskInput(changes, true);
  const task = await db.getTask(id);
  if (!task) throw new HttpError(404, `no task #${id}`);
  const isLead = actor.role === 'orchestrator' || actor.name === 'user';
  const fields = {};
  for (const k of ['title', 'spec', 'acceptance', 'milestone', 'priority', 'depends_on', 'result', 'status', 'assignee']) {
    if (changes[k] !== undefined) fields[k] = changes[k];
  }
  if (fields.status && !['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'].includes(fields.status)) {
    throw new HttpError(400, 'invalid status');
  }
  if (fields.assignee && !(await db.getSession(fields.assignee))) throw new HttpError(404, `no session ${fields.assignee}`);

  if (!isLead) {
    const keys = Object.keys(fields);
    const mine = task.assignee === actor.name;
    const claiming = !task.assignee && task.status === 'todo' && fields.assignee === actor.name;
    if (claiming) {
      const [row] = await db.listTasks({ project: task.project }).then((r) => r.filter((t) => t.id === task.id));
      if (!row.deps_done) throw new HttpError(409, 'cannot claim: dependencies are not done');
      fields.status ??= 'in_progress';
    } else if (actor.template === 'reviewer' && mine && task.status === 'review') {
      if (!keys.every((k) => ['status', 'result', 'assignee'].includes(k))) throw new HttpError(403, 'reviewers may only change status, result, and assignee');
      if (fields.status && !['done', 'in_progress'].includes(fields.status)) throw new HttpError(403, 'reviewers set done (pass) or in_progress (changes needed)');
    } else if (mine) {
      if (!keys.every((k) => ['status', 'result'].includes(k))) throw new HttpError(403, 'workers may only change status and result on their own tasks');
      if (fields.status && !WORKER_STATUSES.has(fields.status)) throw new HttpError(403, 'workers may set in_progress, review, or blocked; review decides done');
    } else {
      throw new HttpError(403, `task #${id} is assigned to ${task.assignee || 'nobody'}; ask the lead`);
    }
  }

  const updated = await db.updateTask(id, fields, actor.name);
  broadcastUI({ type: 'task', task: updated });

  // Notifications (never to the actor).
  const leads = (await leadNames()).filter((n) => n !== actor.name);
  if (fields.assignee && fields.assignee !== task.assignee && fields.assignee !== actor.name) {
    notify(fields.assignee, `Task assigned to you by ${actor.name}.\n\n${taskBrief(updated)}${updated.result ? `\n\nLatest result/notes:\n${updated.result}` : ''}`);
  }
  if (fields.status && fields.status !== task.status) {
    const line = `${fmtTask(updated)}: ${task.status} -> ${fields.status} by ${actor.name}${updated.result ? `\nResult: ${updated.result.slice(0, 1500)}` : ''}`;
    if (['review', 'blocked', 'done'].includes(fields.status)) for (const l of leads) notify(l, line);
    if (fields.status === 'done') {
      const unblocked = (await db.listTasks({ project: updated.project, status: 'todo' }))
        .filter((t) => t.deps_done && t.depends_on.includes(updated.id));
      if (unblocked.length) for (const l of leads) notify(l, `Now unblocked: ${unblocked.map(fmtTask).join('; ')}`);
    }
  }
  return updated;
}

// ---------------------------------------------------------------- approvals
export async function requestApproval({ session, title, body }) {
  checkText(title, 200); checkText(body);
  const s = await db.getSession(session);
  const approval = await db.createApproval({ session, project: s?.project || null, title, body });
  await postMessage({
    sender: session, recipient: 'user', kind: 'approval_request',
    body: `${title}\n\n${body}`, meta: { approval_id: approval.id, title, status: 'pending' },
  });
  broadcastUI({ type: 'approvals' });
  return { approval_id: approval.id, status: 'pending', note: 'The human will answer; the decision arrives as a message.' };
}

export async function decideApproval(id, decision, response = '') {
  if (!['approved', 'changes_requested'].includes(decision)) throw new HttpError(400, 'decision must be approved or changes_requested');
  if (typeof response !== 'string' || response.length > 10000) throw new HttpError(400, 'response too long');
  if (decision === 'changes_requested' && !response.trim()) throw new HttpError(400, 'say what should change');
  const a = await db.decideApproval(id, decision, response);
  if (!a) throw new HttpError(404, 'no pending approval with that id');
  const verdict = decision === 'approved' ? 'APPROVED' : 'CHANGES REQUESTED';
  await postMessage({
    sender: 'user', recipient: a.session,
    body: `Approval #${a.id} "${a.title}": ${verdict}${response.trim() ? `\n\n${response.trim()}` : ''}`,
    meta: { approval_id: a.id, decision },
  });
  broadcastUI({ type: 'approvals' });
  return a;
}
