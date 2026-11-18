# Session permission settings

Passed to every session with `claude --settings <file>`: `worker.json` for workers, `lead.json` for the lead. They are **merged** with your own Claude Code settings.

- `allow` pre-approves routine, read-only or local-only commands so long autonomous runs are not stuck waiting on prompts for `git status` or the test runner.
- `deny` blocks destructive or credential-reading actions regardless of permission mode.

Anything not listed still prompts, and the prompt is relayed to the web UI. Tune these to your stack (add your build and test commands to `allow`). Deleting a file disables it.
