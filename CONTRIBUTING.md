# Contributing to cc-hub

Thanks for helping. This guide covers how to set up, what we expect in a change, and how it gets merged.

## Ground rules

- Be respectful. Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report **security issues privately**, never in a public issue. See [SECURITY.md](SECURITY.md).
- Open an issue before a large change, so we can agree on the approach first.
- Never commit secrets, `.env` files, personal vault content, or anything from `Me/` or `Personal/`.

## Development setup

Prerequisites: Node 20.19+ (see `.nvmrc`), git, tmux, Postgres 16, and optionally shellcheck and PowerShell 7.

```bash
git clone https://github.com/<you>/cc-hub && cd cc-hub
npm ci
git config blame.ignoreRevsFile .git-blame-ignore-revs
createdb cchub_test
export TEST_DATABASE_URL=postgres://localhost/cchub_test
```

## Checks

Run these before you push. CI runs the same ones and must be green to merge.

| Command            | What it does                                                   |
| ------------------ | -------------------------------------------------------------- |
| `npm run lint`     | ESLint, Prettier check, markdownlint                           |
| `npm run lint:sh`  | shellcheck on every shell script (warning level and up)        |
| `npm run lint:fix` | Auto-fix ESLint issues and apply Prettier                      |
| `npm test`         | End-to-end suite (needs `TEST_DATABASE_URL`; that DB is wiped) |

PowerShell scripts are checked in CI under Windows PowerShell 5.1 and PowerShell 7 (`scripts/ci/Test-PowerShellSyntax.ps1`) and with PSScriptAnalyzer. They must keep working in the stock Windows 5.1 shell.

## Making a change

1. Fork, then branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`.
2. Keep changes focused. Don't mix refactors with behavior changes.
3. Add or update tests for behavior changes. A bug fix should come with a test that failed before it.
4. Update docs (`README.md`, `docs/`, `.env.example`) when behavior or configuration changes.
5. Open a pull request and fill in the template.

### Commit messages and PR titles

We use [Conventional Commits](https://www.conventionalcommits.org). PR titles are checked automatically, and release notes and version bumps are generated from them by release-please.

```text
feat(watchdog): detect expired Claude Code logins
fix(tmux): keep the error cause when a command fails
docs: explain vault sync conflicts
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Mark breaking changes with `!` (`feat!:`) and a `BREAKING CHANGE:` footer.

## Code style

- ES modules on Node 20+, no build step. Prettier formats everything (120 columns, single quotes).
- Prefer small, testable functions. Validate all external input at the boundary (HTTP, WebSocket, MCP tool arguments).
- Security-sensitive code (auth, role checks, filesystem roots, `send_keys`, approvals) needs a test showing it rejects what it should.
- Writing in docs and comments: plain and precise. No em dashes.

## Review and merge

- One approving review from a code owner and a green **CI passed** check are required.
- PRs are squash-merged, so the PR title becomes the commit message.
- Maintainers may ask for changes or split large PRs.

## Releases

Merging to `main` updates a release PR maintained by release-please. Merging that PR tags the version, publishes the GitHub release with the changelog, and attaches source archives, `SHA256SUMS`, and signed build provenance.
