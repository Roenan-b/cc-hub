// Read-only listing of a project folder for the Files tab. Names, sizes and
// times only: file contents are never served. Symlinks are listed but never
// followed, so a link cannot expose anything outside the project folder.
import fs from 'node:fs/promises';
import path from 'node:path';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', '.cache', 'target']);

/**
 * @param {string} root absolute, already-validated project folder
 * @returns {Promise<{missing?: boolean, entries: Array, truncated: boolean}>}
 */
export async function listFiles(root, { maxDepth = 4, maxEntries = 1000 } = {}) {
  let st;
  try { st = await fs.lstat(root); } catch { return { missing: true, entries: [], truncated: false }; }
  if (!st.isDirectory()) return { missing: true, entries: [], truncated: false };
  const entries = [];
  let truncated = false;
  async function walk(dir, depth) {
    let names;
    try { names = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const d of names) {
      if (entries.length >= maxEntries) { truncated = true; return; }
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (d.isSymbolicLink()) { entries.push({ path: rel, type: 'link' }); continue; }
      if (d.isDirectory()) {
        const skipped = SKIP.has(d.name);
        entries.push({ path: rel, type: 'dir', ...(skipped ? { skipped: true } : {}) });
        if (!skipped && depth < maxDepth) await walk(full, depth + 1);
        else if (!skipped) entries[entries.length - 1].deeper = true;
        continue;
      }
      if (!d.isFile()) continue;
      try {
        const s = await fs.lstat(full);
        entries.push({ path: rel, type: 'file', size: s.size, mtime: s.mtime.toISOString() });
      } catch { /* vanished while listing */ }
    }
  }
  await walk(root, 1);
  return { entries, truncated };
}
