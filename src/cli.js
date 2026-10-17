import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths, expandHome, tildify } from './paths.js';
import {
  loadConfig, requireConfig, saveConfig, emptyConfig, validateProfileName, getProfile, assertSafeValue,
} from './config.js';
import { getAgent, agentNames, keychainAdvice } from './agents.js';
import { planProfileEnv, applyPlan, envDiff } from './env.js';
import { which, runInteractive, capture, shq, gitVersion, versionAtLeast, dirHasEntries } from './system.js';
import { readGhUser } from './github.js';
import { detectProfile } from './detect.js';
import { startFleet } from './fleet.js';
import { parseArgs, parseLaunchArgs } from './args.js';
import { c, co, log, out, info, ok, warn, fail, CosmoError, ask, confirm, isInteractive, table } from './ui.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const BIN_PATH = fileURLToPath(new URL('../bin/cosmo.js', import.meta.url));

function defaultCtx() {
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    paths: resolvePaths(process.env),
    interactive: isInteractive(),
  };
}

// ---------------------------------------------------------------- helpers

function chooseProfile(config, explicit, cwd, ctx) {
  if (explicit) {
    getProfile(config, explicit);
    return { name: explicit, reason: null };
  }
  const hit = detectProfile(config, cwd, ctx.paths.home);
  if (hit) return { name: hit.name, reason: `folder ${tildify(hit.workdir, ctx.paths.home)}` };
  if (config.defaultProfile && config.profiles[config.defaultProfile]) {
    return { name: config.defaultProfile, reason: 'default profile' };
  }
  const names = Object.keys(config.profiles);
  if (names.length === 1) return { name: names[0], reason: 'only profile' };
  if (!names.length) throw new CosmoError('No profiles yet.', { hint: 'Create one: cosmo profile add work' });
  throw new CosmoError('Which profile?', { hint: `Use: cosmo <profile> [agent]   (profiles: ${names.join(', ')})` });
}

function unknownAgent(name, config) {
  return new CosmoError(`Unknown agent "${name}".`, { hint: `Agents: ${agentNames(config).join(', ')}` });
}

function requireBin(agent, ctx) {
  const bin = which(agent.command, ctx.env.PATH);
  if (!bin) {
    throw new CosmoError(`${agent.label} (${agent.command}) is not installed or not on PATH.`, {
      exitCode: 127,
      hint: agent.install ? `Install: ${agent.install}` : undefined,
    });
  }
  return bin;
}

function profileFacts(config, name, ctx) {
  const p = config.profiles[name];
  const host = p.github?.host || 'github.com';
  const ghUser = readGhUser(path.join(ctx.paths.stationDir, name, 'gh'), host);
  const git = p.git?.email ? `${p.git.name || ''} <${p.git.email}>`.trim() : p.git?.name || null;
  return { host, ghUser, git };
}

function banner(title, config, name, ctx, cwd, reason) {
  const f = profileFacts(config, name, ctx);
  const why = reason ? c.dim(` (${reason})`) : '';
  log(`${c.magenta('🚀')} ${c.bold(title)} ${c.dim('·')} profile ${c.magenta(c.bold(name))}${why}`);
  const parts = [
    `GitHub: ${f.ghUser || c.yellow('not signed in')}`,
    `git: ${f.git || c.yellow('not set')}`,
    `dir: ${tildify(cwd, ctx.paths.home)}`,
  ];
  log(`   ${c.dim(parts.join('  ·  '))}`);
}

/** Warn before using profile A inside a folder that belongs to profile B. */
async function guardWorkdir(config, profileName, cwd, ctx, force) {
  const owner = detectProfile(config, cwd, ctx.paths.home);
  if (!owner || owner.name === profileName || force) return;
  warn(`This folder belongs to profile "${owner.name}", but you are launching "${profileName}".`);
  if (ctx.interactive && (await confirm('Continue anyway?', false))) return;
  throw new CosmoError('Stopped to keep your accounts apart.', { hint: 'Use --force if you really mean it.' });
}

