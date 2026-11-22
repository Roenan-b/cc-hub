// Core hub logic shared by the HTTP API, the agent RPC API, and the watchdog:
// live connection state, messaging, session lifecycle, projects, tasks, approvals.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.mjs';
import * as db from './db.mjs';
import { normalizeTeamPlan, PHASES, redactEvent, scrubSecrets, TEXT_MAX } from './events.mjs';
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
    } else if (event.type === 'agent_event') {
      redacted ??= JSON.stringify({ type: 'agent_event', event: redactEvent(event.event) });
      c.ws.send(redacted);
    } else if (event.type !== 'permissions') {
      c.ws.send(full);
    }
  }
}
export const redactMessage = (m) => ({ ...m, body: `[${m.body.length} chars]`, meta: {} });

// ---------------------------------------------------------------- live agent events
const clipText = (t, n = TEXT_MAX) => { const s = String(t ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/**
 * Record one event for the live agent view and push it to every UI.
 * `summary` must be built by the hub from validated values; agent-written text
 * goes in `text` (redacted for observers) and sensitive structure in detail.private.
 */
export async function recordEvent({ project, session, kind, summary, text = '', detail = {} }) {
  try {
    if (project === undefined) project = (await db.getSession(session))?.project || null;
    const event = await db.insertEvent({ project, session, kind, summary: clipText(summary, 300), text: clipText(text), detail });
    broadcastUI({ type: 'agent_event', event });
    return event;
  } catch (e) {
    log(`event ${kind} for ${session}: ${e.message}`); // the live view must never break real work
    return null;
  }
}
const ev = (...a) => { recordEvent(...a); }; // fire and forget where the caller should not wait

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
  if (kind === 'chat' && sender !== 'hub') {
    const agent = sender === 'user' ? recipient : sender;
    const who = (n) => (n === 'user' ? 'you' : n);
    // Attach to a project when either side is filed under one (the lead is not).
    const sides = await Promise.all([sender, recipient].filter((n) => n !== 'user').map((n) => db.getSession(n)));
    const project = sides.find((x) => x?.project)?.project || null;
    ev({ project, session: agent, kind: 'message', summary: `${who(sender)} → ${who(recipient)} (${body.length} chars)`,
      text: body, detail: { from: sender, to: recipient, message_id: msg.id } });
  }
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

const isWithin = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * The folder a project lives in. With `dir`, an existing folder is imported:
 * it must already exist, resolve (after symlinks) inside a workspace root, not
 * be a root itself, and not overlap the hub's own state or another project.
 * Without `dir`, <HUB_PROJECTS_DIR>/<slug> is created. The slug regex has no
 * dots or separators, so the created path cannot leave the projects folder.
 */
export async function resolveProjectFolder(slug, dir) {
  let real;
  if (dir) {
    real = resolveDir(dir, 'dir');
    const roots = config.workspaceRoots.map(realOr);
    if (roots.includes(real)) throw new HttpError(400, 'dir cannot be a whole workspace root; pick or create a folder inside it');
    if (real === realOr(config.projectsDir)) throw new HttpError(400, 'dir cannot be the projects folder itself');
    for (const off of [config.stateDir, config.vault]) {
      const o = realOr(off);
      if (isWithin(real, o) || isWithin(o, real)) throw new HttpError(400, 'dir cannot contain or be inside the hub state folder or the vault');
    }
  } else {
    if (!SLUG_RE.test(slug || '')) throw new HttpError(400, 'slug must match ^[a-z0-9][a-z0-9-]{0,39}$');
    const base = config.projectsDir;
    fs.mkdirSync(base, { recursive: true });
    const target = path.join(realOr(base), slug);
    fs.mkdirSync(target, { recursive: true });
    real = fs.realpathSync(target);
    // Re-check after creation: a pre-existing symlink at <projects>/<slug> must not point elsewhere.
    if (path.dirname(real) !== realOr(base)) throw new HttpError(400, `${target} is a link to somewhere else; remove it or import a folder with dir`);
    resolveDir(real, 'dir');
  }
  const owner = await db.projectByDir(real);
  if (owner && owner.slug !== slug) throw new HttpError(409, `folder already belongs to project ${owner.slug}`);
  return real;
}

/** Give every project created before folders existed its own folder. */
export async function ensureProjectFolders() {
  for (const p of await db.listProjects()) {
    if (p.dir) continue;
    try {
      const dir = await resolveProjectFolder(p.slug, null);
      await db.setProjectDir(p.slug, dir);
      log(`project ${p.slug}: created folder ${dir}`);
    } catch (e) { log(`project ${p.slug}: no folder (${e.message})`); }
  }
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

export function roleBrief(template, { name, project, projectDir = null, expertise = '', expertTitle = '' }) {
  const file = path.join(ROLES_DIR, `${template}.md`);
  const brief = fs.readFileSync(file, 'utf8');
  const profile = humanProfile();
  const about = path.join(config.vault, 'Me', 'About me.md');
  return [
    `You are the Claude Code session "${name}" on cc-hub${project ? `, working on project "${project}"` : ''}.`,
    `The shared Obsidian vault is at ${config.vault} (read ${path.join(config.vault, 'Conventions.md')} before writing to it).`,
    project ? `Your project's notes live in ${vault.projectDir(config.vault, project)}.` : '',
    projectDir ? `Your project's working folder is ${projectDir}. Put deliverables and outputs there (code that belongs to a repository stays in its worktree).` : '',
    expertise || expertTitle ? `\n# Your expert role${expertTitle ? `: ${expertTitle}` : ''}\n\nThe lead staffed you as this expert. Apply this expertise to every task:\n\n${expertise}` : '',
    fs.existsSync(about) ? `Who the human is, their projects and constraints: ${about}. Read it before planning or when context about them matters.` : '',
    '',
    brief,
    profile ? `\n# The human's operating profile (from their vault; these rules override defaults)\n\n${profile}` : '',
  ].join('\n');
}

// Per-session Claude Code settings: the role preset plus, when enabled, hooks
// that report each tool call to the live agent view. Written to RUN_DIR so the
// presets in settings/ stay as the user edited them.
export const activityFile = (name) => path.join(RUN_DIR, `${name}.activity.jsonl`);
const HOOK_SCRIPT = path.join(ROOT, 'src', 'activity-hook.mjs');

function sessionSettings(name, role) {
  const preset = path.join(ROOT, 'settings', `${role === 'orchestrator' ? 'lead' : 'worker'}.json`);
  let base = {};
  if (fs.existsSync(preset)) {
    if (!config.activityHooks) return preset;
    try { base = JSON.parse(fs.readFileSync(preset, 'utf8')); } catch (e) { throw new HttpError(500, `settings preset ${preset}: ${e.message}`); }
  } else if (!config.activityHooks) return null;
  const command = [config.nodeBin, HOOK_SCRIPT, activityFile(name)].map(tmux.shQuote).join(' ');
  const hook = { hooks: [{ type: 'command', command, timeout: 5 }] };
  const hooks = { ...(base.hooks || {}) };
  hooks.PreToolUse = [...(hooks.PreToolUse || []), { matcher: '*', ...hook }];
  hooks.Stop = [...(hooks.Stop || []), hook];
  const file = path.join(RUN_DIR, `${name}.settings.json`);
  fs.writeFileSync(file, JSON.stringify({ ...base, hooks }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * Read and clear every session's activity file, turning hook reports into
 * live events. Renaming first means a hook appending mid-read writes to a new
 * file instead of being truncated away.
 */
export async function drainActivity() {
  for (const s of await db.listSessions()) {
    if (s.status === 'stopped') continue;
    const file = activityFile(s.name);
    const taken = `${file}.${process.pid}.reading`;
    try { await fs.promises.rename(file, taken); } catch { continue; }
    let lines = [];
    try { lines = (await fs.promises.readFile(taken, 'utf8')).split('\n').filter(Boolean).slice(-200); }
    finally { await fs.promises.rm(taken, { force: true }); }
    let last = null;
    for (const raw of lines) {
      let a; try { a = JSON.parse(raw); } catch { continue; }
      if (a.event === 'tool') {
        const tool = String(a.tool || 'tool').slice(0, 80);
        last = await recordEvent({
          project: s.project, session: s.name, kind: 'tool', summary: `${s.name} used ${tool}`,
          text: scrubSecrets(String(a.preview || '')).slice(0, 300), detail: { tool, source: 'hook' },
        });
      } else if (a.event === 'idle') {
        last = await recordEvent({ project: s.project, session: s.name, kind: 'status', summary: `${s.name} finished its turn and is waiting`, detail: { status: 'idle', source: 'hook' } });
      }
    }
    if (last) db.touchActivity(s.name).catch(() => {});
  }
}

const progressLog = new Map();
/** share_progress from a session: the lead's thinking or a worker's status line. */
export async function shareProgress(actor, { text, phase, project = null }) {
  checkText(text, 1000);
  if (phase !== undefined && phase !== null && !PHASES.includes(phase)) throw new HttpError(400, `phase must be one of: ${PHASES.join(', ')}`);
  const now = Date.now();
  const recent = (progressLog.get(actor.name) || []).filter((t) => now - t < 60_000);
  if (recent.length >= config.progressRateLimitPerMin) throw new HttpError(429, `rate limit: ${config.progressRateLimitPerMin} progress posts per minute`);
  recent.push(now); progressLog.set(actor.name, recent);
  const lead = actor.role === 'orchestrator';
  if (project && !(await db.getProject(project))) throw new HttpError(404, `no project ${project}`);
  const e = await recordEvent({
    project, session: actor.name, kind: lead ? 'thinking' : 'progress',
    summary: `${actor.name} ${lead ? 'is thinking' : 'reports progress'}${phase ? ` (${phase})` : ''}`,
    text, detail: phase ? { phase } : {},
  });
  return { recorded: !!e, id: e?.id };
}

export async function planTeam(actor, { project, rationale = '', experts }) {
  if (!(await db.getProject(project))) throw new HttpError(404, `no project ${project}`);
  if (typeof rationale !== 'string' || rationale.length > 4000) throw new HttpError(400, 'rationale must be a string up to 4000 chars');
  let roster;
  try { roster = normalizeTeamPlan(experts, templates()); } catch (e) { throw new HttpError(400, e.message); }
  const e = await recordEvent({
    project, session: actor.name, kind: 'team_plan',
    summary: `${actor.name} planned a team of ${roster.length} expert${roster.length === 1 ? '' : 's'}: ${roster.map((x) => x.title).join(', ')}`,
    text: rationale,
    // Keys, titles and templates are short labels the graph needs; the lead's
    // free-text expertise and reasons stay private.
    detail: {
      experts: roster.map(({ key, title, template }) => ({ key, title, template })),
      private: { experts: roster.map(({ key, expertise, why }) => ({ key, expertise, why })) },
    },
  });
  return { planned: roster.map((x) => x.key), event_id: e?.id, note: 'Spawn each expert with spawn_session(expert_key=<key>, expertise=...).' };
}

/** Everything the project page needs in one call. */
export async function projectView(slug) {
  const p = (await db.listProjects()).find((x) => x.slug === slug);
  if (!p) throw new HttpError(404, 'no such project');
  const sessions = (await sessionsView()).filter((s) => s.project === slug || s.role === 'orchestrator');
  const plan = await db.latestTeamPlan(slug);
  const approvals = (await db.pendingApprovals()).filter((a) => a.project === slug).map(({ id, title, created_at, session }) => ({ id, title, created_at, session }));
  return {
    project: { ...p, vault_dir: vault.projectDir(config.vault, slug) },
    sessions: sessions.map(({ secret_hash, ...s }) => s), // eslint-disable-line no-unused-vars
    team_plan: plan, approvals,
  };
}

export async function spawnSession(opts) {
  const {
    name, cwd, role = 'worker', template = role === 'orchestrator' ? 'lead' : 'general',
    permissionMode = 'default', prompt = '', createdBy = 'user', project = null, repo = null, branch = null,
    expertise = '', expertKey = null, expertTitle = null,
  } = opts;
  if (!NAME_RE.test(name || '')) throw new HttpError(400, 'name must match ^[a-z0-9][a-z0-9-]{0,31}$');
  if (['user', 'hub'].includes(name)) throw new HttpError(400, 'reserved name');
  if (!['worker', 'orchestrator'].includes(role)) throw new HttpError(400, 'bad role');
  if (!templates().includes(template)) throw new HttpError(400, `template must be one of: ${templates().join(', ')}`);
  if (role === 'worker' && template === 'lead') throw new HttpError(400, 'workers cannot use the lead template');
  if (!PERMISSION_MODES.has(permissionMode)) throw new HttpError(400, `permission_mode must be one of: ${[...PERMISSION_MODES].join(', ')}`);
  if (typeof expertise !== 'string' || expertise.length > 4000) throw new HttpError(400, 'expertise must be a string up to 4000 chars');
  if (expertKey !== null && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(expertKey)) throw new HttpError(400, 'expert_key must match ^[a-z0-9][a-z0-9-]{0,31}$');
  if (expertTitle !== null && (typeof expertTitle !== 'string' || expertTitle.length > 80)) throw new HttpError(400, 'expert_title must be a string up to 80 chars');
  const proj = project ? await db.getProject(project) : null;
  if (project && !proj) throw new HttpError(404, `no project ${project}`);
  if (await tmux.hasSession(name)) throw new HttpError(409, `tmux session ${tmux.tmuxName(name)} already exists`);
  // Validate the working directory before anything is created.
  let realCwd; let worktree = null; let realRepo = null;
  if (repo || branch) {
    if (!repo || !branch) throw new HttpError(400, 'repo and branch must be given together');
    if (!git.BRANCH_RE.test(branch)) throw new HttpError(400, 'invalid branch name');
    realRepo = resolveDir(repo, 'repo');
  } else if (!(role === 'orchestrator' && name === 'orchestrator')) {
    // A project session without an explicit folder works in the project's folder.
    realCwd = resolveDir(cwd || proj?.dir || '', 'cwd');
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
  // Fill the expert title from the lead's team plan when only the key was given.
  let title = expertTitle;
  if (expertKey && !title && project) {
    title = (await db.latestTeamPlan(project))?.detail?.experts?.find((x) => x.key === expertKey)?.title || null;
  }
  await db.upsertSession({
    name, role, cwd: realCwd, permissionMode, secretHash: sha256(secret), createdBy, template, project, worktree,
    expertise: expertise.trim(), expertKey, expertTitle: title,
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
  fs.writeFileSync(promptFile, roleBrief(template, {
    name, project, projectDir: proj?.dir || null, expertise: expertise.trim(), expertTitle: title || '',
  }), { mode: 0o600 });
  const claudeArgs = [
    config.claudeBin,
    '--mcp-config', mcpFile,
    '--dangerously-load-development-channels', 'server:hub',
  ];
  if (fs.existsSync(config.vault) && !realCwd.startsWith(config.vault)) claudeArgs.push('--add-dir', config.vault);
  if (proj?.dir && fs.existsSync(proj.dir) && !isWithin(realCwd, proj.dir)) claudeArgs.push('--add-dir', proj.dir);
  if (permissionMode !== 'default') claudeArgs.push('--permission-mode', permissionMode);
  const settings = sessionSettings(name, role);
  if (settings) claudeArgs.push('--settings', settings);
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
  ev({
    project, session: name, kind: 'spawn',
    summary: `${createdBy === 'user' ? 'you' : createdBy} started ${name} as ${title ? `${title} (${template})` : template}`,
    text: expertise.trim(),
    detail: { created_by: createdBy, template, role, expert_key: expertKey, expert_title: title, branch: worktree?.branch || null },
  });
  await broadcastSessions();
  return { name, role, template, project, cwd: realCwd, worktree, permission_mode: permissionMode };
}

export async function stopSession(name, { forget = false } = {}) {
  await tmux.killSession(name);
  agents.get(name)?.close(4000, 'session stopped');
  agents.delete(name);
  flags.delete(name);
  for (const ext of ['mcp.json', 'prompt.md', 'launch.sh', 'settings.json', 'activity.jsonl']) fs.rmSync(path.join(RUN_DIR, `${name}.${ext}`), { force: true });
  const before = await db.getSession(name);
  if (forget) await db.deleteSession(name);
  else await db.setStatus(name, 'stopped');
  if (before) ev({ project: before.project, session: name, kind: 'stop', summary: `${name} stopped${forget ? ' and removed' : ''}`, detail: { forget } });
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
    expertise: s.expertise || '', expertKey: s.expert_key || null, expertTitle: s.expert_title || null,
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
export async function createProject({ slug, title, goal = '', repos = [], createdBy, dir = null }) {
  if (!SLUG_RE.test(slug || '')) throw new HttpError(400, 'slug must match ^[a-z0-9][a-z0-9-]{0,39}$');
  if (typeof title !== 'string' || !title.trim()) throw new HttpError(400, 'title is required');
  if (typeof goal !== 'string' || goal.length > 20000) throw new HttpError(400, 'goal must be a string up to 20000 chars');
  if (!Array.isArray(repos)) throw new HttpError(400, 'repos must be an array');
  if (dir !== null && typeof dir !== 'string') throw new HttpError(400, 'dir must be a string');
  const realRepos = repos.map((r) => resolveDir(r, 'repo'));
  if (await db.getProject(slug)) throw new HttpError(409, `project ${slug} already exists`);
  const folder = await resolveProjectFolder(slug, dir || null);
  const project = await db.createProject({ slug, title: title.trim(), goal, repos: realRepos, createdBy, dir: folder });
  const vaultDir = vault.initProjectFolder(config.vault, project);
  broadcastUI({ type: 'projects' });
  ev({ project: slug, session: createdBy, kind: 'project', summary: `${createdBy === 'user' ? 'you' : createdBy} ${dir ? 'imported' : 'created'} project ${slug}`, detail: { imported: !!dir } });
  log(`project ${slug} created by ${createdBy} in ${folder}`);
  return { ...project, vault_dir: vaultDir };
}

/** File a session under a project (or unfile it with null). Its chats move with it. */
export async function fileSession(name, project) {
  if (project !== null && !(await db.getProject(project))) throw new HttpError(404, `no project ${project}`);
  const s = await db.getSession(name);
  if (!s) throw new HttpError(404, 'no such session');
  if (s.role === 'orchestrator') throw new HttpError(400, 'the lead works across projects and is not filed under one');
  await db.setSessionProject(name, project);
  ev({ project: project || s.project, session: name, kind: 'status', summary: project ? `${name} filed under ${project}` : `${name} removed from ${s.project}`, detail: { from: s.project, to: project } });
  await broadcastSessions();
  return { name, project };
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
  ev({ project: task.project, session: actor.name, kind: 'task', summary: `${actor.name === 'user' ? 'you' : actor.name} created ${fmtTask(task)}${task.assignee ? ` for ${task.assignee}` : ''}`, detail: { task_id: task.id, status: task.status, assignee: task.assignee } });
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
  const what = [
    fields.status && fields.status !== task.status ? `${task.status} → ${fields.status}` : '',
    fields.assignee && fields.assignee !== task.assignee ? `assigned to ${fields.assignee}` : '',
  ].filter(Boolean);
  if (what.length) {
    ev({ project: updated.project, session: actor.name, kind: 'task', summary: `${fmtTask(updated)}: ${what.join(', ')}`,
      detail: { task_id: updated.id, status: updated.status, assignee: updated.assignee, by: actor.name } });
  }

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
  ev({ project: approval.project, session, kind: 'approval', summary: `${session} asked you to approve: ${title}`, detail: { approval_id: approval.id, status: 'pending' } });
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
  ev({ project: a.project, session: a.session, kind: 'approval', summary: `you ${decision === 'approved' ? 'approved' : 'requested changes to'}: ${a.title}`, detail: { approval_id: a.id, status: decision } });
  return a;
}
