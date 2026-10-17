# The cosmo interface

Run `cosmo` in any terminal. The transcript scrolls like normal terminal output, and only the input box at the bottom is redrawn, so scrollback, copy and search keep working.

## Input

| Prefix | Meaning | Example |
|---|---|---|
| *(none)* | message to the current channel | `explain src/env.js` |
| `/` | slash command (menu appears, Tab completes) | `/zip all` |
| `#` | switch channel, optionally send right away | `#private/agy`, `#work/codex fix the tests` |
| `@` | ask another agent of this profile once | `@copilot review my last commit` |
| `!` | shell command with the profile identity | `!gh pr list` |

## Keys

| Key | Action |
|---|---|
| Enter | send / pick menu item |
| Tab | complete from menu |
| ↑ ↓ | move in menu, else history |
| Shift+Tab | toggle ask ↔ auto mode |
| Ctrl+O | next installed agent in this profile |
| Esc | interrupt the running agent (twice: force-stop) · close menu · clear input |
| Alt+Enter, Ctrl+J, `\` + Enter | new line (pasted multi-line text also works) |
| Ctrl+A / Ctrl+E | start / end of line |
| Ctrl+U / Ctrl+K / Ctrl+W | delete to start / to end / previous word |
| Ctrl+L | clear screen (scrollback stays) |
| Ctrl+Z | put cosmo in the background; `fg` brings it back |
| `?` (empty input) | shortcuts |
| Ctrl+C | interrupt · clear input · press twice to exit |

## Channels

A channel is `profile/agent`. Each one has its own conversation: the interface passes the agent's resume/continue flag, so follow-up questions keep context. `/new` starts fresh.

When the interface starts, and after every `/cd`, the profile whose `workdir` contains the folder is picked automatically. If you switch to a channel that doesn't own the current folder, you get a warning, because commits would go out under that profile's identity.

## Modes

- **ask** (default): read files, search the web, answer. No edits.
- **auto**: the agent may edit files in the current folder (flags per agent: [agents.md](agents.md#ask-vs-auto-mode)).
- **/native**: the agent's complete interface with its own permission prompts. Exit it to come back.

## Artifacts

`/artifact <what>` asks the agent for complete files (one fenced block per file, labelled with the path). `/research <topic>` asks for a sourced markdown report. `/save` keeps any answer. Each artifact is a folder:

```
.cosmo/artifacts/20261017-144658-a-readme-and-ci-workflow/
├── RESPONSE.md          the full answer
├── README.md            from ```README.md
├── .github/workflows/ci.yml
└── meta.json            title, channel, prompt, files
```

`/artifacts` lists them with stable numbers. Use `/show 2`, `/open 2`, `/zip 2`, or `/zip all`. Inside a git repo `.cosmo/` gets its own `.gitignore`, so nothing is committed by accident.

## Local orchestrator (Ollama)

