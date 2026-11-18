// cc-hub entry point: HTTP + WebSocket server.
//   /ws/agent  channel servers (one per Claude session), loopback only
//   /ws/ui     browsers (admin or read-only observer)
//   /api/*     REST API for the web UI and dashboard
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config, assertHubConfig, ROOT } from './config.mjs';
import * as core from './core.mjs';
import { HttpError, log, safeEqual, sha256 } from './core.mjs';
import * as db from './db.mjs';
import * as git from './git.mjs';
import * as tmux from './tmux.mjs';
import * as vault from './vault.mjs';
import * as watchdog from './watchdog.mjs';

assertHubConfig();

// ---------------------------------------------------------------- agent RPC
// Every method runs with the caller's identity from the DB (role, template),
// never with anything the channel process claims.
const LEAD_ONLY = new Set(['spawn', 'stop', 'restart', 'peek', 'keys', 'project_create', 'project_update']);
const pick = (m) => ({ id: m.id, ts: m.ts, sender: m.sender, recipient: m.recipient, kind: m.kind, body: m.body });

function checkKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 10) throw new HttpError(400, 'keys must be an array of 1-10 keys');
  const bad = keys.find((k) => !tmux.ALLOWED_KEYS.has(k));
  if (bad !== undefined) throw new HttpError(400, `key not allowed: ${bad}`);
}
const asId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'id must be a positive integer');
  return n;
};

// Explicit project, else the session's own, else the only open project.
async function defaultProject(explicit, actor, { required = true } = {}) {
  if (explicit) return explicit;
  if (actor.project) return actor.project;
  const open = (await db.listProjects()).filter((x) => ['planning', 'active'].includes(x.status));
  if (open.length === 1) return open[0].slug;
  if (!required) return null;
  throw new HttpError(400, `project is required (open projects: ${open.map((x) => x.slug).join(', ') || 'none'})`);
}

async function handleAgentRpc(actor, method, p = {}) {
  if (LEAD_ONLY.has(method) && actor.role !== 'orchestrator') {
    throw new HttpError(403, `${method} is only available to the lead (orchestrator) session`);
  }
  core.flags.set(actor.name, { ...(core.flags.get(actor.name) || {}), stalled: false });
  db.touchActivity(actor.name).catch(() => {});
  switch (method) {
    case 'reply':
      return pick(await core.postMessage({ sender: actor.name, recipient: 'user', body: p.text }));
    case 'send': {
      if (p.to === actor.name) throw new HttpError(400, 'cannot message yourself');
      if (p.to === 'user') return pick(await core.postMessage({ sender: actor.name, recipient: 'user', body: p.text }));
      core.checkPeerRate(actor.name);
      return pick(await core.postMessage({ sender: actor.name, recipient: p.to, body: p.text }));
    }
    case 'list_sessions':
      return (await core.sessionsView()).map((s) => ({
        name: s.name, role: s.role, template: s.template, project: s.project, cwd: s.cwd,
        branch: s.worktree?.branch, status: s.status, connected: s.connected, flags: s.flags,
      }));
    case 'search':
      return (await db.searchMessages({ query: String(p.query || ''), session: p.session || null, limit: p.limit || 20 }))
        .map((m) => ({ id: m.id, ts: m.ts, sender: m.sender, recipient: m.recipient, kind: m.kind, snippet: m.snippet }));
    case 'history':
      return (await db.threadFor(p.session || actor.name, { limit: Math.min(p.limit || 30, 200), beforeId: p.before_id || null })).map(pick);
    case 'request_approval':
      return core.requestApproval({ session: actor.name, title: p.title, body: p.body });

    // projects
    case 'project_list': return db.listProjects();
    case 'project_create':
      return core.createProject({ slug: p.slug, title: p.title, goal: p.goal || '', repos: p.repos || [], createdBy: actor.name });
    case 'project_update': {
      if (p.status && !['planning', 'active', 'paused', 'done'].includes(p.status)) throw new HttpError(400, 'bad status');
      const r = await db.updateProject(p.slug, { status: p.status, goal: p.goal, title: p.title });
      if (!r) throw new HttpError(404, 'no such project');
      core.broadcastUI({ type: 'projects' });
      return r;
    }

    // tasks
    case 'task_list':
      return (await db.listTasks({ project: p.project || null, status: p.status || null, assignee: p.assignee || null }))
        .map((t) => ({ id: t.id, project: t.project, title: t.title, status: t.status, priority: t.priority,
          assignee: t.assignee, depends_on: t.depends_on, deps_done: t.deps_done, milestone: t.milestone }));
    case 'task_get': {
      const t = await db.getTask(asId(p.id));
      if (!t) throw new HttpError(404, 'no such task');
      return { ...t, history: await db.taskEvents(t.id) };
    }
    case 'task_create':
      return core.createTask({ ...p, project: await defaultProject(p.project, actor) }, actor);
    case 'task_update': {
      const { id, ...changes } = p;
      return core.updateTask(asId(id), changes, actor);
    }

    // session control (lead only)
    case 'spawn':
      return core.spawnSession({
        name: p.name, cwd: p.cwd, role: 'worker', template: p.template || 'general',
        project: await defaultProject(p.project, actor, { required: false }),
        repo: p.repo || null, branch: p.branch || null,
        permissionMode: p.permission_mode || 'default', prompt: p.prompt || '', createdBy: actor.name,
      });
    case 'stop': {
      const target = await db.getSession(p.name);
      if (!target) throw new HttpError(404, 'no such session');
      if (target.role === 'orchestrator') throw new HttpError(403, 'cannot stop the lead from a session');
      await core.stopSession(p.name);
      return { stopped: p.name };
    }
    case 'restart': {
      const target = await db.getSession(p.name);
      if (!target || target.role === 'orchestrator') throw new HttpError(403, 'can only restart worker sessions');
      return core.restartSession(p.name, actor.name);
    }
    case 'peek':
      if (!(await tmux.hasSession(p.name))) throw new HttpError(404, 'tmux session not running');
      return { pane: (await tmux.capturePane(p.name, Math.min(p.lines || 80, 400))).trimEnd() };
    case 'keys':
      checkKeys(p.keys);
      await tmux.sendKeys(p.name, p.keys);
      return { sent: p.keys };
    default:
      throw new HttpError(400, `unknown method ${method}`);
  }
}

