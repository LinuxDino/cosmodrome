# Agents

cosmodrome drives five agents out of the box. Each one runs as its **official CLI** and signs in with its **own login flow**. cosmodrome only decides which per-profile folder each CLI uses.

> Researched October 2026. Agent CLIs change quickly. If a flag stops working, the exact arguments for each agent live in `src/agents.js`. You can override any agent in your config (see the end of this page).

## Provider rules that shaped the design

- **Anthropic (Claude):** Free/Pro/Max subscription logins are meant for Claude Code and claude.ai only. Anthropic blocked third-party tools from using them in early 2026 and wrote that into its terms. cosmodrome therefore runs the real `claude` binary and never touches its credentials. In third-party tools (e.g. OpenCode), use an Anthropic API key instead.
- **Google:** Google's terms forbid third-party tools from using the Gemini CLI login, and accounts were suspended for doing so. Since June 18, 2026, consumer accounts (Google AI Pro/Ultra, Code Assist for individuals) no longer work in Gemini CLI. Google points those users to the **Antigravity CLI (`agy`)**. Gemini CLI still works with Code Assist Standard/Enterprise or an API key.
- **GitHub Copilot:** GitHub officially supports using a paid Copilot plan inside OpenCode (since January 2026), in addition to its own Copilot CLI.

## Overview

| Channel agent | Isolation | Login | One-shot command used by the interface |
|---|---|---|---|
| `claude` – Claude Code | `CLAUDE_CONFIG_DIR` | first start or `/login` inside | `claude -p … --output-format stream-json --verbose` (+ `--resume <session>`) |
| `copilot` – GitHub Copilot CLI | `COPILOT_HOME` | `/login` inside, or the profile's gh login | `copilot -p … -s` (+ `--continue`) |
| `opencode` – OpenCode | XDG config/data/state dirs | `opencode auth login` | `opencode run …` (+ `--continue`) |
| `codex` – OpenAI Codex CLI | `CODEX_HOME` | `codex login` | `codex exec …` (+ `resume --last`) |
| `agy` – Antigravity CLI | private `HOME` | first start | `agy -p … --print-timeout 15m` (+ `--continue`) |

Sign in per profile from the interface with `/login <agent>`, or from the shell with `cosmo login <profile> <agent>`.

## Ask vs auto mode

| Agent | ask (default) | auto |
|---|---|---|
| claude | `--allowedTools Read,Grep,Glob,WebSearch,WebFetch` | + `--permission-mode acceptEdits` |
| copilot | `--allow-tool=view/glob/grep --allow-all-urls` | `--allow-all-tools` |
| opencode | `--agent plan` (read-only agent) | default build agent |
| codex | `--sandbox read-only` | `--full-auto` |
| agy | `--mode plan` | `--mode accept-edits` |

Shell commands stay blocked for Claude even in auto mode. For full control, use `/native`, which opens the agent's own interface with all of its permission prompts.

## Per agent

### Claude Code
- Install: `npm install -g @anthropic-ai/claude-code`
- The interface parses Claude's stream-json output, so you see tool calls (`⏺ WebSearch(…)`) and cost, and every channel resumes its own session id.
- macOS: credentials may live in the Keychain. Run `/status` inside `cosmo work claude` and `cosmo private claude` once to confirm each shows the right account.

### GitHub Copilot CLI
- Install: `npm install -g @github/copilot` (Node 22+) or `brew install --cask github-copilot-cli`
- Needs a paid Copilot plan. Each profile can use a different GitHub account.
- Programmatic runs only use tools you allow. That's why ask mode lists read-only tools explicitly.

### OpenCode
- Install: `npm install -g opencode-ai`
- `opencode auth login` (or `/connect` inside) → pick **GitHub Copilot** to use your Copilot plan, or add API keys for other providers.
- Tools OpenCode starts also see its per-profile XDG folders.

### OpenAI Codex CLI
- Install: `npm install -g @openai/codex` · login: `codex login` (ChatGPT account or API key).
- `--skip-git-repo-check` is passed so it also works outside repositories.

### Antigravity CLI (agy)
- Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`
- agy has no config-dir option, so cosmodrome gives it a private `HOME` per profile (it stores state in `~/.gemini/antigravity-cli/`). On Linux, `DBUS_SESSION_BUS_ADDRESS` is unset so it can't fall back to a shared keyring.
- Inside agy sessions `~/.ssh` is not visible. Use HTTPS remotes (the profile's gh credential helper handles auth).
- Older agy builds printed nothing when stdout was not a terminal. If a one-shot run shows "(no output)", run `agy update` or use `/native`.

## Custom agents and overrides

`cosmo config edit` and add to `"agents"`:

```json
{
  "agents": {
    "aider": {
      "label": "Aider",
      "command": "aider",
      "install": "pipx install aider-chat",
      "env": { "AIDER_HOME": "{agentDir}" },
      "headless": { "args": ["--message", "{prompt}"], "autoArgs": ["--yes-always"], "stream": "text" }
    },
    "claude": { "env": { "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "16000" } }
  }
}
```

Templates: `{agentDir}` (per profile + agent), `{profileDir}`, `{home}`, `{prompt}` (headless args). Overriding a built-in merges its `env`; any `headless` you set replaces the built-in one.

Per profile you can add agent args and env:

```json
"profiles": {
  "work": {
    "agents": { "claude": { "args": ["--model", "opus"] } },
    "passthroughEnv": ["OPENAI_API_KEY"],
    "env": { "ANTHROPIC_API_KEY": "${WORK_ANTHROPIC_KEY}" }
  }
}
```
