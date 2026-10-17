# Changelog

## Unreleased
- New logo: a star with an orbiting satellite (3 lines, 1 line on narrow terminals and after /clear), and an orbit spinner while an agent works. ASCII fallback (`COSMO_ASCII=1`, non-UTF-8 locales) and `COSMO_REDUCED_MOTION=1`.
- Fixed: Esc now stops the agent and every tool it started; a run can no longer hang on "Interrupting…".
- Fixed: Enter runs a slash command typed out in full (/native, /mode, /channel, ...).
- Fixed: Claude prompts starting with "-"; conversations after /cd; agent output with control codes breaking the screen; bold next to links.
- Esc reacts in 50 ms instead of 500 ms; the prompt is drawn in one synchronized write.

## 0.2.0
- New: `cosmo` opens a Claude Code–style interface: bordered input, slash command menu, channels (`#profile/agent`), `@agent` one-offs, `!` shell, ask/auto mode, streaming answers with tool calls, interrupt, history.
- New: artifacts (`/artifact`, `/research`, `/save`, `/artifacts`, `/show`, `/open`, `/zip`) with code-block → file extraction and a built-in zip writer.
- New: user modules in `~/.config/cosmodrome/modules/`.
- New: auto channel selection by folder, plus a warning when a channel doesn't own the folder.
- Docs: agents guide, GitHub setup guide, interface guide, AGENTS.md, CI and release workflows.

## 0.1.0
- Profiles with isolated GitHub, git identity and agent logins; `launch`, `login`, `fleet` (tmux), `shell`, `status`, `doctor`, `env`.
