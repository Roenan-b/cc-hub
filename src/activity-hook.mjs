#!/usr/bin/env node
// Claude Code hook (PreToolUse and Stop) installed by the hub in every session's
// generated settings. It appends one JSON line describing the tool call to the
// session's activity file, which the hub reads for the live agent view.
//
//   node activity-hook.mjs <activity-file>      (hook input JSON on stdin)
//
// It must never block or change what Claude does: it prints nothing, always
// exits 0, and gives up after a short timeout.
import fs from 'node:fs';
import { cleanToolName, previewToolInput } from './events.mjs';

const file = process.argv[2];
const MAX_STDIN = 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024; // the hub drains the file every few seconds; this caps runaway growth

setTimeout(() => process.exit(0), 3000).unref();

let raw = '';
let size = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  size += c.length;
  if (size <= MAX_STDIN) raw += c;
});
process.stdin.on('end', () => {
  try {
    if (!file) return;
    const h = JSON.parse(raw || '{}');
    const event = String(h.hook_event_name || '');
    let line;
    if (event === 'PreToolUse') {
      line = { ts: new Date().toISOString(), event: 'tool', tool: cleanToolName(h.tool_name), preview: previewToolInput(h.tool_name, h.tool_input) };
    } else if (event === 'Stop') {
      line = { ts: new Date().toISOString(), event: 'idle' };
    } else {
      return;
    }
    try { if (fs.statSync(file).size > MAX_FILE) return; } catch { /* file does not exist yet */ }
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // Never let a reporting problem surface in the agent's session.
  } finally {
    process.exit(0);
  }
});
process.stdin.on('error', () => process.exit(0));
