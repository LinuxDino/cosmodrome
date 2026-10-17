# ✦ cosmodrome

**One launch pad for all your AI coding agents.** Type `cosmo` and you get a Claude Code–style interface with slash commands, channels for every profile and agent, web research, and artifacts you can bundle into a zip. Work and private stay apart: each profile has its own GitHub account, git identity, and agent logins.

```
  .-'''''-.
.'    ✦    '.◉    cosmodrome v0.4.0
 '-._____.-'      ~/work/api
/ commands · # channel · @ other agent · ! shell · ? keys

↪ #work/claude  (folder ~/work)
> /research how do npm trusted publishers work
⏺ WebSearch(npm trusted publishing)
⏺ npm trusted publishing
  • Short-lived OIDC tokens replace long-lived NPM_TOKEN secrets …
  ⎿ claude · 41s · $0.084
✓ Saved artifact #3 (1 file) ~/work/api/.cosmo/artifacts/…-how-do-npm-trusted-publishers-work
╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯
  #work/claude · ask mode · GitHub dino-ce · ~/work/api · ⎇ main
```

## Why

- **Every login stays official.** cosmodrome never reads or forwards tokens. It starts the vendors' own CLIs (Claude Code, GitHub Copilot CLI, OpenCode, Codex, Antigravity) and points each one at a per-profile folder. That keeps you inside each provider's terms. See [docs/agents.md](docs/agents.md).
- **Accounts never mix.** `#work/claude` and `#private/claude` are different logins, different GitHub accounts, and different git identities. Folders auto-select the right profile.
- **One interface, many agents.** Switch with `#private/copilot`, ask a second agent once with `@codex …`, or open any agent's full native UI with `/native`.

## Install

```bash
npm install -g cosmodrome      # macOS + Linux (Windows: WSL), Node >= 18.17
cosmo doctor                   # what's installed, what's missing
```

Update with `npm install -g cosmodrome@latest`. The same releases are also on GitHub Packages as `@linuxdino/cosmodrome` (see [docs/github-setup.md](docs/github-setup.md#github-packages)).

Then install the agents you want (any subset):

| Agent | Install |
|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| GitHub Copilot CLI | `npm install -g @github/copilot` (needs Node 22+) |
| OpenCode | `npm install -g opencode-ai` |
| OpenAI Codex CLI | `npm install -g @openai/codex` |
| Antigravity CLI (Google) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |

You also need `git` ≥ 2.32, plus `gh` (GitHub CLI) for per-profile GitHub logins. `tmux` is optional and only needed for `/fleet`.

## Quick start

```bash
cosmo                 # opens the interface
/init                 # create profiles, e.g. "work" (folder ~/work) and "private"
/login                # GitHub login for the current profile (via gh)
/login claude         # sign in to an agent - inside its own CLI
hello!                # chat with the current channel
```

## The interface

| You type | What happens |
|---|---|
| `text` | Sent to the current channel's agent; the conversation continues across messages |
| `/command` | Slash commands. Type `/` for the menu, Tab to complete |
| `#work/copilot` | Switch channel (add text to send right away: `#private/agy hi`) |
| `@codex review this` | Ask another agent of the same profile once |
| `!git status` | Shell command with the profile's GitHub + git identity |

**Keys:** Enter sends · Tab completes · ↑↓ history/menu · Shift+Tab toggles ask/auto mode · Ctrl+O next agent · Esc interrupts · Ctrl+L clears · Alt+Enter or Ctrl+J new line · Ctrl+Z background · Ctrl+C twice exits.

**Modes:** *ask* (default) lets the agent read files and search the web, with no edits. *auto* lets it edit files in the current folder. For anything bigger, `/native` opens the agent's full interface and brings you back here when you exit.

### Slash commands

| Command | Purpose |
|---|---|
| `/channel`, `/channels` | Switch / list channels (profile + agent) |
| `/research <topic>` | Web research → markdown report, saved as an artifact |
| `/artifact <what>` | Agent creates complete files → saved as an artifact |
| `/save [title]` | Save the last answer as an artifact |
| `/artifacts`, `/show n`, `/open n` | Browse artifacts |
| `/zip [n\|all]` | Bundle artifacts into a `.zip` |
| `/native` | Open the agent's own interface |
| `/fleet a b c` | Several agents side by side in tmux |
| `/login [gh\|agent]` | Official sign-in for this profile |
| `/mode`, `/new`, `/cd` | Ask/auto mode · fresh conversation · change folder (auto-switches channel) |
| `/init`, `/profile …`, `/status`, `/doctor`, `/agents` | Setup and checks |
| `/shell` | Interactive shell with the profile identity |
| `/modules` | Your custom commands |
| `/help`, `/clear`, `/exit` | |

Full guide: [docs/interface.md](docs/interface.md).

### Artifacts

Answers from `/artifact`, `/research` or `/save` become folders. Each one holds the full answer plus every code block as a real file (```` ```README.md ```` → `README.md`). Inside a git repo they go to `.cosmo/artifacts/` (git-ignored automatically); elsewhere they go to the cosmodrome data folder. `/zip all` packs everything into one zip.

### Modules

Drop a `.mjs` file into `~/.config/cosmodrome/modules/` to add your own slash commands and status items. See [examples/modules/standup.mjs](examples/modules/standup.mjs) and [docs/interface.md#modules](docs/interface.md#modules).

## Command line (scripts, quick launches)

```bash
cosmo work claude --resume       # native Claude Code as "work" (args go to the agent)
cosmo fleet work claude copilot  # tmux panes
cosmo login private agy          # sign in to Antigravity as "private"
cosmo status                     # who is signed in where
eval "$(cosmo env work)"         # this shell becomes "work"
cosmo profile add work --agent claude --git-email you@company.com --workdir ~/work
```

## How isolation works

| Part | Per-profile mechanism |
|---|---|
| GitHub (gh) | `GH_CONFIG_DIR` |
| git identity + HTTPS auth | `GIT_CONFIG_GLOBAL` → generated file that includes your `~/.gitconfig`, then sets user + gh credential helper |
| Claude Code | `CLAUDE_CONFIG_DIR` |
| Copilot CLI | `COPILOT_HOME` |
| OpenCode | `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` |
| Codex | `CODEX_HOME` |
| Antigravity | private `HOME` (it has no config-dir option) |

Tokens exported in your shell (`GH_TOKEN`, `ANTHROPIC_API_KEY`, …) are removed before any agent starts, unless a profile lists them in `passthroughEnv`.

> **macOS note:** some CLIs keep their login in the macOS Keychain. Recent Claude Code versions (about 2.1.121 and later) keep one Keychain entry per profile folder; older ones share a single entry, and agy always uses the shared Keychain. `cosmo doctor` checks this for you. After your first logins, confirm the account per profile (`/status` inside Claude Code, the header in agy).

## Docs

- [docs/interface.md](docs/interface.md): keys, channels, modes, artifacts, modules API
- [docs/agents.md](docs/agents.md): every agent, how it logs in, provider rules, known issues
- [docs/github-setup.md](docs/github-setup.md): two GitHub accounts, git auth, and publishing this project
- [SPEC.md](SPEC.md): one-page spec · [AGENTS.md](AGENTS.md): notes for AI agents working on this repo

## License

MIT
