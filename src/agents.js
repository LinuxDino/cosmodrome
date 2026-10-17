import { versionAtLeast } from './system.js';

/**
 * Built-in agent registry.
 *
 * Every agent is launched through its own official CLI. cosmodrome never reads,
 * copies or forwards login tokens - it only points each CLI at a per-profile
 * folder, so every sign-in stays inside that CLI.
 *
 * `env` values are templates: {agentDir}, {profileDir}, {home}.
 */
export const BUILTIN_AGENTS = {
  claude: {
    label: 'Claude Code',
    vendor: 'Anthropic',
    command: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    env: { CLAUDE_CONFIG_DIR: '{agentDir}' },
    loginArgs: [],
    loginHint: 'Claude Code asks you to sign in on first start. If it does not, type /login.',
    note: 'Isolated via CLAUDE_CONFIG_DIR. On macOS the login is in the Keychain: recent versions keep one entry per config folder.',
    // macOS: Claude Code names its Keychain entry after CLAUDE_CONFIG_DIR since about 2.1.121
    // (community reports, not official docs); older versions share one entry.
    keychain: { scope: 'per-folder', since: [2, 1, 121] },
    headless: {
      stream: 'claude-json',
      // The prompt goes last, after "--": a prompt starting with "-" would otherwise be
      // read as an option, and --allowedTools takes a variadic list.
      build: (prompt, s) => [
        '-p',
        '--output-format', 'stream-json', '--verbose',
        '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch',
        ...(s.resumeId ? ['--resume', s.resumeId] : s.continued ? ['--continue'] : []),
        ...(s.mode === 'auto' ? ['--permission-mode', 'acceptEdits'] : []),
        '--', prompt,
      ],
    },
  },
  copilot: {
    label: 'GitHub Copilot CLI',
    vendor: 'GitHub',
    command: 'copilot',
    install: 'npm install -g @github/copilot',
    env: { COPILOT_HOME: '{agentDir}' },
    loginArgs: [],
    loginHint: 'Type /login inside Copilot CLI if it does not ask you to sign in.',
    note: "Isolated via COPILOT_HOME. Copilot can also use this profile's gh login.",
    headless: {
      stream: 'text',
      build: (prompt, s) => [
        '-p', prompt, '-s', '--no-color',
        ...(s.continued ? ['--continue'] : []),
        ...(s.mode === 'auto'
          ? ['--allow-all-tools']
          : ['--allow-tool=view', '--allow-tool=glob', '--allow-tool=grep', '--allow-all-urls']),
      ],
    },
  },
  opencode: {
    label: 'OpenCode',
    vendor: 'multi-provider (Copilot, API keys, ...)',
    command: 'opencode',
    install: 'npm install -g opencode-ai',
    env: {
      XDG_CONFIG_HOME: '{agentDir}/config',
      XDG_DATA_HOME: '{agentDir}/data',
      XDG_STATE_HOME: '{agentDir}/state',
    },
    loginArgs: ['auth', 'login'],
    loginHint: 'Pick a provider (e.g. GitHub Copilot) and follow the prompts.',
    note: 'Isolated via XDG dirs. Tools started by OpenCode see the same XDG dirs.',
    headless: {
      stream: 'text',
      build: (prompt, s) => [
        'run',
        ...(s.continued ? ['--continue'] : []),
        ...(s.mode === 'auto' ? [] : ['--agent', 'plan']),
        prompt,
      ],
    },
  },
  codex: {
    label: 'OpenAI Codex CLI',
    vendor: 'OpenAI',
    command: 'codex',
    install: 'npm install -g @openai/codex',
    env: { CODEX_HOME: '{agentDir}' },
    loginArgs: ['login'],
    loginHint: 'Sign in with ChatGPT or an API key.',
    note: 'Isolated via CODEX_HOME.',
    headless: {
      stream: 'text',
      build: (prompt, s) => [
        'exec', '--skip-git-repo-check',
        ...(s.mode === 'auto' ? ['--full-auto'] : ['--sandbox', 'read-only']),
        ...(s.continued ? ['resume', '--last'] : []),
        prompt,
      ],
    },
  },
  agy: {
    label: 'Antigravity CLI',
    vendor: 'Google',
    command: 'agy',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    env: { HOME: '{agentDir}/home' },
    linuxUnset: ['DBUS_SESSION_BUS_ADDRESS'],
    loginArgs: [],
    loginHint: 'Follow the sign-in prompts on first start.',
    note: 'No config-dir option, so agy gets a private HOME (SSH keys in ~/.ssh are not visible). On macOS the login Keychain is shared - check the account agy shows.',
    keychain: { scope: 'shared' },
    headless: {
      stream: 'text',
      emptyHint: 'Some agy versions only print to a real terminal. Update agy (agy update) or use /native.',
      build: (prompt, s) => [
        '-p', prompt, '--print-timeout', '15m',
        ...(s.continued ? ['--continue'] : []),
        '--mode', s.mode === 'auto' ? 'accept-edits' : 'plan',
      ],
    },
  },
  ollama: {
    label: 'Ollama Local AI',
    vendor: 'Local (macOS / Linux)',
    command: 'ollama',
    install: 'brew install ollama && ollama pull qwen2.5-coder',
    env: {},
    loginArgs: ['list'],
    loginHint: 'Ollama runs locally without an account. Pull a model with: ollama pull qwen2.5-coder',
    note: 'Runs locally on your machine with zero cloud tokens. Shares local model weights across profiles.',
    headless: {
      stream: 'text',
      emptyHint: 'Make sure Ollama is running (`ollama serve`) and a model is pulled (`ollama pull qwen2.5-coder`).',
      build: (prompt, s) => [
        'run',
        s.model || process.env.COSMO_LOCAL_MODEL || 'qwen2.5-coder',
        prompt,
      ],
    },
  },
};

