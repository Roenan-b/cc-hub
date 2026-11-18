// Obsidian vault: the curated, linked knowledge base shared by every session.
// Postgres keeps the raw transcript; the vault keeps what is worth knowing.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

const TEMPLATE = path.join(ROOT, 'vault-template');

function copyMissing(src, dest, vars) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '_project') continue; // project skeleton is copied per project
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyMissing(from, to, vars);
    else if (!fs.existsSync(to)) fs.writeFileSync(to, fill(fs.readFileSync(from, 'utf8'), vars));
  }
}

const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

/** Create the vault from the template if needed; never overwrites existing notes. */
export function initVault(vault) {
  copyMissing(TEMPLATE, vault, { date: new Date().toISOString().slice(0, 10) });
}

export function projectDir(vault, slug) {
  return path.join(vault, 'Projects', slug);
}

/** Create Projects/<slug>/ from the project skeleton. Existing files are kept. */
export function initProjectFolder(vault, project) {
  const dir = projectDir(vault, project.slug);
  const vars = {
    slug: project.slug,
    title: project.title,
    goal: project.goal || '(to be written by the lead)',
    repos: project.repos.length ? project.repos.map((r) => `- \`${r}\``).join('\n') : '- (none yet)',
    date: new Date().toISOString().slice(0, 10),
  };
  const skeleton = path.join(TEMPLATE, '_project');
  const walk = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, e.name);
      const to = path.join(dest, e.name.replace('{{slug}}', project.slug));
      if (e.isDirectory()) walk(from, to);
      else if (!fs.existsSync(to)) fs.writeFileSync(to, fill(fs.readFileSync(from, 'utf8'), vars));
    }
  };
  walk(skeleton, dir);
  // Link the project from the vault home so it shows up in the graph.
  const home = path.join(vault, 'Home.md');
  const link = `- [[Projects/${project.slug}/${project.slug}|${project.title}]]`;
  if (fs.existsSync(home) && !fs.readFileSync(home, 'utf8').includes(link)) {
    fs.appendFileSync(home, `\n${link}`);
  }
  return dir;
}
