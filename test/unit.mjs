#!/usr/bin/env node
// Unit tests for the live-view helpers that need no database or tmux:
// secret masking, tool previews, team plan validation, observer redaction,
// the activity hook script, and the read-only folder listing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTeamPlan, previewToolInput, redactEvent, scrubSecrets, cleanToolName } from '../src/events.mjs';
import { listFiles } from '../src/projectfs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0; let failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}

await step('scrubSecrets masks common credential shapes', () => {
  assert.equal(scrubSecrets('curl -H "Authorization: Bearer abcdefghijkl" x'), 'curl -H "Authorization: Bearer *** x');
  assert.equal(scrubSecrets('API_KEY=hunter22 npm start'), 'API_KEY=*** npm start');
  assert.equal(scrubSecrets('--password "two words"'), '--password "two words"'); // flag without = is left alone
  assert.equal(scrubSecrets('db_password: "two words" ok'), 'db_password: *** ok');
  assert.equal(scrubSecrets('use ghp_abcdefghijklmnopqrstuvwx now'), 'use *** now');
  assert.equal(scrubSecrets(`blob ${'A'.repeat(48)} end`), 'blob *** end');
  assert.equal(scrubSecrets('ls -la src'), 'ls -la src');
});

await step('previewToolInput picks the useful field and clips it', () => {
  assert.equal(previewToolInput('Bash', { command: 'npm test -- --token=abc', description: 'run' }), 'npm test -- --token=***');
  assert.equal(previewToolInput('Read', { file_path: '/w/a.txt' }), '/w/a.txt');
  assert.equal(previewToolInput('Grep', { pattern: 'foo', path: 'src' }), 'foo in src');
  assert.equal(previewToolInput('TodoWrite', { todos: [1, 2] }), '2 todos');
  assert.equal(previewToolInput('Bash', null), '');
  assert.equal(previewToolInput('Bash', { command: 'echo hi '.repeat(200) }).length, 300);
  assert.equal(cleanToolName('mcp__hub__task_list<script>'), 'mcp__hub__task_listscript');
});

await step('normalizeTeamPlan validates keys, titles and templates', () => {
  const t = ['lead', 'general', 'engineer', 'reviewer'];
  const ok = normalizeTeamPlan([{ key: 'db-sec', title: 'Postgres security', template: 'engineer', expertise: 'RLS', why: 'auth' }], t);
  assert.deepEqual(ok, [{ key: 'db-sec', title: 'Postgres security', template: 'engineer', expertise: 'RLS', why: 'auth' }]);
  assert.throws(() => normalizeTeamPlan([], t), /1-20/);
  assert.throws(() => normalizeTeamPlan([{ key: 'Bad Key', title: 'x' }], t), /key must match/);
  assert.throws(() => normalizeTeamPlan([{ key: 'a', title: 'x' }, { key: 'a', title: 'y' }], t), /duplicate/);
  assert.throws(() => normalizeTeamPlan([{ key: 'a', title: '' }], t), /title is required/);
  assert.throws(() => normalizeTeamPlan([{ key: 'a', title: 'x', template: 'lead' }], t), /template must be one of/);
  assert.throws(() => normalizeTeamPlan(Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, title: 'x' })), t), /1-20/);
});

await step('redactEvent hides agent text and the private detail', () => {
  const e = { id: 1, kind: 'team_plan', summary: 'lead planned 1 expert', text: 'because', detail: { experts: [{ key: 'a' }], private: { experts: [{ why: 'secret' }] } } };
  const r = redactEvent(e);
  assert.equal(r.text, '[7 chars]');
  assert.equal(r.summary, e.summary);
  assert.deepEqual(r.detail, { experts: [{ key: 'a' }] });
  assert.equal(redactEvent({ text: '', detail: null }).text, '');
});

await step('activity hook appends one line, prints nothing and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cchub-unit-'));
  const file = path.join(dir, 'a.activity.jsonl');
  const run = (input) => spawnSync(process.execPath, [path.join(ROOT, 'src', 'activity-hook.mjs'), file], { input, encoding: 'utf8' });
  let r = run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo secret=abc' } }));
  assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  r = run(JSON.stringify({ hook_event_name: 'Stop' }));
  assert.equal(r.status, 0);
  r = run('not json');
  assert.equal(r.status, 0); assert.equal(r.stdout, '');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event, 'tool'); assert.equal(lines[0].tool, 'Bash'); assert.equal(lines[0].preview, 'echo secret=***');
  assert.equal(lines[1].event, 'idle');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

await step('listFiles lists names only, skips heavy folders, never follows links', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cchub-unit-'));
  fs.mkdirSync(path.join(dir, 'src/deep/er/still/more'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'abc');
  fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/x/i.js'), '');
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'out'));
  const r = await listFiles(dir);
  const by = Object.fromEntries(r.entries.map((e) => [e.path, e]));
  assert.equal(by['src/a.js'].size, 3);
  assert.equal(by.node_modules.skipped, true);
  assert.ok(!by['node_modules/x']);
  assert.equal(by.out.type, 'link');
  assert.ok(!r.entries.some((e) => e.path.startsWith('out/')));
  assert.equal(by['src/deep/er/still'].deeper, true);
  assert.ok(!by['src/deep/er/still/more']);
  assert.equal((await listFiles(dir, { maxEntries: 2 })).truncated, true);
  assert.equal((await listFiles(path.join(dir, 'nope'))).missing, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
