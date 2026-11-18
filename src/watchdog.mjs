// Watchdog: keeps long-running team work moving without the human.
//  - scans every session's terminal for activity, usage-limit messages, and
//    open dialogs
//  - sends the lead a board check-in while work is in flight
//  - asks the lead for the daily report
//  - commits the vault to git
import crypto from 'node:crypto';
import { config } from './config.mjs';
import * as core from './core.mjs';
import * as db from './db.mjs';
import * as git from './git.mjs';
import * as tmux from './tmux.mjs';

const paneHash = new Map();
const lastLimitNotice = new Map();
let lastHeartbeat = { at: 0, summary: '' };
let lastDigestDay = '';

const USAGE_RE = /(usage limit|limit reached|rate limit|out of (extra )?usage|resets at)/i;
const DIALOG_RE = /(Do you want to|Would you like to|❯\s*1\.\s*Yes)/;

let lastScanAt = Date.now();

/**
 * A laptop that slept leaves a gap between scans. Without this, every session
 * would look stalled on wake and the lead would restart healthy workers.
 */
async function detectWake() {
  const now = Date.now();
  const gap = now - lastScanAt;
  lastScanAt = now;
  const expected = Math.max(1, config.scanSec) * 1000;
  if (gap < expected * 3 + 60_000) return;
  const mins = Math.round(gap / 60_000);
  core.log(`wake detected: ~${mins} min gap; resetting activity timers`);
  await db.pool.query("UPDATE sessions SET last_activity = now() WHERE status <> 'stopped'");
  lastHeartbeat = { at: Date.now(), summary: '' };
  for (const l of await core.leadNames()) {
    await core.notify(l, `The machine was asleep for about ${mins} minute${mins === 1 ? "" : "s"}. Sessions were paused, not stopped; any step that was mid-request may have failed and been retried. Check the board, peek any worker whose task looks stuck, and carry on. No need to message the user unless something needs their decision.`);
  }
}

async function scanPanes() {
  await detectWake();
  for (const s of await db.listSessions()) {
    if (s.status === 'stopped') continue;
    const pane = await tmux.capturePane(s.name, 40);
    if (!pane) continue;
    const h = crypto.createHash('sha1').update(pane).digest('hex');
    const changed = paneHash.get(s.name) !== h;
    paneHash.set(s.name, h);
    if (changed) await db.touchActivity(s.name);

    const tail = pane.trimEnd().split('\n').slice(-15).join('\n');
    const f = { ...(core.flags.get(s.name) || {}) };
    f.usage_limit = USAGE_RE.test(tail);
    f.waiting_dialog = DIALOG_RE.test(tail);
    const idleMin = s.last_activity ? (Date.now() - new Date(s.last_activity).getTime()) / 60_000 : 0;
    f.stalled = idleMin >= config.stallMin;
    f.idle_min = Math.round(idleMin);
    core.flags.set(s.name, f);

    if (f.usage_limit && Date.now() - (lastLimitNotice.get(s.name) || 0) > 60 * 60_000) {
      lastLimitNotice.set(s.name, Date.now());
      await db.insertMessage({
        sender: 'hub', recipient: 'user', kind: 'system',
        body: `${s.name} appears to have hit a Claude usage limit. Work resumes when the limit resets.`,
      }).then((msg) => core.broadcastUI({ type: 'message', msg }));
    }
  }
}

