# Changelog

## 0.7.0
- New: durable task journal with task IDs, event history, checkpoints, restart recovery, and `/tasks`, `/resume`, and `/cancel` controls.
- New: governance roster and review loops. `/roster` shows agent responsibilities, `/review` audits project health read-only, and `/loop` requires plan, execution, verification, review, and acceptance checks.
- New: automatic routing asks Ollama to choose an executor for every normal message; routed work starts in auto mode, council synthesis can execute, and all-provider cooldowns retry automatically.
- New: shorter onboarding README focused on installation, safety, profiles, workflows, and documentation.

## 0.6.0
- New: router mode starts enabled so normal messages automatically flow through local orchestration without requiring a mode switch.
- New: automatic local model selection prefers Qwen3.5, Qwen3, Ministral 3, Gemma 4, and Qwen2.5-Coder, with `COSMO_LOCAL_MODEL` and `/router <model>` overrides.
- Improved: routing is concise; advisor output is bounded and Claude is the preferred finalizer when available.
- Improved: all headless agent prompts receive the Cosmodrome context and skills-first instruction, including delegated Claude work.
- Fixed: Copilot headless runs explicitly request text output so edits no longer finish with an empty response.
- Fixed: project-local skills and `COSMO.md` are loaded from the directory passed to `--cd`.

## 0.5.0
- New: `COSMO.md` - one instructions file per project that every agent gets (Claude, Copilot, agy, Codex, OpenCode, the router). `/project init` creates it; this repo has its own.
- New: model per agent and profile - `/model claude opus`, `/model copilot auto`, or `profiles.<name>.agents.<agent>.model` in the config. Used in the interface and in native launches.
- Copilot CLI: flags checked against 1.0.98. Ask mode now uses Copilot's real permission patterns (`--deny-tool=write --deny-tool=shell`); the old `view/glob/grep` patterns don't exist. Copilot gets the shared instructions via `copilot-instructions.md` and the MCP servers via `--additional-mcp-config`.
- New: local orchestrator with Ollama. `@ollama` runs a local model; `/router` lets it plan each message and hand parts to other agents; `/delegate` and `/council` split a task or ask several agents in parallel and merge the answers.
- New: automatic switch to another installed agent when one hits a usage limit, with a cooldown; `/usage` shows runs, cost, cooldowns and switches.
- New: shared rules, skills and MCP servers for all agents (`/skills`, `/mcp`), a live tool line under the spinner, and clickable file links.
- Subagents never get more rights than you (ask mode stays read-only) and one answer starts at most 4.
- Agent sync only edits cosmo's own section of `CLAUDE.md`/`AGENTS.md`, never touches Claude's `.claude.json` (MCP goes through `--mcp-config`), leaves unreadable config files alone, and keeps skill names to safe folder names.
- Fixed: a normal answer that mentions rate limits no longer counts as a usage limit; `@ollama` uses an installed model instead of a fixed default; plan tags no longer show in answers.
- Restored the 0.4.0 changes that the orchestrator merge had overwritten.

## 0.4.0
- `/channels` draws each profile as a small orbit: the agents are its satellites, the current channel is the bright one.
- cosmo starts on a clean window at the top; what was on screen moves into the scrollback. `COSMO_NO_CLEAR=1` keeps the old behaviour.
- Fixed: `/init` could get stuck: a half-finished setup said "Already set up" with no profiles. It now continues with the first profile.
- Profile names are forgiving: "Private" becomes `private`, "My Work" becomes `my-work`; an invalid name asks again instead of stopping. "n"/"no" ends the setup.
- Hints inside the interface name slash commands (`/login`, `/profile add`) instead of shell commands.
- Emoji and combined characters are measured correctly (✅, ❤️, 👨‍👩‍👧, flags), so the input box and cursor stay aligned; editing never splits one.
- Ctrl+Z puts cosmo in the background (`fg` brings it back); Ctrl+J and `\` + Enter insert a new line; Ctrl+L keeps the scrollback.
- Esc tells you that a second Esc force-stops the agent.
- Colors follow `FORCE_COLOR`, `NO_COLOR` (non-empty, per no-color.org) and `TERM=dumb`, the same way in the interface and on the command line.
- If cosmo crashes, the terminal is restored and a running agent is stopped.
- Releases can be started from GitHub (Actions → Release → Run workflow); the workflow publishes and tags the version itself.

## 0.3.0
- New logo: a star with an orbiting satellite (3 lines, 1 line on narrow terminals and after /clear), and an orbit spinner while an agent works. ASCII fallback (`COSMO_ASCII=1`, non-UTF-8 locales) and `COSMO_REDUCED_MOTION=1`.
- Fixed: Esc now stops the agent and every tool it started; a run can no longer hang on "Interrupting…".
- Fixed: Enter runs a slash command typed out in full (/native, /mode, /channel, ...).
- Fixed: Claude prompts starting with "-"; conversations after /cd; agent output with control codes breaking the screen; bold next to links.
- Narrow terminals: the status line drops the least important parts first, long folders are shortened in the middle, and the prompt area never grows taller than the terminal. Shrinking the window no longer leaves old borders behind.
- ASCII mode now covers the whole interface, not only the logo.
- Clearer errors: a failed agent run says what to do next (e.g. `/login claude` when it isn't signed in), and typos get "did you mean" for commands, profiles and agents.
- macOS: `cosmo doctor` checks whether Claude Code keeps a separate Keychain login per profile (about 2.1.121+) and warns for older versions and agy; `profile remove` reminds you to sign out first.
- Esc reacts in 50 ms instead of 500 ms; the prompt is drawn in one synchronized write.

## 0.2.0
- New: `cosmo` opens a Claude Code–style interface: bordered input, slash command menu, channels (`#profile/agent`), `@agent` one-offs, `!` shell, ask/auto mode, streaming answers with tool calls, interrupt, history.
- New: artifacts (`/artifact`, `/research`, `/save`, `/artifacts`, `/show`, `/open`, `/zip`) with code-block → file extraction and a built-in zip writer.
- New: user modules in `~/.config/cosmodrome/modules/`.
- New: auto channel selection by folder, plus a warning when a channel doesn't own the folder.
- Docs: agents guide, GitHub setup guide, interface guide, AGENTS.md, CI and release workflows.

## 0.1.0
- Profiles with isolated GitHub, git identity and agent logins; `launch`, `login`, `fleet` (tmux), `shell`, `status`, `doctor`, `env`.
