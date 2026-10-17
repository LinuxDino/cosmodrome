# cosmodrome

[![npm](https://img.shields.io/npm/v/cosmodrome)](https://www.npmjs.com/package/cosmodrome)
[![CI](https://github.com/LinuxDino/cosmodrome/actions/workflows/ci.yml/badge.svg)](https://github.com/LinuxDino/cosmodrome/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/LinuxDino/cosmodrome)](LICENSE)

**One control room for your AI coding agents.**

Cosmodrome is a zero-dependency Node.js CLI for running Claude Code, GitHub Copilot CLI, Codex, OpenCode, Antigravity, and Ollama through one terminal interface. It keeps work and private profiles separate, routes tasks automatically, delegates useful work, and preserves task state across restarts.

## What it does

- **One interface:** send natural-language work to the best available agent.
- **Separate accounts:** each profile has its own GitHub, git, and agent configuration.
- **Autonomous workflows:** Ollama can route tasks, delegate specialists, and supervise plan → execute → verify → review loops.
- **Durable work:** tasks, events, checkpoints, and unfinished work survive a Cosmo restart.
- **Safe modes:** ask mode is read-only; auto mode allows the selected agent to edit the current folder.
- **Artifacts:** save research, answers, and generated files as folders or zip archives.

## Install

Requirements:

- macOS or Linux (Windows via WSL)
- Node.js >= 18.17
- `git`
- `gh` (GitHub CLI) for GitHub profile authentication

```bash
npm install -g cosmodrome
cosmo doctor
```

Install any agent you want to use:

| Agent | Install |
|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| GitHub Copilot CLI | `npm install -g @github/copilot` |
| OpenCode | `npm install -g opencode-ai` |
| OpenAI Codex CLI | `npm install -g @openai/codex` |
| Antigravity CLI | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| Ollama (optional, local) | `brew install ollama && ollama pull qwen3:8b` |

## Quick start

```bash
cosmo
```

Inside the interface:

```text
/init                         Create a profile
/login                        Sign in to GitHub for the current profile
/login claude                 Sign in through the agent's official CLI
Implement the next feature    Route and execute a task automatically
/tasks                        List saved and unfinished work
/review                       Review project health and agent ownership
/loop ship the feature        Run a verified implementation loop
```

Useful shortcuts:

- `#work/claude` — switch profile and agent
- `@codex review this` — ask one agent directly
- `/mode ask` — read-only execution
- `/mode auto` — allow edits
- `/resume <task-id>` — continue work after a restart
- `Esc` — interrupt the active run

See the complete command and keyboard reference in [docs/interface.md](docs/interface.md).

## Profiles and safety

Cosmodrome starts each vendor's official CLI and gives it an isolated per-profile directory. It does not implement provider login flows or copy login tokens between agents.

Profiles isolate:

- GitHub CLI configuration and git identity
- Claude Code, Copilot, Codex, and OpenCode state
- Antigravity's private home directory
- task history and provider usage state

The active profile is selected from the current project folder when possible. Review the exact environment plan with:

```bash
cosmo status
cosmo env work claude
```

Use **ask** mode for inspection and advice. Use **auto** mode when an agent should edit files. Agents never receive more permission than the selected mode; use `/native` when you need the vendor's complete interactive permission flow.

Read the provider-specific login and permission notes in [docs/agents.md](docs/agents.md).

## Workflows

Ollama is optional. When available, it acts as a local supervisor:

1. Routes the task to the most suitable installed agent.
2. Delegates research, implementation, testing, or review when useful.
3. Tracks progress and provider limits.
4. Retries or switches providers when possible.
5. Returns a concise result with changed files and checks.

Durable task data is stored outside the repository under Cosmodrome's data directory. It contains task metadata and event history, not credentials.

## Project customization

- `COSMO.md` — project instructions shared with every agent.
- `.cosmo/` — project-local rules, skills, MCP configuration, and artifacts.
- `~/.config/cosmodrome/modules/` — optional JavaScript modules for custom commands and status items.

Start project guidance with:

```text
/project init
/skills init
```

See [docs/interface.md](docs/interface.md) and [examples/modules/standup.mjs](examples/modules/standup.mjs).

## Documentation

- [Interface guide](docs/interface.md)
- [Agent setup and provider notes](docs/agents.md)
- [GitHub profiles and publishing](docs/github-setup.md)
- [Project specification](SPEC.md)
- [Changelog](CHANGELOG.md)

## Development

```bash
git clone https://github.com/LinuxDino/cosmodrome.git
cd cosmodrome
npm test
```

Cosmodrome supports Node.js >= 18.17, macOS, and Linux. Runtime dependencies are intentionally kept at zero.

## License

MIT
