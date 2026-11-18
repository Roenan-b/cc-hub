// Loads .env (no dependency) and exposes validated configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

export const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const stateDir = path.resolve(expandHome(env.HUB_STATE_DIR || '~/.cc-hub'));

export const config = {
  host: env.HUB_HOST || '127.0.0.1',
  port: num(env.HUB_PORT, 8787),
  databaseUrl: env.DATABASE_URL || 'postgres://cchub:cchub@127.0.0.1:5433/cchub',
  uiToken: env.HUB_UI_TOKEN || '',
  // Optional read-only login for the observer dashboard (safe to share).
  observerToken: env.HUB_OBSERVER_TOKEN || '',
  observerCanReadMessages: env.HUB_OBSERVER_READ_MESSAGES === '1',
  stateDir,
  worktreeDir: path.join(stateDir, 'worktrees'),
  // Sessions may only be started in directories under one of these roots.
  workspaceRoots: (env.HUB_WORKSPACE_ROOTS || '~')
    .split(':').filter(Boolean).map((p) => path.resolve(expandHome(p))),
  // Obsidian vault shared by every session (the curated "brain").
  vault: path.resolve(expandHome(env.HUB_VAULT || '~/Vault')),
  vaultAutocommitMin: num(env.HUB_VAULT_AUTOCOMMIT_MIN, 5),
  // Optional git remote (e.g. git@github.com:you/vault.git, a PRIVATE repo) the
  // vault syncs with on every autocommit, so Obsidian elsewhere stays current.
  vaultRemote: env.HUB_VAULT_REMOTE || '',
  claudeBin: env.CLAUDE_BIN || 'claude',
  nodeBin: env.NODE_BIN || process.execPath,
  allowBypassPermissions: env.HUB_ALLOW_BYPASS === '1',
  orchestratorCwd: path.resolve(expandHome(env.HUB_ORCHESTRATOR_CWD || path.join(ROOT, 'orchestrator'))),
  autostartOrchestrator: env.HUB_AUTOSTART_ORCHESTRATOR !== '0',
  // After the machine was off or asleep long enough for sessions to die, restart
  // the workers that were running and tell the lead what happened.
  resumeOnBoot: env.HUB_RESUME_ON_BOOT !== '0',
  maxWorkers: num(env.HUB_MAX_WORKERS, 6),
  peerRateLimitPerMin: num(env.HUB_PEER_RATE_LIMIT, 20),
  maxMessageChars: num(env.HUB_MAX_MESSAGE_CHARS, 20000),
  // Watchdog: how often the lead gets a board check-in while work is in flight,
  // and how long a session can show no activity before it counts as stalled.
  heartbeatMin: num(env.HUB_HEARTBEAT_MIN, 15),
  stallMin: num(env.HUB_STALL_MIN, 30),
  scanSec: num(env.HUB_SCAN_SEC, 60),
  digestHour: num(env.HUB_DIGEST_HOUR, 21), // local hour for the daily report; -1 disables
  trustProxy: env.HUB_TRUST_PROXY === '1',
};

export function assertHubConfig() {
  if (!config.uiToken || config.uiToken.length < 24) {
    throw new Error('HUB_UI_TOKEN must be set to a random string of at least 24 characters (see .env.example).');
  }
  if (config.observerToken && (config.observerToken.length < 24 || config.observerToken === config.uiToken)) {
    throw new Error('HUB_OBSERVER_TOKEN must be at least 24 characters and different from HUB_UI_TOKEN.');
  }
}