// ---------------------------------------------------------------- agent websocket
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

agentWss.on('connection', (ws) => {
  let actor = null;
  const helloTimer = setTimeout(() => ws.close(4001, 'hello timeout'), 5000);

  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return ws.close(4002, 'bad json'); }

    if (!actor) {
      if (m.type !== 'hello') return ws.close(4003, 'expected hello');
      const s = await db.getSession(String(m.name || '')).catch(() => null);
      if (!s || !safeEqual(sha256(String(m.secret || '')), s.secret_hash)) {
        log(`rejected agent hello for ${m.name}`);
        return ws.close(4004, 'bad credentials');
      }
      clearTimeout(helloTimer);
      actor = { name: s.name, role: s.role, template: s.template, project: s.project };
      core.agents.get(actor.name)?.close(4005, 'replaced by new connection');
      core.agents.set(actor.name, ws);
      await db.setStatus(actor.name, 'online');
      ws.send(JSON.stringify({ type: 'welcome', name: actor.name, role: actor.role }));
      log(`agent online: ${actor.name} (${actor.role}/${actor.template})`);
      for (const msg of await db.undeliveredFor(actor.name)) core.deliver(actor.name, msg);
      return core.broadcastSessions();
    }

    try {
      if (m.type === 'ack') {
        await db.markDelivered(m.id);
        core.broadcastUI({ type: 'delivered', id: m.id });
      } else if (m.type === 'rpc') {
        // Re-read role/template/project each call so changes take effect without reconnecting.
        const s = await db.getSession(actor.name);
        if (s) Object.assign(actor, { role: s.role, template: s.template, project: s.project });
        try {
          const result = await handleAgentRpc(actor, m.method, m.params);
          ws.send(JSON.stringify({ type: 'rpc_result', id: m.id, result }));
        } catch (e) {
          if (!e.status) log(`rpc ${actor.name}.${m.method} error:`, e);
          ws.send(JSON.stringify({ type: 'rpc_result', id: m.id, error: e.status ? e.message : 'internal error' }));
        }
      } else if (m.type === 'permission_request') {
        const req = {
          session: actor.name, request_id: String(m.request_id), tool_name: String(m.tool_name || ''),
          description: String(m.description || ''), input_preview: String(m.input_preview || ''),
          status: 'pending', ts: new Date().toISOString(),
        };
        core.pendingPerms.set(`${actor.name}:${req.request_id}`, req);
        const msg = await db.insertMessage({
          sender: actor.name, recipient: 'user', kind: 'permission_request',
          body: `${req.tool_name}: ${req.description}\n${req.input_preview}`, meta: req,
        });
        core.broadcastUI({ type: 'message', msg });
      }
    } catch (e) {
      log(`agent ${actor.name} error: ${e.message}`);
    }
  });

  ws.on('close', async () => {
    clearTimeout(helloTimer);
    if (actor && core.agents.get(actor.name) === ws) {
      core.agents.delete(actor.name);
      const alive = await tmux.hasSession(actor.name);
      await db.setStatus(actor.name, alive ? 'offline' : 'stopped').catch(() => {});
      log(`agent disconnected: ${actor.name}`);
      core.broadcastSessions().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------- UI auth
const COOKIE = 'cchub';
const cookieFor = (token, level) => crypto.createHmac('sha256', token).update(`cc-hub-ui-v2:${level}`).digest('base64url');
const ADMIN_COOKIE = cookieFor(config.uiToken, 'admin');
const OBSERVER_COOKIE = config.observerToken ? cookieFor(config.observerToken, 'observer') : null;
const loginFails = new Map();

function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress;
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
/** Returns 'admin', 'observer', or null. */
function authLevel(req) {
  const c = parseCookies(req)[COOKIE];
  if (c && safeEqual(c, ADMIN_COOKIE)) return 'admin';
  if (c && OBSERVER_COOKIE && safeEqual(c, OBSERVER_COOKIE)) return 'observer';
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    if (safeEqual(h.slice(7), config.uiToken)) return 'admin';
    if (config.observerToken && safeEqual(h.slice(7), config.observerToken)) return 'observer';
  }
  return null;
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = config.trustProxy && req.headers['x-forwarded-host'] ? req.headers['x-forwarded-host'] : req.headers.host;
    return new URL(origin).host === host;
  } catch { return false; }
}
const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

// ---------------------------------------------------------------- HTTP
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'expected application/json');
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400, 'bad json'); }
}

