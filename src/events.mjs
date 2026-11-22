// Pure helpers for the live agent view. No database or config imports, so the
// activity hook (which Claude Code runs on every tool call) and the unit tests
// can load this cheaply.

export const EVENT_KINDS = new Set([
  'thinking', 'progress', 'team_plan', 'spawn', 'stop', 'status', 'tool', 'task', 'approval', 'message', 'project',
]);
export const PHASES = ['understand', 'plan', 'approve', 'staff', 'build', 'review', 'report'];
export const TEXT_MAX = 2000;
export const PREVIEW_MAX = 300;

/**
 * Mask obvious credentials before tool input reaches the database or a screen.
 * Best effort: it catches key=value, "Authorization: ...", bearer tokens, and
 * long opaque strings. It is not a substitute for keeping secrets out of chats.
 */
export function scrubSecrets(text) {
  return String(text)
    .replace(/\b(authorization\s*:\s*)(bearer|basic|token)?\s*\S+/gi, (m, a, b) => `${a}${b ? `${b} ` : ''}***`)
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/\b([A-Za-z0-9_]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2***')
    .replace(/\b(?:ghp|gho|ghs|github_pat|sk|xox[abpr]|AKIA)[A-Za-z0-9_-]{12,}/g, '***')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '***');
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One short line describing what a Claude Code tool call is about. */
export function previewToolInput(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = (...keys) => keys.map((k) => i[k]).find((v) => typeof v === 'string' && v);
  let p;
  switch (tool) {
    case 'Bash': p = pick('command', 'description'); break;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': p = pick('file_path', 'notebook_path'); break;
    case 'Grep': case 'Glob': p = [pick('pattern'), pick('path')].filter(Boolean).join(' in '); break;
    case 'WebFetch': p = pick('url'); break;
    case 'WebSearch': p = pick('query'); break;
    case 'Task': case 'Agent': p = pick('description', 'subagent_type'); break;
    case 'TodoWrite': p = Array.isArray(i.todos) ? `${i.todos.length} todos` : ''; break;
    default: p = pick('description', 'command', 'file_path', 'path', 'query', 'url', 'name', 'text') || '';
  }
  return clip(scrubSecrets(p || ''), PREVIEW_MAX);
}

/** Tool names come from Claude Code; keep them to a safe display form. */
export const cleanToolName = (t) => clip(String(t || 'tool').replace(/[^\w.:-]/g, ''), 80) || 'tool';

/**
 * Observer copy of an event: agent-written text becomes a length marker and the
 * private part of detail is dropped. Summaries are hub-written and kept.
 */
export function redactEvent(e) {
  const { private: _p, ...detail } = e.detail || {}; // eslint-disable-line no-unused-vars
  return { ...e, text: e.text ? `[${e.text.length} chars]` : '', detail };
}

/**
 * Validate a team plan from the lead. Returns the normalized roster or throws
 * an Error with a message the agent can act on.
 */
export function normalizeTeamPlan(experts, templates) {
  if (!Array.isArray(experts) || !experts.length || experts.length > 20) throw new Error('experts must be an array of 1-20 entries');
  const seen = new Set();
  return experts.map((x, n) => {
    if (!x || typeof x !== 'object') throw new Error(`experts[${n}] must be an object`);
    const key = String(x.key || '');
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(key)) throw new Error(`experts[${n}].key must match ^[a-z0-9][a-z0-9-]{0,31}$`);
    if (seen.has(key)) throw new Error(`duplicate expert key ${key}`);
    seen.add(key);
    const title = clip(x.title, 80);
    if (!title) throw new Error(`experts[${n}].title is required`);
    const template = String(x.template || 'general');
    if (!templates.includes(template) || template === 'lead') throw new Error(`experts[${n}].template must be one of: ${templates.filter((t) => t !== 'lead').join(', ')}`);
    return { key, title, template, expertise: clip(x.expertise, 1000), why: clip(x.why, 500) };
  });
}