function plan(config, profileName, agent, ctx) {
  const p = planProfileEnv({
    config, profileName, agent, baseEnv: ctx.env, paths: ctx.paths, ghPath: which('gh', ctx.env.PATH),
  });
  applyPlan(p);
  return p;
}

function resolveDir(dir, ctx) {
  return dir ? path.resolve(ctx.cwd, expandHome(dir, ctx.paths.home)) : ctx.cwd;
}

/** "2.1.302 (Claude Code)" -> [2, 1, 302]. Runs only `<agent> --version`. */
function agentVersion(bin, ctx) {
  const r = capture(bin, ['--version'], { env: ctx.env, timeout: 5000 });
  const m = `${r.stdout} ${r.stderr}`.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// ---------------------------------------------------------------- commands

async function launchCmd(args, ctx) {
  const config = requireConfig(ctx.paths);
  const opts = parseLaunchArgs(args, config);
  const cwd = resolveDir(opts.cd, ctx);
  const { name, reason } = chooseProfile(config, opts.profile, cwd, ctx);
  const profile = config.profiles[name];
  const agentName = opts.agent || profile.defaultAgent || config.defaultAgent;
  if (!agentName) {
    throw new CosmoError(`Profile "${name}" has no default agent.`, {
      hint: `Name one: cosmo ${name} <agent>   (agents: ${agentNames(config).join(', ')})`,
    });
  }
  const agent = getAgent(agentName, config, ctx.platform);
  if (!agent) throw unknownAgent(agentName, config);
  await guardWorkdir(config, name, cwd, ctx, opts.force);
  const bin = requireBin(agent, ctx);
  const p = plan(config, name, agent, ctx);
  if (!opts.quiet) banner(agent.label, config, name, ctx, cwd, reason);
  const agentArgs = [...(agent.args || []), ...(profile.agents?.[agent.name]?.args || []), ...opts.rest];
  return runInteractive(bin, agentArgs, { env: p.env, cwd });
}

async function ghLogin(config, name, ctx, showNext) {
  const gh = which('gh', ctx.env.PATH);
  if (!gh) {
    throw new CosmoError('GitHub CLI (gh) is not installed.', {
      hint: 'macOS: brew install gh · Linux: https://github.com/cli/cli#installation',
    });
  }
  const host = config.profiles[name].github?.host || 'github.com';
  const p = plan(config, name, null, ctx);
  banner(`Sign in to GitHub (${host})`, config, name, ctx, ctx.cwd);
  const code = await runInteractive(gh, ['auth', 'login', '--hostname', host], { env: p.env, cwd: ctx.cwd });
  if (code === 0 && showNext) {
    const installed = agentNames(config).filter((a) => which(getAgent(a, config, ctx.platform).command, ctx.env.PATH));
    if (installed.length) {
      info('Next, sign in to your agents (each one uses its own official login):');
      for (const a of installed) log(`   cosmo login ${name} ${a}`);
    }
  }
  return code;
}

async function loginCmd(args, ctx) {
  const config = requireConfig(ctx.paths);
  const { _: pos } = parseArgs(args);
  let profileName = null;
  let target = null;
  if (pos.length >= 2) [profileName, target] = pos;
  else if (pos.length === 1) {
    if (config.profiles[pos[0]]) profileName = pos[0];
    else target = pos[0];
  }
  const { name } = chooseProfile(config, profileName, ctx.cwd, ctx);
  if (!target || target === 'gh' || target === 'github') return ghLogin(config, name, ctx, !target);
  const agent = getAgent(target, config, ctx.platform);
  if (!agent) throw unknownAgent(target, config);
  const bin = requireBin(agent, ctx);
  const p = plan(config, name, agent, ctx);
  banner(`Sign in to ${agent.label}`, config, name, ctx, ctx.cwd);
  if (agent.loginHint) info(agent.loginHint);
  return runInteractive(bin, agent.loginArgs || [], { env: p.env, cwd: ctx.cwd });
}

async function fleetCmd(args, ctx) {
  const config = requireConfig(ctx.paths);
  const { _: pos, flags } = parseArgs(args, { boolean: ['force'], alias: { C: 'cd', f: 'force' } });
  let profileName = null;
  let agents = pos;
  if (pos.length && config.profiles[pos[0]]) {
    profileName = pos[0];
    agents = pos.slice(1);
  }
  const cwd = resolveDir(flags.cd, ctx);
  const { name } = chooseProfile(config, profileName, cwd, ctx);
  const profile = config.profiles[name];
  if (!agents.length) {
    agents = profile.fleet?.length ? profile.fleet : [profile.defaultAgent || config.defaultAgent].filter(Boolean);
  }
  if (!agents.length) throw new CosmoError('Which agents?', { hint: `e.g. cosmo fleet ${name} claude copilot` });
  const resolved = agents.map((a) => {
    const agent = getAgent(a, config, ctx.platform);
    if (!agent) throw unknownAgent(a, config);
    requireBin(agent, ctx);
    return agent.name;
  });
  const tmuxBin = which('tmux', ctx.env.PATH);
  if (!tmuxBin) {
    throw new CosmoError('fleet needs tmux.', { hint: 'macOS: brew install tmux · Debian/Ubuntu: sudo apt install tmux' });
  }
  await guardWorkdir(config, name, cwd, ctx, flags.force);
  const res = startFleet({
    profile: name,
    agents: resolved,
    cwd,
    cosmoCmd: `${shq(process.execPath)} ${shq(BIN_PATH)}`,
    tmux: (a) => capture(tmuxBin, a, { env: ctx.env }),
    insideTmux: Boolean(ctx.env.TMUX),
  });
  if (res.created) ok(`Fleet ${res.name} is up: ${resolved.join(', ')}`);
  else info(`Fleet ${res.name} is already running - attaching.`);
  return runInteractive(tmuxBin, res.attachArgs, { env: ctx.env, cwd });
}

async function shellCmd(args, ctx) {
  const config = requireConfig(ctx.paths);
  const { _: pos, flags } = parseArgs(args, { boolean: ['quiet'], alias: { q: 'quiet' } });
  const { name, reason } = chooseProfile(config, pos[0], ctx.cwd, ctx);
  const p = plan(config, name, null, ctx);
  const shell = ctx.env.SHELL || '/bin/sh';
  if (!flags.quiet) {
    banner('Profile shell', config, name, ctx, ctx.cwd, reason);
    log(`   ${c.dim('type exit to leave')}`);
  }
  return runInteractive(shell, [], { env: p.env, cwd: ctx.cwd });
}

async function envCmd(args, ctx) {
  const config = requireConfig(ctx.paths);
  const { _: pos } = parseArgs(args);
  const { name } = chooseProfile(config, pos[0], ctx.cwd, ctx);
  let agent = null;
  if (pos[1]) {
    agent = getAgent(pos[1], config, ctx.platform);
    if (!agent) throw unknownAgent(pos[1], config);
  }
  const p = plan(config, name, agent, ctx);
  const { set, unset } = envDiff(ctx.env, p.env);
  for (const k of unset) out(`unset ${k}`);
  for (const [k, v] of Object.entries(set)) out(`export ${k}=${shq(v)}`);
  return 0;
}

async function statusCmd(args, ctx) {
  const config = requireConfig(ctx.paths);
  const { _: pos } = parseArgs(args);
  const names = pos.length ? pos : Object.keys(config.profiles);
  if (!names.length) {
    info('No profiles yet. Create one: cosmo profile add work');
    return 0;
  }
  const here = detectProfile(config, ctx.cwd, ctx.paths.home);
  names.forEach((name, i) => {
    const p = getProfile(config, name);
    const f = profileFacts(config, name, ctx);
    const tags = [name === config.defaultProfile && 'default', here?.name === name && 'this folder'].filter(Boolean);
    if (i) out('');
    out(`${co.magenta('◆')} ${co.bold(name)}${tags.length ? co.dim(` (${tags.join(', ')})`) : ''}${p.description ? ` - ${p.description}` : ''}`);
    const rows = [
      ['workdir', p.workdir || '-'],
      ['agent', `${p.defaultAgent || config.defaultAgent || '-'}${p.fleet?.length ? `   fleet: ${p.fleet.join(', ')}` : ''}`],
      ['git', f.git || 'not set'],
      ['GitHub', f.ghUser ? `${f.ghUser} on ${f.host}` : `not signed in -> cosmo login ${name}`],
    ];
    for (const a of agentNames(config)) {
      const agent = getAgent(a, config, ctx.platform);
      const installed = Boolean(which(agent.command, ctx.env.PATH));
      const state = dirHasEntries(path.join(ctx.paths.stationDir, name, 'agents', a));
      if (!installed && !state) continue;
      rows.push([`  ${a}`, `${installed ? 'installed' : 'not installed'} · local state: ${state ? 'yes' : 'none yet'}`]);
    }
    table(rows, '  ');
  });
  return 0;
}

async function doctorCmd(args, ctx) {
  let problems = 0;
  const check = (good, label, detail = '', critical = false) => {
    const mark = good ? co.green('✓') : critical ? co.red('✗') : co.yellow('!');
    out(`${mark} ${label}${detail ? co.dim(`  ${detail}`) : ''}`);
    if (!good && critical) problems++;
  };
  const nodeOk = versionAtLeast(process.versions.node.split('.').map(Number), [18, 17]);
  check(nodeOk, `Node.js ${process.versions.node}`, nodeOk ? '' : 'needs >= 18.17', true);
  check(['darwin', 'linux'].includes(ctx.platform), `Platform ${ctx.platform}`, '', true);
  const gv = gitVersion(ctx.env.PATH);
  const gitOk = gv && versionAtLeast(gv, [2, 32]);
  check(gitOk, gv ? `git ${gv.join('.')}` : 'git', gitOk ? '' : 'needs git >= 2.32 for per-profile identity', true);
  check(Boolean(which('gh', ctx.env.PATH)), 'GitHub CLI (gh)', which('gh', ctx.env.PATH) ? '' : 'needed for per-profile GitHub login');
  check(Boolean(which('tmux', ctx.env.PATH)), 'tmux', which('tmux', ctx.env.PATH) ? '' : 'optional, needed for `cosmo fleet`');
  const config = loadConfig(ctx.paths);
  check(Boolean(config), `Config ${tildify(ctx.paths.configFile, ctx.paths.home)}`, config ? `${Object.keys(config.profiles).length} profile(s)` : 'run cosmo init');
  out('');
  out(co.bold('Agents'));
  for (const a of agentNames(config || {})) {
    const agent = getAgent(a, config || {}, ctx.platform);
    const bin = which(agent.command, ctx.env.PATH);
    check(Boolean(bin), `${a.padEnd(9)} ${agent.label}`, bin ? tildify(bin, ctx.paths.home) : `install: ${agent.install || '-'}`);
  }
  if (ctx.platform === 'darwin') {
    const notes = [];
    for (const a of agentNames(config || {})) {
      const agent = getAgent(a, config || {}, ctx.platform);
      const bin = agent.keychain && which(agent.command, ctx.env.PATH);
      if (!bin) continue;
      const advice = keychainAdvice(agent, { platform: ctx.platform, version: agentVersion(bin, ctx) });
      if (advice) notes.push(advice);
    }
    if (notes.length) {
      out('');
      out(co.bold('macOS Keychain'));
      for (const n of notes) check(n.level === 'ok', n.text);
    }
  }
  return problems ? 1 : 0;
}

async function agentsCmd(args, ctx) {
  const config = loadConfig(ctx.paths) || emptyConfig();
  const rows = [['AGENT', 'NAME', 'VENDOR', 'INSTALLED', 'ISOLATION']];
  for (const a of agentNames(config)) {
    const agent = getAgent(a, config, ctx.platform);
    const bin = which(agent.command, ctx.env.PATH);
    rows.push([a, agent.label, agent.vendor || '-', bin ? 'yes' : 'no', Object.keys(agent.env).join(', ') || '-']);
  }
  table(rows);
  return 0;
}

// ---------------------------------------------------------------- profiles

function applyProfileFlags(profile, flags, config) {
  if (flags.description !== undefined) profile.description = flags.description;
  if (flags.gitName !== undefined || flags.gitEmail !== undefined) {
    profile.git = { ...(profile.git || {}) };
    if (flags.gitName !== undefined) profile.git.name = flags.gitName;
    if (flags.gitEmail !== undefined) profile.git.email = flags.gitEmail;
  }
  if (flags.githubHost !== undefined) profile.github = { ...(profile.github || {}), host: flags.githubHost };
  if (flags.workdir !== undefined) profile.workdir = flags.workdir || undefined;
  if (flags.agent !== undefined) {
    const agent = getAgent(flags.agent, config);
    if (!agent) throw unknownAgent(flags.agent, config);
    profile.defaultAgent = agent.name;
  }
  if (flags.fleet !== undefined) {
    profile.fleet = String(flags.fleet).split(',').map((s) => s.trim()).filter(Boolean).map((a) => {
      const agent = getAgent(a, config);
      if (!agent) throw unknownAgent(a, config);
      return agent.name;
    });
  }
  assertSafeValue('git name', profile.git?.name);
  assertSafeValue('git email', profile.git?.email);
  assertSafeValue('description', profile.description);
  return profile;
}

async function profileWizard(config, ctx, presetName) {
  let name = presetName;
  if (!name) name = await ask('Profile name (e.g. work, private)');
  validateProfileName(name);
  if (config.profiles[name]) throw new CosmoError(`Profile "${name}" already exists.`);
  const globalGit = (key) => {
    const git = which('git', ctx.env.PATH);
    return git ? capture(git, ['config', '--global', key]).stdout.trim() : '';
  };
  const installed = agentNames(config).filter((a) => which(getAgent(a, config, ctx.platform).command, ctx.env.PATH));
  log(c.dim(`  Installed agents: ${installed.join(', ') || 'none yet (you can still pick one)'}`));
  const flags = {
    description: await ask('Description (optional)'),
    gitName: await ask('git name for commits', globalGit('user.name')),
    gitEmail: await ask('git email for commits', globalGit('user.email')),
    githubHost: await ask('GitHub host', 'github.com'),
    agent: await ask('Default agent', installed[0] || 'claude'),
    workdir: await ask('Work folder - auto-selects this profile there (optional)'),
  };
  return { name, flags };
}

async function profileCmd(args, ctx) {
  const [sub = 'list', ...rest] = args;
  const { _: pos, flags } = parseArgs(rest, { boolean: ['default', 'purge', 'yes'], alias: { y: 'yes' } });

  if (sub === 'list' || sub === 'ls') {
    const config = requireConfig(ctx.paths);
    const rows = [['PROFILE', 'AGENT', 'GITHUB', 'WORKDIR']];
    for (const name of Object.keys(config.profiles)) {
      const p = config.profiles[name];
      const f = profileFacts(config, name, ctx);
      rows.push([`${name}${name === config.defaultProfile ? ' *' : ''}`, p.defaultAgent || '-', f.ghUser || '-', p.workdir || '-']);
    }
    if (rows.length === 1) info('No profiles yet. Create one: cosmo profile add work');
    else table(rows);
    return 0;
  }

  const config = loadConfig(ctx.paths) || emptyConfig();

  if (sub === 'add') {
    let name = pos[0];
    let wizardFlags = {};
    const needsWizard = !name || (flags.gitEmail === undefined && flags.agent === undefined);
    if (needsWizard && ctx.interactive) ({ name, flags: wizardFlags } = await profileWizard(config, ctx, name));
    if (!name) throw new CosmoError('Profile name missing.', { hint: 'cosmo profile add work --agent claude --git-email you@company.com' });
    validateProfileName(name);
    if (config.profiles[name]) throw new CosmoError(`Profile "${name}" already exists.`, { hint: `Change it with: cosmo profile set ${name} ...` });
    const profile = applyProfileFlags({}, { ...wizardFlags, ...flags }, config);
    config.profiles[name] = profile;
    if (flags.default || !config.defaultProfile) config.defaultProfile = name;
    saveConfig(ctx.paths, config);
    fs.mkdirSync(path.join(ctx.paths.stationDir, name), { recursive: true, mode: 0o700 });
    ok(`Profile ${c.bold(name)} is ready.`);
    if (ctx.interactive && which('gh', ctx.env.PATH) && (await confirm(`Sign in to GitHub for "${name}" now?`, true))) {
      await ghLogin(config, name, ctx, true);
    } else {
      info(`Next: cosmo login ${name}   then   cosmo ${name}`);
    }
    return 0;
  }

  if (sub === 'set' || sub === 'edit') {
    const name = pos[0];
    getProfile(config, name);
    applyProfileFlags(config.profiles[name], flags, config);
    if (flags.default) config.defaultProfile = name;
    saveConfig(ctx.paths, config);
    ok(`Updated profile ${name}.`);
    return 0;
  }

  if (sub === 'default') {
    getProfile(config, pos[0]);
    config.defaultProfile = pos[0];
    saveConfig(ctx.paths, config);
    ok(`Default profile: ${pos[0]}`);
    return 0;
  }

  if (sub === 'show') {
    const { name } = chooseProfile(config, pos[0], ctx.cwd, ctx);
    out(JSON.stringify({ name, ...config.profiles[name], stationDir: path.join(ctx.paths.stationDir, name) }, null, 2));
    return 0;
  }

  if (sub === 'remove' || sub === 'rm') {
    const name = pos[0];
    getProfile(config, name);
    const dir = path.join(ctx.paths.stationDir, name);
    if (ctx.platform === 'darwin') {
      warn(`macOS: logins kept in the Keychain stay there after removing "${name}".`);
      log(c.dim(`  Sign out first if you want them gone: cosmo ${name} claude, then /logout (same for other agents).`));
    }
    if (flags.purge && !flags.yes) {
      if (!ctx.interactive) throw new CosmoError('--purge deletes all logins of this profile.', { hint: 'Add --yes to confirm.' });
      if (!(await confirm(`Delete ${tildify(dir, ctx.paths.home)} including all logins?`, false))) return 1;
    }
    delete config.profiles[name];
    if (config.defaultProfile === name) config.defaultProfile = Object.keys(config.profiles)[0] || null;
    saveConfig(ctx.paths, config);
    if (flags.purge) fs.rmSync(dir, { recursive: true, force: true });
    ok(`Removed profile ${name}${flags.purge ? ' and its logins' : ` (logins kept in ${tildify(dir, ctx.paths.home)})`}.`);
    return 0;
  }

  throw new CosmoError(`Unknown profile command "${sub}".`, { hint: 'Use: add, set, list, show, default, remove' });
}

async function initCmd(args, ctx) {
  const existing = loadConfig(ctx.paths);
  if (existing) {
    info(`Already set up: ${tildify(ctx.paths.configFile, ctx.paths.home)}`);
    log(c.dim('   cosmo status · cosmo profile add <name>'));
    return 0;
  }
  saveConfig(ctx.paths, emptyConfig());
  log(`${c.magenta('🚀')} ${c.bold('Welcome to cosmodrome')} - one launch pad, separate accounts per profile.`);
  ok(`Created ${tildify(ctx.paths.configFile, ctx.paths.home)}`);
  if (!ctx.interactive) {
    info('Next: cosmo profile add work --agent claude --git-email you@company.com');
    return 0;
  }
  for (let first = true; ; first = false) {
    const name = await ask(first ? 'First profile name' : 'Another profile? (empty to finish)', first ? 'work' : '');
    if (!name) break;
    await profileCmd(['add', name], ctx);
  }
  log('');
  info('All set. Launch with: cosmo <profile> [agent]   ·   several agents: cosmo fleet <profile> claude copilot');
  return 0;
}

async function configCmd(args, ctx) {
  const [sub = 'path'] = args;
  if (sub === 'path') {
    out(ctx.paths.configFile);
    return 0;
  }
  if (sub === 'edit') {
    if (!loadConfig(ctx.paths)) saveConfig(ctx.paths, emptyConfig());
    const editor = ctx.env.VISUAL || ctx.env.EDITOR || 'vi';
    return runInteractive('/bin/sh', ['-c', `${editor} ${shq(ctx.paths.configFile)}`], { env: ctx.env, cwd: ctx.cwd });
  }
  throw new CosmoError(`Unknown config command "${sub}".`, { hint: 'Use: cosmo config path | cosmo config edit' });
}

function helpCmd() {
  out(`${co.magenta('🚀 cosmodrome')} ${co.dim(`v${VERSION}`)} - launch pad for AI coding agents

${co.bold('Interface')}
  cosmo                          open the cosmo interface (/ commands, channels, artifacts)

${co.bold('Launch directly')}
  cosmo <profile> [agent] [args] native agent, e.g. cosmo work claude --resume
  cosmo launch                   default agent of the profile for this folder
  cosmo fleet <profile> a b c    several agents side by side (tmux)
  cosmo shell <profile>          shell with that profile's GitHub + git identity

${co.bold('Set up')}
  cosmo init                     first-time setup
  cosmo profile add <name>       --agent --git-name --git-email --workdir --github-host --fleet a,b --default
  cosmo profile set <name> ...   same flags as add
  cosmo profile list|show|default|remove [--purge]
  cosmo login <profile> [agent]  sign in (no agent = GitHub via gh)

${co.bold('Check')}
  cosmo status [profile]         accounts, identity, agents per profile
  cosmo doctor                   what is installed / missing
  cosmo agents                   built-in and custom agents
  cosmo env <profile> [agent]    print exports (eval "$(cosmo env work)")
  cosmo config path|edit

Agents: ${agentNames().join(', ')}  ·  logins always happen in each official CLI.`);
  return 0;
}

async function uiCmd(args, ctx) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CosmoError('The cosmo interface needs an interactive terminal.', { hint: 'Use cosmo <profile> [agent] in scripts.' });
  }
  const { runTui } = await import('./tui/app.js');
  return runTui(ctx, cliApi);
}