const INDEX_HTML = path.join(ROOT, 'public', 'index.html');
const SESSION_PATH = /^\/api\/sessions\/([a-z0-9][a-z0-9-]{0,31})(\/[a-z]+)?$/;

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(INDEX_HTML, 'utf8'));
  if (method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

  if (method === 'POST' && p === '/api/login') {
    const ip = clientIp(req);
    const fails = (loginFails.get(ip) || []).filter((t) => Date.now() - t < 15 * 60_000);
    if (fails.length >= 10) throw new HttpError(429, 'too many attempts, try again later');
    const { token } = await readJson(req);
    let cookie = null; let level = null;
    if (safeEqual(String(token || ''), config.uiToken)) { cookie = ADMIN_COOKIE; level = 'admin'; }
    else if (config.observerToken && safeEqual(String(token || ''), config.observerToken)) { cookie = OBSERVER_COOKIE; level = 'observer'; }
    if (!cookie) {
      fails.push(Date.now()); loginFails.set(ip, fails);
      log(`failed login from ${ip}`);
      throw new HttpError(401, 'invalid token');
    }
    const secure = req.socket.encrypted || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');
    log(`${level} login from ${ip}`);
    return send(res, 200, { ok: true, level }, {
      'Set-Cookie': `${COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`,
    });
  }
  if (method === 'POST' && p === '/api/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }

  if (!p.startsWith('/api/')) throw new HttpError(404, 'not found');
  const level = authLevel(req);
  if (!level) throw new HttpError(401, 'login required');
  if (method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'cross-origin request rejected');
  const admin = level === 'admin';
  const canReadMessages = admin || config.observerCanReadMessages;
  const requireAdmin = () => { if (!admin) throw new HttpError(403, 'read-only (observer) access'); };

  // ---- read endpoints (admin + observer)
  if (method === 'GET' && p === '/api/me') {
    return send(res, 200, {
      level, can_read_messages: canReadMessages, roots: config.workspaceRoots, vault: config.vault,
      permission_modes: [...core.PERMISSION_MODES], keys: [...tmux.ALLOWED_KEYS], templates: core.templates(),
      max_workers: config.maxWorkers,
    });
  }
  if (method === 'GET' && p === '/api/dashboard') {
    const [projects, sessions, stats, approvals, activity] = await Promise.all([
      db.listProjects(), core.sessionsView(), db.stats(), db.pendingApprovals(),
      db.activity({ limit: 60, includeBodies: canReadMessages }),
    ]);
    return send(res, 200, {
      projects, stats, activity,
      sessions: sessions.map(({ secret_hash, ...s }) => s), // eslint-disable-line no-unused-vars
      approvals: approvals.map((a) => (canReadMessages ? a : { ...a, body: '' })),
    });
  }
  if (method === 'GET' && p === '/api/sessions') return send(res, 200, await core.sessionsView());
  if (method === 'GET' && p === '/api/projects') return send(res, 200, await db.listProjects());
  const tp = p.match(/^\/api\/projects\/([a-z0-9][a-z0-9-]{0,39})\/tasks$/);
  if (method === 'GET' && tp) return send(res, 200, await db.listTasks({ project: tp[1] }));
  const tg = p.match(/^\/api\/tasks\/(\d+)$/);
  if (method === 'GET' && tg) {
    const t = await db.getTask(Number(tg[1]));
    if (!t) throw new HttpError(404, 'no such task');
    return send(res, 200, { ...t, history: await db.taskEvents(t.id) });
  }

  const sm = p.match(SESSION_PATH);
  if (method === 'GET' && sm && sm[2] === '/messages') {
    const before = url.searchParams.get('before');
    const msgs = await db.threadFor(sm[1], { beforeId: before ? Number(before) : null, limit: 100 });
    return send(res, 200, canReadMessages ? msgs : msgs.map(core.redactMessage));
  }

  // ---- everything below is admin only
  requireAdmin();

  if (method === 'GET' && p === '/api/search') {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return send(res, 200, []);
    return send(res, 200, await db.searchMessages({ query: q, session: url.searchParams.get('session') || null, limit: 50 }));
  }
  if (method === 'POST' && p === '/api/sessions') {
    const b = await readJson(req);
    return send(res, 201, await core.spawnSession({
      name: b.name, cwd: b.cwd, role: b.role === 'orchestrator' ? 'orchestrator' : 'worker',
      template: b.template || undefined, project: b.project || null, repo: b.repo || null, branch: b.branch || null,
      permissionMode: b.permission_mode || 'default', prompt: b.prompt || '', createdBy: 'user',
    }));
  }
  if (method === 'POST' && p === '/api/projects') {
    const b = await readJson(req);
    return send(res, 201, await core.createProject({ slug: b.slug, title: b.title, goal: b.goal || '', repos: b.repos || [], createdBy: 'user' }));
  }
  if (method === 'PATCH' && tg) {
    return send(res, 200, await core.updateTask(Number(tg[1]), await readJson(req), { name: 'user', role: 'user' }));
  }
  const ap = p.match(/^\/api\/approvals\/(\d+)$/);
  if (method === 'POST' && ap) {
    const { decision, response } = await readJson(req);
    return send(res, 200, await core.decideApproval(Number(ap[1]), decision, response || ''));
  }

  if (sm) {
    const [, name, sub = ''] = sm;
    if (method === 'POST' && sub === '/messages') {
      const { text } = await readJson(req);
      return send(res, 201, await core.postMessage({ sender: 'user', recipient: name, body: text }));
    }
    if (method === 'GET' && sub === '/pane') return send(res, 200, { pane: (await tmux.capturePane(name, 300)).trimEnd() });
    if (method === 'POST' && sub === '/keys') {
      const { keys } = await readJson(req);
      checkKeys(keys);
      await tmux.sendKeys(name, keys);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && sub === '/restart') return send(res, 200, await core.restartSession(name));
    if (method === 'DELETE' && sub === '') {
      await core.stopSession(name, { forget: url.searchParams.get('forget') === '1' });
      return send(res, 200, { ok: true });
    }
  }

  const pm = p.match(/^\/api\/permissions\/([a-z0-9][a-z0-9-]{0,31})\/([a-km-z]{5})$/);
  if (method === 'POST' && pm) {
    const [, name, requestId] = pm;
    const { behavior } = await readJson(req);
    if (!['allow', 'deny'].includes(behavior)) throw new HttpError(400, 'behavior must be allow or deny');
    const pending = core.pendingPerms.get(`${name}:${requestId}`);
    if (!pending || pending.status !== 'pending') throw new HttpError(404, 'no pending request with that id');
    const ws = core.agents.get(name);
    if (!ws) throw new HttpError(409, 'session is not connected');
    ws.send(JSON.stringify({ type: 'permission_verdict', request_id: requestId, behavior }));
    pending.status = behavior;
    const msg = await db.insertMessage({
      sender: 'user', recipient: name, kind: 'permission_verdict', delivered: true,
      body: `${behavior === 'allow' ? 'Allowed' : 'Denied'} ${pending.tool_name}`, meta: { request_id: requestId, behavior },
    });
    core.broadcastUI({ type: 'message', msg });
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'not found');
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e.status || 500;
    if (status === 500) log('error', e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : e.message });
  });
});

const uiWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
uiWss.on('connection', async (ws, req, level) => {
  const client = { ws, level };
  core.uiClients.add(client);
  ws.on('close', () => core.uiClients.delete(client));
  ws.send(JSON.stringify({ type: 'sessions', sessions: await core.sessionsView() }));
  if (level === 'admin') {
    ws.send(JSON.stringify({ type: 'permissions', pending: [...core.pendingPerms.values()].filter((x) => x.status === 'pending') }));
  }
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws/agent') {
    // Channel servers run on this machine. Proxied requests (tailscale serve,
    // cloudflared, caddy) also arrive from loopback, so reject proxy headers.
    const proxied = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'tailscale-user-login', 'cf-connecting-ip', 'cf-ray']
      .some((h) => req.headers[h]);
    if (!isLoopback(req.socket.remoteAddress) || proxied) return socket.destroy();
    return agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws, req));
  }
  if (pathname === '/ws/ui') {
    const level = authLevel(req);
    if (!level || !sameOrigin(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    return uiWss.handleUpgrade(req, socket, head, (ws) => uiWss.emit('connection', ws, req, level));
  }
  socket.destroy();
});

// ---------------------------------------------------------------- boot
/**
 * Sessions the DB still thinks are running but whose tmux session is gone were
 * interrupted (reboot, crash, WSL shutdown), as opposed to stopped on purpose.
 */