With [Ollama](https://ollama.com) installed, `ollama` is one more agent (`@ollama`, also `@local`): it runs on your machine, needs no account and costs nothing.

- `/router` configures the local router: a local model makes a short delegation decision for every message and hands work to the best executor (`<cosmo:subagent agent="codex" mode="auto">…</cosmo:subagent>`). Router mode and auto mode start enabled, specialists run in parallel when useful, and the executor reports progress. `/router off` sends messages directly to the active channel; `/router qwen3:8b` selects a model.
- `/delegate <task>` does that once; `/council <question>` asks several agents in parallel and merges their answers.
- The model is the best one you have installed (`ollama list`), or `COSMO_LOCAL_MODEL`. Small tool-calling models such as Qwen3 8B are enough, since the real work stays with the agents.
- The router is intentionally concise and always returns a routing decision. Subagents never get more rights than the current mode: ask mode is read-only, while auto mode permits edits. One answer starts at most 4 subagents.
- Automatic model selection prefers `qwen3.5`, `qwen3`, `ministral-3`, `gemma4`, then `qwen2.5-coder`. Set `COSMO_LOCAL_MODEL` to override it.
- When an agent hits a usage limit, the message goes to the next installed agent of the same profile and the first one pauses for 10 minutes. If all providers are limited, Cosmodrome waits for the earliest persisted cooldown and retries automatically. `/usage` shows runs, cost, cooldowns and switches.
- Every natural-language task is persisted outside the repository. `/tasks` shows unfinished work, `/resume <task-id>` continues it after a restart, and `/cancel [task-id]` stops a task. Cosmo stores task metadata and event history, never credentials.
- `/roster` shows the installed agents' roles and review ownership. `/review` runs a read-only project health review. `/loop <goal>` instructs the supervisor to plan, execute, verify, review, and continue until acceptance checks pass.

## Shared rules, skills and MCP

A project's `COSMO.md` (repo root, `/project init` creates it) is added for every agent too.

`/skills init` creates `rules.md`, a starter skill and `mcp.json` in the cosmodrome config folder; a repo can add its own in `<repo>/.cosmo/`. `/skills sync` (also done before each run) gives them to every installed agent:

| Agent | Rules and skills | MCP servers |
|---|---|---|
| claude | own section in the profile's `CLAUDE.md` | `cosmodrome-mcp.json`, passed with `--mcp-config` |
| codex | own section in `AGENTS.md` | - |
| opencode | own section in `AGENTS.md` | `opencode.json` |
| agy | skills folder | `mcp_config.json` |
| copilot | own section in `copilot-instructions.md` | `cosmodrome-mcp.json`, passed with `--additional-mcp-config` |

cosmo only edits its own marked section (`<!-- cosmodrome:start -->`) and never Claude's `.claude.json`; a config file it can't read is left alone. Rules from a repo's `.cosmo/` are instructions for your agents, so only use them in repos you trust.

## Modules

Add commands and status items with plain JavaScript files in `~/.config/cosmodrome/modules/` (`.js` or `.mjs`, ESM):

```js
export default function (cosmo) {
  cosmo.addCommand({
    name: 'standup',
    args: '[notes]',
    description: 'Draft a standup from git history',
    complete: () => [{ value: 'short', hint: 'three bullets' }],
    run: (args) => cosmo.ask(`Draft a standup from recent commits. ${args}`, { saveAs: { title: 'standup' } }),
  });
  cosmo.addStatusItem(() => `⎇ ${branch()}`);
}
```

API:

| Member | |
|---|---|
| `addCommand({ name, run(args), args?, description?, complete?() })` | new slash command (built-in names can't be replaced) |
| `addStatusItem(fn)` | text in the status line (refreshed every ~2 s) |
| `ask(prompt, { agent?, saveAs? })` | send to the current channel, optional artifact |
| `print(textOrLines)` | write to the transcript |
| `channel`, `cwd`, `theme`, `version` | current state and colors |

`/modules` shows what loaded and any errors. A complete example is in [`examples/modules/standup.mjs`](../examples/modules/standup.mjs).

## Look and accessibility

The mark is a star (cosmo) with a satellite (the agent) in orbit. While an agent works, the satellite circles the star.

| Variable | Effect |
|---|---|
| `COSMO_ASCII=1` | ASCII-only logo and spinner (also automatic when the locale isn't UTF-8 or `TERM=linux`) |
| `COSMO_REDUCED_MOTION=1` | the spinner stands still |
| `NO_COLOR=1` | no colors |
| `COSMO_NO_CLEAR=1` | start below the current output instead of on a clean window |
| `FORCE_COLOR=1` | colors even when output isn't a terminal |

## Testing

The interface is tested in tmux with fake agent scripts:

```bash
tmux new-session -d -s t -x 100 -y 40 'COSMODROME_HOME=/tmp/c node bin/cosmo.js'
tmux send-keys -t t '/help' Enter
tmux capture-pane -p -t t
```
