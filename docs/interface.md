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
| `FORCE_COLOR=1` | colors even when output isn't a terminal |

## Testing

The interface is tested in tmux with fake agent scripts:

```bash
tmux new-session -d -s t -x 100 -y 40 'COSMODROME_HOME=/tmp/c node bin/cosmo.js'
tmux send-keys -t t '/help' Enter
tmux capture-pane -p -t t
```