async function findInterrupted() {
  const live = new Set(await tmux.listSessions());
  const rows = await db.listSessions();
  const interrupted = rows.filter((s) => s.status !== 'stopped' && !live.has(s.name));
  const lastSeen = rows.map((s) => s.last_activity || s.last_seen).filter(Boolean).map((d) => new Date(d).getTime());
  return { interrupted, lastSeen: lastSeen.length ? new Date(Math.max(...lastSeen)) : null };
}

async function resumeAfterDowntime({ interrupted, lastSeen }) {
  const workers = interrupted.filter((s) => s.role === 'worker');
  const resumed = []; const failed = [];
  for (const s of workers.slice(0, config.maxWorkers)) {
    try { await core.restartSession(s.name, 'hub'); resumed.push(s.name); }
    catch (e) { failed.push(`${s.name} (${e.message})`); log(`resume ${s.name} failed: ${e.message}`); }
  }
  for (const s of workers.slice(config.maxWorkers)) failed.push(`${s.name} (over worker limit)`);
  const mins = lastSeen ? Math.round((Date.now() - lastSeen.getTime()) / 60_000) : null;
  const note = [
    `The hub restarted after downtime${mins !== null ? ` (last activity about ${mins} minutes ago)` : ''}; the machine was probably off or asleep. Every session, including you, has a fresh context.`,
    resumed.length ? `Restarted workers: ${resumed.join(', ')}. Each was told to resume its assigned tasks.` : 'No workers needed restarting.',
    failed.length ? `Not restarted: ${failed.join('; ')}.` : '',
    'Rebuild your picture from the board (task_list), the project index notes and latest reports in the vault, and search_history if needed. Then continue: reassign anything stale, start ready tasks, and only message the user if something needs their decision.',
  ].filter(Boolean).join('\n\n');
  for (const lead of await core.leadNames()) await core.notify(lead, note);
  await db.insertMessage({ sender: 'hub', recipient: 'user', kind: 'system',
    body: `Hub restarted after downtime. Resumed: ${resumed.join(', ') || 'none'}${failed.length ? `. Not resumed: ${failed.join('; ')}` : ''}.` })
    .then((msg) => core.broadcastUI({ type: 'message', msg }));
  log(`resume after downtime: resumed ${resumed.length}, failed ${failed.length}`);
}

async function main() {
  await db.initSchema();
  fs.mkdirSync(config.worktreeDir, { recursive: true });
  vault.initVault(config.vault);
  await git.ensureVaultRepo(config.vault).catch((e) => log(`vault git init failed: ${e.message}`));
  const downtime = await findInterrupted();
  await core.reconcile();
  setInterval(() => core.reconcile().catch((e) => log('reconcile error', e.message)), 15_000);
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [k, v] of core.pendingPerms) if (Date.parse(v.ts) < cutoff) core.pendingPerms.delete(k);
  }, 60_000);
  watchdog.start();

  await new Promise((r) => server.listen(config.port, config.host, r));
  log(`cc-hub listening on http://${config.host}:${config.port} (vault: ${config.vault})`);

  if (config.autostartOrchestrator && !(await tmux.hasSession('orchestrator'))) {
    await core.spawnSession({ name: 'orchestrator', role: 'orchestrator', template: 'lead', createdBy: 'hub' })
      .catch((e) => log(`orchestrator autostart failed: ${e.message}`));
  }
  if (config.resumeOnBoot && downtime.interrupted.length) {
    await resumeAfterDowntime(downtime).catch((e) => log(`resume failed: ${e.message}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log('shutting down (tmux sessions keep running)');
    server.close();
    await db.pool.end().catch(() => {});
    process.exit(0);
  });
}
