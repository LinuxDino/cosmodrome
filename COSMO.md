# COSMO.md - working on cosmodrome with cosmodrome

Every agent in this repo gets this file through cosmodrome (Claude, Copilot, agy, Codex, OpenCode
and the local router). The code map, hard rules and conventions are in `AGENTS.md`: read it first.

## The short version
- Zero runtime dependencies, Node >= 18.17, macOS + Linux. Never read, copy or forward login tokens.
- Run `npm test` before calling anything done, and add tests for new behaviour.
- Try the interface with `COSMODROME_HOME=/tmp/cosmo-dev node bin/cosmo.js` so the real config is never touched;
  test it in tmux as shown in `docs/interface.md#testing`.
- Keep user-facing text short and plain. Errors are `CosmoError(message, { hint })`.

## Which agent for what
| Agent | Use it for | Model |
|---|---|---|
| @claude | Changes across several files, design, refactors, reviews, debugging the interface | `opus` for big changes, `sonnet` for everyday work |
| @copilot | GitHub: issues, pull requests, Actions runs and their logs, release checks | `auto` (Copilot picks; GitHub Pro plan) |
| @agy | Web research: current CLI flags of other agents, npm/GitHub docs, broad questions about the repo | its default |
| @ollama | Router, short answers, commit messages, summaries - local and free | `qwen3:8b` (or the best one installed) |

- Not sure which one? Use `/router` (the local model splits the task) or `/council` for a second opinion.
- Agent CLI flags change often. Before changing `src/agents.js`, check the agent's current `--help`.

## Git and GitHub
- Work on a branch (`feat/...`, `fix/...`), never directly on `main`.
- When a change is done and `npm test` passes: commit, push the branch and open a pull request
  (`gh pr create`). CI runs the tests on macOS and Linux.
- Commits and tags are authored as `LinuxDino <43988024+LinuxDino@users.noreply.github.com>`.
  No `Co-Authored-By` trailers and no mentions of AI tools in commits, PRs or release notes.
- Never push to `main`, never push tags, never publish to npm. Releases happen in GitHub:
  bump `version` in `package.json` and the `CHANGELOG.md` in a pull request, merge it,
  then Actions -> Release -> Run workflow.

## Before you finish
- `npm test` passes, docs (`README.md`, `docs/`) and `CHANGELOG.md` match the change.
- Say what you checked and what you could not check (macOS behaviour, real agent logins).