export const AGENT_ALIASES = {
  'claude-code': 'claude',
  cc: 'claude',
  'github-copilot': 'copilot',
  'gh-copilot': 'copilot',
  oc: 'opencode',
  antigravity: 'agy',
  google: 'agy',
  local: 'ollama',
  llama: 'ollama',
};

export function canonicalAgentName(name, config = {}) {
  if (!name) return null;
  if (config.agents?.[name] || BUILTIN_AGENTS[name]) return name;
  return AGENT_ALIASES[name] || null;
}

export function agentNames(config = {}) {
  return [...new Set([...Object.keys(BUILTIN_AGENTS), ...Object.keys(config.agents || {})])];
}

/**
 * Resolve an agent definition. Custom agents in config.agents can add new agents
 * or override fields of a built-in one (env is merged).
 */
export function getAgent(name, config = {}, platform = process.platform) {
  const key = canonicalAgentName(name, config);
  if (!key) return null;
  const builtin = BUILTIN_AGENTS[key] || {};
  const custom = config.agents?.[key] || {};
  const def = {
    label: key,
    vendor: '',
    args: [],
    loginArgs: [],
    unset: [],
    ...builtin,
    ...custom,
    env: { ...(builtin.env || {}), ...(custom.env || {}) },
    name: key,
    builtin: Boolean(BUILTIN_AGENTS[key]),
  };
  if (!def.command) def.command = key;
  const linuxUnset = platform === 'linux' ? def.linuxUnset || [] : [];
  def.unset = [...new Set([...(def.unset || []), ...linuxUnset])];
  return def;
}

/**
 * Arguments for a one-shot, non-interactive run (used by the cosmo interface).
 * s = { continued, resumeId, mode: 'ask' | 'auto' }
 * Custom agents can define headless as JSON:
 *   { "args": ["run", "{prompt}"], "continueArgs": ["--continue"], "askArgs": [], "autoArgs": [], "stream": "text" }
 */
export function buildHeadless(agent, prompt, s = {}) {
  const h = agent.headless;
  if (!h) return null;
  if (typeof h.build === 'function') return h.build(prompt, s);
  const fill = (arr) => (arr || []).map((a) => (a === '{prompt}' ? prompt : a));
  return [
    ...fill(h.args || ['{prompt}']),
    ...(s.continued ? fill(h.continueArgs) : []),
    ...fill(s.mode === 'auto' ? h.autoArgs : h.askArgs),
  ];
}

/**
 * What to say about the macOS login Keychain for an agent. Pure: `version` is the agent's
 * own `--version` output parsed to [major, minor, patch] (or null). Never looks at the Keychain.
 * Returns { level: 'ok' | 'warn', text } or null when there is nothing to say.
 */
export function keychainAdvice(agent, { platform, version = null }) {
  const k = agent?.keychain;
  if (platform !== 'darwin' || !k) return null;
  if (k.scope === 'shared') {
    return { level: 'warn', text: `${agent.label} keeps its login in the shared Keychain - profiles can end up on one account. Check the account it shows in each profile.` };
  }
  const since = k.since.join('.');
  if (!version) return { level: 'warn', text: `${agent.label}: version unknown. Versions before ${since} share one Keychain login across profiles.` };
  return versionAtLeast(version, k.since)
    ? { level: 'ok', text: `${agent.label} ${version.join('.')} keeps a separate Keychain login per profile.` }
    : { level: 'warn', text: `${agent.label} ${version.join('.')} shares one Keychain login across profiles. Update it (claude update) to keep work and private apart.` };
}
