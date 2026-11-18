#!/usr/bin/env node
// Stand-in for the `claude` CLI used by the test suite. It implements the
// parts of Claude Code that cc-hub relies on: the startup dialog, loading the
// MCP config, acting as an MCP client of the channel server, receiving
// channel notifications, and relaying permission prompts.
//
// Test protocol (message bodies sent to the session):
//   CALL {"tool": "...", "args": {...}}  -> call the tool, reply "RESULT <tool> <json>"
//   PERM                                 -> emit a permission request (id "abcde")
//   anything from user                   -> reply "echo: <text>"
//   anything from a peer or the hub      -> no reply (avoids loops)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = (p) => import(path.join(root, 'node_modules', p));
const { Client } = await req('@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await req('@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const args = process.argv.slice(2);
const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
console.log(`ARGV mcp=${!!flag('--mcp-config')} channels=${flag('--dangerously-load-development-channels')} append_prompt=${!!flag('--append-system-prompt')} add_dir=${flag('--add-dir')} settings=${!!flag('--settings')} mode=${flag('--permission-mode') || 'default'}`);
console.log('WARNING: Loading development channels\n\n  ❯ 1. I am using this for local development\n    2. Exit');
await new Promise((r) => { const rl = readline.createInterface({ input: process.stdin }); rl.once('line', () => { rl.close(); r(); }); });
console.log('accepted');

const cfg = JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.hub;
const client = new Client({ name: 'fake-claude', version: '0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...cfg.env }, stderr: 'inherit' });

async function call(tool, a) {
  const r = await client.callTool({ name: tool, arguments: a });
  return { isError: !!r.isError, text: r.content?.[0]?.text ?? '' };
}

client.fallbackNotificationHandler = async (n) => {
  console.log('NOTIFY', n.method, JSON.stringify(n.params).slice(0, 300));
  if (n.method !== 'notifications/claude/channel') return;
  const text = n.params.content; const from = n.params.meta?.from;
  try {
    if (text.startsWith('CALL ')) {
      const { tool, args: a } = JSON.parse(text.slice(5));
      const r = await call(tool, a);
      await call('reply', { text: `RESULT ${tool} ${JSON.stringify(r)}` });
    } else if (text === 'PERM') {
      await client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls"}' } });
    } else if (from === 'user') {
      await call('reply', { text: `echo: ${text}` });
    }
  } catch (e) { console.log('ERROR', e.message); }
};
await client.connect(transport);
console.log('TOOLS', (await client.listTools()).tools.map((t) => t.name).join(','));
setInterval(() => {}, 1 << 30);
