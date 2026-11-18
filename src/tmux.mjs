// Thin, injection-safe wrapper around the tmux CLI. All calls use execFile
// (no shell); the one shell string tmux needs for new-session is built from
// validated names and single-quoted arguments.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const PREFIX = 'cc-';
export const tmuxName = (name) => PREFIX + name;

export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// HUB_TMUX_SOCKET runs sessions on a separate tmux server (tests, multiple hubs).
const SOCKET = process.env.HUB_TMUX_SOCKET ? ['-L', process.env.HUB_TMUX_SOCKET] : [];

async function tmux(args, { allowFail = false } = {}) {
  try {
    const { stdout } = await run('tmux', [...SOCKET, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`tmux ${args[0]} failed: ${(err.stderr || err.message).trim()}`, { cause: err });
  }
}

export async function hasSession(name) {
  return (await tmux(['has-session', '-t', `=${tmuxName(name)}`], { allowFail: true })) !== null;
}

export async function listSessions() {
  const out = await tmux(['list-sessions', '-F', '#{session_name}'], { allowFail: true });
  if (!out) return [];
  return out
    .split('\n')
    .filter((s) => s.startsWith(PREFIX))
    .map((s) => s.slice(PREFIX.length));
}

/** Start a detached tmux session running argv (an array) in cwd. */
export async function newSession(name, cwd, argv, env = {}) {
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${shQuote(v)}`)
    .join(' ');
  const cmd = `${envPrefix ? `env ${envPrefix} ` : ''}${argv.map(shQuote).join(' ')}`;
  await tmux(['new-session', '-d', '-s', tmuxName(name), '-c', cwd, '-x', '200', '-y', '50', cmd]);
  // Keep the pane around if claude exits so the user can see why.
  await tmux(['set-option', '-t', `=${tmuxName(name)}`, 'remain-on-exit', 'on'], { allowFail: true });
}

export async function killSession(name) {
  await tmux(['kill-session', '-t', `=${tmuxName(name)}`], { allowFail: true });
}

export async function capturePane(name, lines = 200) {
  const out = await tmux(['capture-pane', '-p', '-J', '-t', `=${tmuxName(name)}:`, '-S', `-${lines}`], {
    allowFail: true,
  });
  return out ?? '';
}

// Only these named keys can be sent from the UI or the orchestrator.
export const ALLOWED_KEYS = new Set([
  'Enter',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'Tab',
  'BTab',
  'C-c',
  '1',
  '2',
  '3',
  'y',
  'n',
]);

export async function sendKeys(name, keys) {
  for (const k of keys) {
    if (!ALLOWED_KEYS.has(k)) throw new Error(`key not allowed: ${k}`);
  }
  await tmux(['send-keys', '-t', `=${tmuxName(name)}:`, ...keys]);
}

/**
 * Claude Code shows interactive dialogs on first launch (development-channel
 * warning, MCP server consent, folder trust). Auto-select the accepting option
 * by reading the pane, finding the highlighted line (marked with ❯), and moving
 * the cursor until the desired option is highlighted. Stops when `isDone()`
 * returns true or after the timeout.
 */
const ACCEPT_OPTIONS = [
  'I am using this for local development',
  'Use this MCP server',
  'Yes, I trust this folder',
  'Yes, proceed',
];

export async function autoAcceptStartupDialogs(name, { isDone, timeoutMs = 90_000, log = () => {} }) {
  const start = Date.now();
  let presses = 0;
  while (Date.now() - start < timeoutMs && presses < 40) {
    await new Promise((r) => setTimeout(r, 1000));
    if (isDone()) return true;
    if (!(await hasSession(name))) return false;
    const lines = (await capturePane(name, 60)).split('\n');
    const target = ACCEPT_OPTIONS.find((opt) => lines.some((l) => l.includes(opt)));
    if (!target) continue;
    const selected = lines.find((l) => l.includes('❯'));
    if (selected && selected.includes(target)) {
      log(`[${name}] accepting dialog: ${target}`);
      await sendKeys(name, ['Enter']);
    } else {
      await sendKeys(name, ['Down']);
    }
    presses++;
  }
  return isDone();
}
