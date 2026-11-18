# Vault conventions

This vault is shared by the human and by every Claude Code session on cc-hub. Postgres keeps the raw message log; this vault keeps the knowledge worth reusing. Write here so a fresh session (or the human, six months from now) can pick up the work.

## Layout
- `Me/`: who the human is. `Me/Working with me.md` is loaded into every agent's system prompt (preferences and hard rules); `Me/About me.md` summarizes them and their work. **Owned by the human: agents never edit `Me/`**; propose changes in a reply instead. `Me/Identity.md` (if present) is for filling forms only: never copy it elsewhere.
- `Personal/`: the human's private life context (people, health, money, routines). Read only when a task involves it; never edit, quote, or mention it in work output or to other agents otherwise.
- `Areas/`: ongoing responsibilities that aren't hub projects.
- `Projects/<slug>/<slug>.md`: project index. Goal, status, milestones, links to everything below. Owned by the lead.
- `Projects/<slug>/Plan.md`: the approved plan. Owned by the lead.
- `Projects/<slug>/Decisions/`: one note per decision, from [[Templates/Decision]]. Append-only; supersede rather than rewrite.
- `Projects/<slug>/Notes/`: working notes and findings, one note per task: `T<task id> <short title>.md`.
- `Projects/<slug>/Reports/`: daily reports `YYYY-MM-DD.md`, written by the lead.
- `Projects/<slug>/Sources.md`: every external source used, with a one-line note on what it supports.
- `Knowledge/`: concepts that span projects (e.g. `Knowledge/Control flow graph.md`).
- `People/`: people the human works with, only what helps the work.

## Rules for agents
1. **Write only in your lane.** Never edit `Me/` or `Personal/`. Workers write in `Notes/` (their own task notes), `Decisions/` (new notes only), `Knowledge/` (new notes, or appending a clearly marked section), and append to `Sources.md`. Only the lead edits the project index, `Plan.md`, and `Reports/`.
2. **Link generously.** Every note links its project (`[[<slug>]]`), its task (`T<id>`), and any concept with a `Knowledge/` note. Create the `Knowledge/` note if a concept will matter again.
3. **Separate fact from claim.** Mark statements as *verified* (with source or test), *inferred*, or *assumption*. Never invent citations, results, or numbers.
4. **Front matter** on new notes:
   ```yaml
   ---
   project: <slug>
   task: <id or none>
   author: <session name>
   status: draft | final | superseded
   ---
   ```
5. **No secrets, credentials, or controlled/sensitive work information** in the vault.
6. The hub commits the vault to git every few minutes, so mistakes can be rolled back. Do not run git commands in the vault yourself.
