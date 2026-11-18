// Git helpers: per-session worktrees (so parallel engineers never edit the
// same checkout) and vault auto-commits. execFile only, no shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const IDENT = ['-c', 'user.name=cc-hub', '-c', 'user.email=cc-hub@localhost'];

async function git(cwd, args) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/;

export async function isRepo(dir) {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

/**
 * Create (or reuse) a worktree at `dest` on `branch`. If the branch exists it is
 * checked out; otherwise it is created from `base` (default: current HEAD).
 */
export async function addWorktree({ repo, branch, dest, base = 'HEAD' }) {
  if (!BRANCH_RE.test(branch)) throw new Error('invalid branch name');
  if (!(await isRepo(repo))) throw new Error(`not a git repository: ${repo}`);
  if (fs.existsSync(dest)) {
    if (await isRepo(dest)) return { path: dest, reused: true };
    throw new Error(`worktree path exists and is not a checkout: ${dest}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let exists = true;
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    exists = false;
  }
  const args = exists ? ['worktree', 'add', dest, branch] : ['worktree', 'add', '-b', branch, dest, base];
  await git(repo, args);
  return { path: dest, reused: false };
}

export async function ensureVaultRepo(vault) {
  if (await isRepo(vault)) return;
  await git(vault, ['init', '-q']);
  // Vaults on a Windows drive (/mnt/c under WSL) report bogus mode changes.
  await git(vault, ['config', 'core.filemode', 'false']);
  await git(vault, [...IDENT, 'add', '-A']);
  await git(vault, [...IDENT, 'commit', '-q', '-m', 'cc-hub: initial vault']).catch(() => {});
}

/** Commit any vault changes. Returns the number of changed paths. */
export async function autocommit(vault, message) {
  const status = await git(vault, ['status', '--porcelain']);
  if (!status) return 0;
  await git(vault, [...IDENT, 'add', '-A']);
  await git(vault, [...IDENT, 'commit', '-q', '-m', message]);
  return status.split('\n').length;
}

/**
 * Two-way sync with a remote (e.g. a private GitHub repo) so the vault can be
 * opened on other devices. Commits local changes, rebases onto the remote, and
 * pushes. On a conflict it aborts the rebase, leaves local work committed, and
 * reports so a human can resolve it; it never discards either side.
 */
export async function syncVault(vault, remote, branch = 'main') {
  const remotes = (await git(vault, ['remote'])).split('\n');
  if (!remotes.includes('origin')) await git(vault, ['remote', 'add', 'origin', remote]);
  else if ((await git(vault, ['remote', 'get-url', 'origin'])) !== remote)
    await git(vault, ['remote', 'set-url', 'origin', remote]);
  const current = await git(vault, ['branch', '--show-current']);
  if (current !== branch) await git(vault, ['branch', '-M', branch]);
  const committed = await autocommit(vault, `cc-hub autocommit ${new Date().toISOString()}`);
  try {
    await git(vault, ['fetch', '-q', 'origin']);
  } catch (e) {
    return { ok: false, committed, error: `fetch failed: ${e.stderr || e.message}` };
  }
  const hasRemoteBranch = await git(vault, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]).then(
    () => true,
    () => false,
  );
  if (hasRemoteBranch) {
    try {
      await git(vault, [...IDENT, 'rebase', '-q', `origin/${branch}`]);
    } catch (e) {
      await git(vault, ['rebase', '--abort']).catch(() => {});
      return {
        ok: false,
        committed,
        conflict: true,
        error: 'vault changed in two places at once; resolve with git in the vault folder',
      };
    }
  }
  try {
    await git(vault, ['push', '-q', 'origin', `HEAD:${branch}`]);
  } catch (e) {
    return { ok: false, committed, error: `push failed: ${e.stderr || e.message}` };
  }
  return { ok: true, committed };
}
