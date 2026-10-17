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
    note: 'Isolated via CLAUDE_CONFIG_DIR. On macOS credentials live in the Keychain - check /status shows the right account per profile.',
    headless: {
      stream: 'claude-json',
      build: (prompt, s) => [
        '-p', prompt,
        '--output-format', 'stream-json', '--verbose',
        '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch',
        ...(s.resumeId ? ['--resume', s.resumeId] : s.continued ? ['--continue'] : []),
        ...(s.mode === 'auto' ? ['--permission-mode', 'acceptEdits'] : []),
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
};

export const AGENT_ALIASES = {
  'claude-code': 'claude',
  cc: 'claude',
  'github-copilot': 'copilot',
  'gh-copilot': 'copilot',
  oc: 'opencode',
  antigravity: 'agy',
  google: 'agy',
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