async function boardSummary() {
  const projects = (await db.listProjects()).filter((p) => ['planning', 'active'].includes(p.status));
  const sessions = await core.sessionsView();
  const lines = [];
  let actionable = false;
  for (const p of projects) {
    const tasks = await db.listTasks({ project: p.slug });
    const open = tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
    if (!open.length) continue;
    const ready = open.filter((t) => t.status === 'todo' && t.deps_done);
    const counts = Object.entries(p.task_counts || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    lines.push(`Project ${p.slug} (${p.status}): ${counts}`);
    for (const t of open.filter((x) => x.status !== 'todo')) {
      lines.push(`  #${t.id} ${t.status} ${t.assignee || 'unassigned'}: ${t.title}`);
    }
    if (ready.length) {
      actionable = true;
      lines.push(`  Ready to start: ${ready.slice(0, 8).map((t) => `#${t.id}${t.assignee ? `(${t.assignee})` : ''}`).join(', ')}`);
    }
    if (open.some((t) => ['review', 'blocked'].includes(t.status))) actionable = true;
  }
  const problems = sessions.filter((s) => s.role === 'worker' && s.status !== 'stopped' &&
    (s.flags.stalled || s.flags.usage_limit || s.flags.waiting_dialog || !s.connected));
  for (const s of problems) {
    actionable = true;
    const why = [s.flags.stalled && `no activity for ${s.flags.idle_min} min`, s.flags.usage_limit && 'usage limit',
      s.flags.waiting_dialog && 'waiting on a dialog', !s.connected && `channel ${s.status}`].filter(Boolean).join(', ');
    lines.push(`Session ${s.name}: ${why}`);
  }
  const idle = sessions.filter((s) => s.role === 'worker' && s.status !== 'stopped' && s.connected && s.flags.stalled === false);
  if (lines.length) lines.push(`Workers running: ${sessions.filter((s) => s.role === 'worker' && s.status !== 'stopped').length}/${config.maxWorkers}; responsive: ${idle.map((s) => s.name).join(', ') || 'none'}`);
  return { text: lines.join('\n'), actionable };
}

async function heartbeat() {
  const leads = await core.leadNames();
  if (!leads.length) return;
  const { text, actionable } = await boardSummary();
  if (!text) return;
  const stale = Date.now() - lastHeartbeat.at > 2 * 60 * 60_000;
  if (!actionable && text === lastHeartbeat.summary && !stale) return;
  lastHeartbeat = { at: Date.now(), summary: text };
  for (const l of leads) {
    await core.notify(l, `Watchdog check-in. Act on anything that needs it (start ready tasks, assign reviews, unblock, peek/restart stalled sessions). If nothing needs action, do nothing and do not reply to the user.\n\n${text}`);
  }
}

async function digest() {
  if (config.digestHour < 0) return;
  const now = new Date();
  const day = now.toLocaleDateString('en-CA');
  if (now.getHours() !== config.digestHour || lastDigestDay === day) return;
  lastDigestDay = day;
  const active = (await db.listProjects()).filter((p) => ['planning', 'active'].includes(p.status));
  if (!active.length) return;
  for (const l of await core.leadNames()) {
    await core.notify(l, `Daily report time (${day}). For each active project (${active.map((p) => p.slug).join(', ')}), write Projects/<slug>/Reports/${day}.md (done, in progress, blocked, decisions, risks, next) and update the project index status. Then reply to the user with a short summary per project and the note paths.`);
  }
}

let lastSyncProblem = '';
async function commitVault() {
  try {
    if (!config.vaultRemote) {
      const n = await git.autocommit(config.vault, `cc-hub autocommit ${new Date().toISOString()}`);
      if (n) core.log(`vault: committed ${n} changed paths`);
      return;
    }
    const r = await git.syncVault(config.vault, config.vaultRemote);
    if (r.committed) core.log(`vault: committed ${r.committed} changed paths`);
    if (r.ok) { lastSyncProblem = ''; return; }
    core.log(`vault sync: ${r.error}`);
    if (r.error !== lastSyncProblem) { // tell the human once per distinct problem
      lastSyncProblem = r.error;
      const msg = await db.insertMessage({ sender: 'hub', recipient: 'user', kind: 'system', body: `Vault sync problem: ${r.error}` });
      core.broadcastUI({ type: 'message', msg });
    }
  } catch (e) { core.log(`vault commit/sync failed: ${e.message}`); }
}

export function start() {
  const safe = (fn) => () => fn().catch((e) => core.log(`watchdog ${fn.name}: ${e.message}`));
  setInterval(safe(scanPanes), Math.max(1, config.scanSec) * 1000);
  setInterval(safe(heartbeat), Math.max(0.05, config.heartbeatMin) * 60_000);
  setInterval(safe(digest), 5 * 60_000);
  if (config.vaultAutocommitMin > 0) setInterval(safe(commitVault), Math.max(0.05, config.vaultAutocommitMin) * 60_000);
  return { scanPanes, heartbeat, boardSummary, commitVault };
}
