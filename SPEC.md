# cosmodrome – spec (v0.2)

**Idea:** `cosmo` opens a Claude Code–style terminal interface that drives several AI coding agents through **channels** (`profile/agent`). Profiles such as *work* and *private* each have their own GitHub account, git identity, and agent logins.

**Core rule:** never touch tokens. cosmodrome only starts the official CLIs and points each one at a per-profile folder, so every sign-in happens in the vendor's own tool.

## Scope
- npm package, Node ≥ 18.17, macOS + Linux, zero runtime dependencies.
- **Interface:** bordered input, `/` command menu with completion, `#` channels, `@` one-off agent, `!` shell, ask/auto mode, streaming answers, interrupt, history, modular status line.
- **Agent runs:** one-shot headless mode of each CLI (Claude `-p` stream-json, Copilot `-p -s`, OpenCode `run`, Codex `exec`, agy `-p`). Conversations continue per channel. `/native` hands the terminal to the full agent UI.
- **Artifacts:** answers saved as folders; code blocks become files; `/zip` packs them (built-in zip writer).
- **Auto switch:** a folder inside a profile's `workdir` selects that profile, and you get a warning when a channel doesn't match the folder.
- **Modules:** `~/.config/cosmodrome/modules/*.mjs` add commands and status items.
- **CLI:** `init`, `profile`, `login`, `<profile> [agent]`, `fleet` (tmux), `shell`, `status`, `doctor`, `agents`, `env`, `config`.

## Isolation
gh → `GH_CONFIG_DIR` · git → `GIT_CONFIG_GLOBAL` · Claude → `CLAUDE_CONFIG_DIR` · Copilot → `COPILOT_HOME` · OpenCode → XDG dirs · Codex → `CODEX_HOME` · agy → private `HOME`. Shell tokens are scrubbed unless listed in `passthroughEnv`.

## Files
Config `~/.config/cosmodrome/config.json` · profiles `~/.local/share/cosmodrome/profiles/<name>/` · artifacts `<repo>/.cosmo/artifacts/` · `COSMODROME_HOME` puts config and data in one folder.

## Known limits
Shared macOS Keychain for agy and Claude Code before ~2.1.121 (`doctor` warns) · agy's private HOME hides `~/.ssh` · login state can't be verified offline · headless flags can change between agent versions (each lives in `src/agents.js`).

## Later
git worktree per fleet pane · ACP transport for richer tool views · artifact preview pane.
