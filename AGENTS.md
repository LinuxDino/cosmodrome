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
src/core/               agent work without any terminal code (no imports from src/tui, no stdout)
  events.js             protocol event types, validateEvent, PROTOCOL_VERSION (docs/protocol.md)
  session.js            CoreSession: mode, cwd, channel, conversations, runs, failover; emits events
  planner.js            JSON plan: schema, validation, Ollama/Claude planner, keyword router fallback
  executor.js           runs a plan: dependsOn groups in parallel, skip on failed deps, synthesis
  adapters/             one per agent: args from agents.js -> normalized events; base.js = process
                        handling, mock.js replays test/fixtures, ollama.js uses the HTTP API
src/orchestrator.js     local model helpers (ollama list, model pick), tag display helpers
src/usage.js            per-agent usage, cooldowns and automatic switch on usage limits
src/skills.js           shared rules, skills and MCP; sync into each agent's folder (managed blocks only)
src/context.js          the cooperation briefing given to agents and the router
src/tui/app.js          interactive interface (input, rendering, dispatch); agent work goes to CoreSession
src/tui/coreView.js     renders core events (streamed text, tool lines, plan tree, meta line)
src/tui/commands.js     built-in slash commands
src/tui/channels.js     profile/agent channels, sessions, auto switch
src/tui/runner.js       runs `!shell` commands (agents run through src/core/adapters)
src/tui/components/     header, promptBox, menu, statusLine, spinner (pure render functions)
src/tui/screen.js       inline renderer (only the prompt area is redrawn)
test/                   node:test suites; test/fixtures/<agent>/<case>.jsonl = recorded agent output
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
- New agent: add it to `BUILTIN_AGENTS` with `env`, `install`, `loginArgs`, `headless.build` and `headless.stream`, an adapter in `src/core/adapters/` (check the CLI's `--help` and note the version), fixtures in `test/fixtures/<agent>/`, and cases in `test/adapters.test.js`.
- Agents never start other agents from their output. Delegation comes from the planner (validated JSON) or the user (`/delegate`, `/council`, `@agent`).
- `src/core/**` must not import from `src/tui/**` or write to stdout/stderr; front ends render the events.
- New slash command: add it to `registerBuiltinCommands` in `src/tui/commands.js` (`name`, `args`, `description`, `run`, optional `complete`).
- Interactive things (wizards, native agents, tmux) must run inside `app.suspend(fn)`.
- Test the interface manually in tmux. See `docs/interface.md#testing`.