/** Functions the interactive interface reuses. */
export const cliApi = {
  launchCmd, loginCmd, fleetCmd, shellCmd, statusCmd, doctorCmd, agentsCmd, profileCmd, initCmd,
  chooseProfile, plan, requireBin, profileFacts,
};

const COMMANDS = {
  ui: uiCmd,
  init: initCmd,
  profile: profileCmd,
  profiles: (a, ctx) => profileCmd(['list', ...a], ctx),
  login: loginCmd,
  launch: launchCmd,
  fleet: fleetCmd,
  shell: shellCmd,
  env: envCmd,
  status: statusCmd,
  doctor: doctorCmd,
  agents: agentsCmd,
  config: configCmd,
  help: helpCmd,
  version: () => (out(VERSION), 0),
};

export async function main(argv, ctx = defaultCtx()) {
  try {
    if (ctx.platform === 'win32') {
      throw new CosmoError('cosmodrome supports macOS and Linux.', { hint: 'On Windows, use it inside WSL.' });
    }
    const [first, ...rest] = argv;
    if (first === '-h' || first === '--help') return helpCmd();
    if (first === '-v' || first === '--version') return COMMANDS.version();
    if (!first) {
      if (process.stdin.isTTY && process.stdout.isTTY) return await uiCmd([], ctx);
      helpCmd();
      if (!loadConfig(ctx.paths)) {
        log('');
        info('Not set up yet - start with: cosmo init');
      }
      return 0;
    }
    if (first && Object.hasOwn(COMMANDS, first)) return await COMMANDS[first](rest, ctx);
    return await launchCmd(argv, ctx);
  } catch (err) {
    if (err instanceof CosmoError) {
      fail(err.message);
      if (err.hint) log(c.dim(`  ${err.hint}`));
      return err.exitCode;
    }
    if (err?.code === 'ENOENT' && err.syscall?.startsWith('spawn')) {
      fail(`Could not start ${err.path}.`);
      return 127;
    }
    throw err;
  }
}
