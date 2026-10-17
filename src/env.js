import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './paths.js';
import { shq } from './system.js';

/**
 * Variables removed from the parent environment before launching, so a token
 * exported in your shell can't silently override a profile's own login.
 * A profile can keep some with "passthroughEnv": ["OPENAI_API_KEY"].
 */
export const SCRUBBED_ENV = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'COPILOT_GITHUB_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'CODEX_HOME', 'GH_CONFIG_DIR', 'GH_HOST',
  'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
];

/** Expand ${VAR} from the parent environment and a leading ~. */
export function expandValue(value, baseEnv, home) {
  const s = String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => baseEnv[k] ?? '');
  return expandHome(s, home);
}

function fillTemplate(value, vars) {
  return String(value).replace(/\{(agentDir|profileDir|home)\}/g, (_, k) => vars[k]);
}

function gitQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The per-profile global git config (used through GIT_CONFIG_GLOBAL).
 * It includes your normal git config first, then sets the profile identity and
 * makes git use this profile's gh login for HTTPS.
 */
export function renderGitConfig({ includes = [], name, email, host = 'github.com', ghPath = null }) {
  const lines = [
    '# Managed by cosmodrome - rewritten on every launch, do not edit.',
    '# Put personal settings in your normal ~/.gitconfig (included below).',
  ];
  for (const inc of includes) lines.push('[include]', `\tpath = ${gitQuote(inc)}`);
  if (name || email) {
    lines.push('[user]');
    if (name) lines.push(`\tname = ${gitQuote(name)}`);
    if (email) lines.push(`\temail = ${gitQuote(email)}`);
  }
  if (ghPath) {
    const helper = `!${shq(ghPath)} auth git-credential`;
    const urls = [`https://${host}`];
    if (host === 'github.com') urls.push('https://gist.github.com');
    for (const url of urls) {
      lines.push(`[credential ${gitQuote(url)}]`, '\thelper = ', `\thelper = ${gitQuote(helper)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Pure: compute everything a launch needs (env, folders, files) without touching disk.
 * agent may be null (shell / gh login / env).
 */
export function planProfileEnv({ config, profileName, agent = null, baseEnv, paths, ghPath = null }) {
  const profile = config.profiles[profileName];
  const home = paths.home;
  const profileDir = path.join(paths.stationDir, profileName);
  const ghDir = path.join(profileDir, 'gh');
  const env = { ...baseEnv };

  const keep = new Set(profile.passthroughEnv || []);
  for (const k of SCRUBBED_ENV) if (!keep.has(k)) delete env[k];

  const dirs = [profileDir, ghDir];
  const host = profile.github?.host || 'github.com';

  env.COSMODROME_PROFILE = profileName;
  env.COSMODROME_PROFILE_DIR = profileDir;
  env.GH_CONFIG_DIR = ghDir;
  if (host !== 'github.com') env.GH_HOST = host;

  const gitconfigPath = path.join(profileDir, 'gitconfig');
  const gitconfig = renderGitConfig({
    includes: [path.join(paths.xdgConfigHome, 'git', 'config'), path.join(home, '.gitconfig')],
    name: profile.git?.name,
    email: profile.git?.email,
    host,
    ghPath,
  });
  env.GIT_CONFIG_GLOBAL = gitconfigPath;

  for (const [k, v] of Object.entries(profile.env || {})) {
    if (v === null) delete env[k];
    else env[k] = expandValue(v, baseEnv, home);
  }

  let agentDir = null;
  if (agent) {
    agentDir = path.join(profileDir, 'agents', agent.name);
    dirs.push(agentDir);
    const vars = { agentDir, profileDir, home };
    for (const [k, v] of Object.entries(agent.env || {})) {
      const value = fillTemplate(v, vars);
      env[k] = value;
      if (String(v).includes('{agentDir}')) dirs.push(value);
    }
    for (const k of agent.unset || []) delete env[k];
    for (const [k, v] of Object.entries(profile.agents?.[agent.name]?.env || {})) {
      if (v === null) delete env[k];
      else env[k] = expandValue(fillTemplate(v, vars), baseEnv, home);
    }
  }

  return {
    env,
    profileDir,
    agentDir,
    dirs: [...new Set(dirs)],
    files: [{ path: gitconfigPath, content: gitconfig, mode: 0o644 }],
  };
}

/** Create folders and write managed files for a plan. */
export function applyPlan(plan) {
  for (const dir of plan.dirs) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of plan.files) {
    let current = null;
    try {
      current = fs.readFileSync(file.path, 'utf8');
    } catch {
      /* new file */
    }
    if (current !== file.content) fs.writeFileSync(file.path, file.content, { mode: file.mode ?? 0o600 });
  }
}

export function envDiff(base, next) {
  const set = {};
  const unset = [];
  for (const [k, v] of Object.entries(next)) if (base[k] !== v) set[k] = v;
  for (const k of Object.keys(base)) if (!(k in next)) unset.push(k);
  return { set, unset };
}
