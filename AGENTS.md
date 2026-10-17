# AGENTS.md – notes for AI coding agents working on cosmodrome

## What this is
A zero-dependency Node.js CLI (`cosmo`) published to npm. It runs on macOS and Linux. It launches official AI agent CLIs per profile and includes a Claude Code–style terminal interface.

## Hard rules
1. **Never handle credentials.** No reading, copying, refreshing or forwarding of any login token. Isolation works only by pointing official CLIs at per-profile folders (env vars in `src/agents.js`).
2. **No runtime dependencies.** Use Node built-ins only (`node:*`). Dev tooling is also built-in (`node --test`).
3. Support Node ≥ 18.17 on macOS and Linux. Don't use APIs newer than that without a fallback.
4. Keep user-facing text short and plain. Errors are `CosmoError(message, { hint })`.

## Layout
```
bin/cosmo.js            entry point
src/cli.js              commands (init, profile, login, launch, fleet, shell, status, doctor, env, config) + cliApi
src/agents.js           built-in agents: install hint, isolation env, login args, headless args
src/env.js              per-profile environment plan (scrubbing, gitconfig, agent dirs) - pure, tested
src/config.js paths.js  config file + XDG paths
src/artifacts.js zip.js artifact folders, code-block extraction, zip writer
src/orchestrator.js     local Ollama router: plan, <cosmo:subagent> parsing, /delegate, /council
src/usage.js            per-agent usage, cooldowns and automatic switch on usage limits
src/skills.js           shared rules, skills and MCP; sync into each agent's folder (managed blocks only)
src/context.js          the cooperation briefing given to agents and the router
src/tui/app.js          interactive interface (input, rendering, dispatch, agent runs)
src/tui/commands.js     built-in slash commands
src/tui/channels.js     profile/agent channels, sessions, auto switch
src/tui/runner.js       headless process runner (+ Claude stream-json parser)
src/tui/components/     header, promptBox, menu, statusLine, spinner (pure render functions)
src/tui/screen.js       inline renderer (only the prompt area is redrawn)
test/                   node:test suites
```

## Commands
```bash
npm test                         # all tests (node --test)
node bin/cosmo.js doctor         # local smoke check
COSMODROME_HOME=/tmp/c node bin/cosmo.js   # try the UI without touching your real config
```

## Conventions
- ESM, 2-space indent, single quotes, semicolons.
- Keep render code pure: components take state and return `string[]`; `Screen` does the terminal writes.
- New agent: add it to `BUILTIN_AGENTS` with `env`, `install`, `loginArgs`, `headless.build`, and a test in `test/tui.test.js`.
- New slash command: add it to `registerBuiltinCommands` in `src/tui/commands.js` (`name`, `args`, `description`, `run`, optional `complete`).
- Interactive things (wizards, native agents, tmux) must run inside `app.suspend(fn)`.
- Test the interface manually in tmux. See `docs/interface.md#testing`.
