#!/usr/bin/env node
// End-to-end test: starts a real hub against Postgres with the stand-in
// `claude` (test/fake-claude), on an isolated tmux socket and temp dirs, and
// drives a full team workflow through the public APIs.
//
//   TEST_DATABASE_URL=postgres://user:pw@127.0.0.1:5432/cchub_test npm test
//
// The database name must contain "test": the suite drops and recreates tables.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.TEST_DATABASE_URL;
if (!DB || !new URL(DB).pathname.includes('test')) {
  console.error('Set TEST_DATABASE_URL to a database whose name contains "test" (it will be wiped).');
  process.exit(2);
}
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'admin-token-0123456789-abcdefghij';
const OBSERVER = 'observer-token-0123456789-abcdefg';
const SOCKET = `cchub-test-${process.pid}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cchub-test-'));
const dirs = { state: path.join(tmp, 'state'), vault: path.join(tmp, 'vault'), work: path.join(tmp, 'work') };
fs.mkdirSync(dirs.work, { recursive: true });

// A git repo for worktree tests.
const repo = path.join(dirs.work, 'repo');
fs.mkdirSync(repo);
const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
g('init', '-q'); fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n'); g('add', '.'); g('commit', '-qm', 'init');

// Fresh schema.
const pool = new pg.Pool({ connectionString: DB });
await pool.query('DROP TABLE IF EXISTS task_events, tasks, approvals, messages, sessions, projects CASCADE');

const hub = spawn(process.execPath, [path.join(ROOT, 'src', 'hub.mjs')], {
  env: { ...process.env, ...hubEnv() },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hubLog = '';
hub.stdout.on('data', (d) => { hubLog += d; });
hub.stderr.on('data', (d) => { hubLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}
async function api(p, { method = 'GET', body, token = ADMIN, origin } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (origin) headers.Origin = origin;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const thread = async (name) => (await api(`/api/sessions/${name}/messages`)).data;
/** Send a CALL to a session and wait for its RESULT reply. */
async function callAs(session, tool, args) {
  const before = (await thread(session)).length;
  const r = await api(`/api/sessions/${session}/messages`, { method: 'POST', body: { text: `CALL ${JSON.stringify({ tool, args })}` } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const reply = await until(async () => (await thread(session)).slice(before)
    .find((m) => m.sender === session && m.body.startsWith(`RESULT ${tool} `)), `${session} ${tool} result`);
  const res = JSON.parse(reply.body.slice(`RESULT ${tool} `.length));
  return { ...res, json: (() => { try { return JSON.parse(res.text); } catch { return null; } })() };
}
const pane = (name) => execFileSync('tmux', ['-L', SOCKET, 'capture-pane', '-p', '-t', `=cc-${name}:`, '-S', '-200']).toString();

let passed = 0; let failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}

try {
  await until(async () => (await fetch(`${BASE}/healthz`)).ok, 'hub /healthz');
  console.log(`hub up on ${BASE}`);

  await step('lead autostarts, accepts dialog, connects with lead tools and role prompt', async () => {
    await until(async () => (await api('/api/sessions')).data.find((s) => s.name === 'orchestrator' && s.connected), 'orchestrator online');
    const p = pane('orchestrator');
    assert.match(p, /channels=server:hub append_prompt=true add_dir=.*vault settings=true/);
    assert.match(p, /TOOLS .*project_create.*spawn_session/);
  });

  await step('vault initialized as a git repo with conventions', async () => {
    assert.ok(fs.existsSync(path.join(dirs.vault, 'Conventions.md')));
    assert.ok(fs.existsSync(path.join(dirs.vault, '.git')));
  });

  await step('user message is pushed and answered', async () => {
    await api('/api/sessions/orchestrator/messages', { method: 'POST', body: { text: 'hello lead' } });
    await until(async () => (await thread('orchestrator')).find((m) => m.body === 'echo: hello lead'), 'echo');
  });

  await step('lead creates a project with a vault folder', async () => {
    const r = await callAs('orchestrator', 'project_create', { slug: 'demo', title: 'Demo research', goal: 'Answer X', repos: [repo] });
    assert.equal(r.isError, false, r.text);
    assert.ok(fs.existsSync(path.join(dirs.vault, 'Projects', 'demo', 'demo.md')));
    assert.ok(fs.existsSync(path.join(dirs.vault, 'Projects', 'demo', 'Plan.md')));
    assert.match(fs.readFileSync(path.join(dirs.vault, 'Home.md'), 'utf8'), /Projects\/demo\/demo/);
  });

  await step('plan approval round trip', async () => {
    const r = await callAs('orchestrator', 'request_approval', { title: 'Plan for demo', body: '3 milestones' });
    const id = r.json.approval_id;
    const dash = (await api('/api/dashboard')).data;
    assert.ok(dash.approvals.some((a) => a.id === id));
    const bad = await api(`/api/approvals/${id}`, { method: 'POST', body: { decision: 'changes_requested', response: '' } });
    assert.equal(bad.status, 400);
    const ok = await api(`/api/approvals/${id}`, { method: 'POST', body: { decision: 'approved', response: 'go' } });
    assert.equal(ok.status, 200);
    await until(async () => (await thread('orchestrator')).find((m) => m.body.startsWith(`Approval #${id} "Plan for demo": APPROVED`) && m.delivered_at), 'approval delivered');
  });

  let t1; let t2;
  await step('lead builds the task board with dependencies', async () => {
    const r1 = await callAs('orchestrator', 'task_create', { title: 'Implement parser', spec: 's', acceptance: 'tests pass', priority: 1 });
    assert.ok(r1.json, r1.text); t1 = r1.json;
    const r2 = await callAs('orchestrator', 'task_create', { title: 'Write report', depends_on: [t1.id] });
    assert.ok(r2.json, r2.text); t2 = r2.json;
    assert.equal(t1.project, 'demo');
    const tasks = (await api('/api/projects/demo/tasks')).data;
    assert.equal(tasks.find((t) => t.id === t2.id).deps_done, false);
  });

  await step('lead spawns an engineer in an isolated git worktree', async () => {
    const r = await callAs('orchestrator', 'spawn_session', {
      name: 'eng1', template: 'engineer', repo, branch: 'feature/parser', prompt: `Your task is #${t1.id}.`,
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.worktree.branch, 'feature/parser');
    await until(async () => (await api('/api/sessions')).data.find((s) => s.name === 'eng1' && s.connected), 'eng1 online');
    assert.ok(fs.existsSync(path.join(dirs.state, 'worktrees', 'eng1', 'README.md')));
    assert.match(execFileSync('git', ['-C', path.join(dirs.state, 'worktrees', 'eng1'), 'branch', '--show-current']).toString(), /feature\/parser/);
    const p = pane('eng1');
    assert.match(p, /TOOLS reply,send_message,list_sessions,search_history,read_history,request_approval,project_list,task_list,task_get,task_create,task_update\n/);
    assert.match(p, /from":"orchestrator"/); // first prompt delivered after connect
  });

  await step('assignment notifies the worker', async () => {
    const r = await callAs('orchestrator', 'task_update', { id: t1.id, assignee: 'eng1' });
    assert.equal(r.isError, false, r.text);
    await until(async () => (await thread('eng1')).find((m) => m.sender === 'hub' && m.body.includes('Task assigned to you') && m.delivered_at), 'assignment notice');
  });

  await step('workers cannot use lead tools or mark their own work done', async () => {
    const spawnTry = await callAs('eng1', 'spawn_session', { name: 'x', template: 'general', prompt: 'x' });
    assert.equal(spawnTry.isError, true); // tool not exposed to workers
    const done = await callAs('eng1', 'task_update', { id: t1.id, status: 'done' });
    assert.equal(done.isError, true);
    assert.match(done.text, /review decides done/);
    const other = await callAs('eng1', 'task_update', { id: t2.id, status: 'in_progress' });
    assert.equal(other.isError, true);
  });

  await step('worker submits for review; lead is notified', async () => {
    const r = await callAs('eng1', 'task_update', { id: t1.id, status: 'review', result: 'branch feature/parser, 12 tests pass' });
    assert.equal(r.isError, false, r.text);
    await until(async () => (await thread('orchestrator')).find((m) => m.sender === 'hub' && m.body.includes(`#${t1.id}`) && m.body.includes('-> review')), 'review notice');
  });

  await step('reviewer passes the task; dependent task unblocks', async () => {
    await callAs('orchestrator', 'spawn_session', { name: 'rev1', template: 'reviewer', cwd: dirs.work, prompt: 'review' });
    await until(async () => (await api('/api/sessions')).data.find((s) => s.name === 'rev1' && s.connected), 'rev1 online');
    await callAs('orchestrator', 'task_update', { id: t1.id, assignee: 'rev1' });
    const r = await callAs('rev1', 'task_update', { id: t1.id, status: 'done', result: 'verified tests' });
    assert.equal(r.isError, false, r.text);
    await until(async () => (await thread('orchestrator')).find((m) => m.body.startsWith('Now unblocked') && m.body.includes(`#${t2.id}`)), 'unblocked notice');
    const events = (await api(`/api/tasks/${t1.id}`)).data.history;
    assert.ok(events.length >= 4, 'audit trail recorded');
  });

  await step('worker limit is enforced', async () => {
    await callAs('orchestrator', 'spawn_session', { name: 'w3', template: 'general', cwd: dirs.work, prompt: 'x' });
    const r = await callAs('orchestrator', 'spawn_session', { name: 'w4', template: 'general', cwd: dirs.work, prompt: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.text, /worker limit/);
  });

  await step('paths outside workspace roots are rejected', async () => {
    const r = await callAs('orchestrator', 'spawn_session', { name: 'bad', template: 'general', cwd: '/etc', prompt: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.text, /must be under/);
  });

  await step('peer messages flow between sessions', async () => {
    await callAs('orchestrator', 'send_message', { to: 'eng1', text: 'please rebase' });
    await until(async () => (await thread('eng1')).find((m) => m.sender === 'orchestrator' && m.body === 'please rebase' && m.delivered_at), 'peer delivery');
  });

  await step('permission prompt relayed to UI and verdict returned', async () => {
    await api('/api/sessions/eng1/messages', { method: 'POST', body: { text: 'PERM' } });
    await until(async () => (await thread('eng1')).find((m) => m.kind === 'permission_request'), 'permission request');
    const r = await api('/api/permissions/eng1/abcde', { method: 'POST', body: { behavior: 'allow' } });
    assert.equal(r.status, 200);
    await until(() => /notifications\/claude\/channel\/permission \{"request_id":"abcde","behavior":"allow"\}/.test(pane('eng1')), 'verdict in session');
  });

  await step('watchdog check-in reaches the lead', async () => {
    await until(async () => (await thread('orchestrator')).find((m) => m.sender === 'hub' && m.body.startsWith('Watchdog check-in')), 'heartbeat', 30000);
  });

  await step('full-text search over history', async () => {
    const r = await callAs('eng1', 'search_history', { query: 'rebase' });
    assert.ok(r.json.some((h) => h.sender === 'orchestrator'));
  });

  await step('vault changes are auto-committed', async () => {
    fs.writeFileSync(path.join(dirs.vault, 'Projects', 'demo', 'Notes', 'T1 parser.md'), '# T1\n');
    await until(() => execFileSync('git', ['-C', dirs.vault, 'log', '--oneline']).toString().includes('autocommit'), 'vault commit', 30000);
  });

  await step('observer can read the dashboard but not messages or controls', async () => {
    const d = await api('/api/dashboard', { token: OBSERVER });
    assert.equal(d.status, 200);
    assert.ok(d.data.projects.some((p) => p.slug === 'demo'));
    const msgs = await api('/api/sessions/orchestrator/messages', { token: OBSERVER });
    assert.ok(msgs.data.every((m) => /^\[\d+ chars\]$/.test(m.body)), 'bodies redacted');
    for (const [p, method, body] of [['/api/sessions/eng1/messages', 'POST', { text: 'x' }], ['/api/search?q=x', 'GET'], ['/api/sessions/eng1/pane', 'GET']]) {
      assert.equal((await api(p, { method, body, token: OBSERVER })).status, 403, p);
    }
  });

  await step('auth, origin, and input checks', async () => {
    assert.equal((await fetch(`${BASE}/api/sessions`)).status, 401);
    assert.equal((await api('/api/sessions/eng1/messages', { method: 'POST', body: { text: 'x' }, origin: 'https://evil.example' })).status, 403);
    assert.equal((await api('/api/sessions/eng1/keys', { method: 'POST', body: { keys: ['rm -rf /'] } })).status, 400);
    const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) });
    assert.equal(login.status, 401);
  });

  await step('hub restart: sessions reconnect and queued messages deliver', async () => {
    hub.kill('SIGTERM');
    await sleep(500);
    await pool.query("INSERT INTO messages (sender, recipient, body) VALUES ('user', 'eng1', 'sent while hub down')");
    const hub2 = spawn(process.execPath, [path.join(ROOT, 'src', 'hub.mjs')], { env: { ...process.env, ...hubEnv() }, stdio: 'ignore' });
    globalThis.hub2 = hub2;
    await until(async () => (await api('/api/sessions')).data?.find?.((s) => s.name === 'eng1' && s.connected), 'eng1 reconnected', 30000);
    await until(async () => (await thread('eng1')).find((m) => m.body === 'echo: sent while hub down'), 'queued delivery');
  });
} finally {
  if (process.env.CCHUB_TEST_KEEP === '1') {
    console.log(`\n${passed} passed, ${failed} failed. Keeping the demo hub up at ${BASE} (admin token ${ADMIN}). Ctrl-C to stop.`);
    process.on('SIGINT', () => cleanup(0));
    await new Promise(() => {});
  }
  for (const p of [hub, globalThis.hub2]) try { p?.kill('SIGTERM'); } catch {}
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch {}
  await pool.end();
  if (failed) console.log(`\n--- hub log ---\n${hubLog.slice(-4000)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function cleanup(code) {
  for (const p of [hub, globalThis.hub2]) try { p?.kill('SIGTERM'); } catch {}
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}

function hubEnv() {
  return {
    HUB_UI_TOKEN: ADMIN, HUB_OBSERVER_TOKEN: OBSERVER, DATABASE_URL: DB, HUB_PORT: String(PORT),
    HUB_STATE_DIR: dirs.state, HUB_VAULT: dirs.vault, HUB_WORKSPACE_ROOTS: dirs.work,
    CLAUDE_BIN: path.join(ROOT, 'test', 'fake-claude'), HUB_TMUX_SOCKET: SOCKET,
    HUB_HEARTBEAT_MIN: '0.1', HUB_SCAN_SEC: '2', HUB_STALL_MIN: '60', HUB_VAULT_AUTOCOMMIT_MIN: '0.1',
    HUB_MAX_WORKERS: '3', HUB_DIGEST_HOUR: '-1',
  };
}
