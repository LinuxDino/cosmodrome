import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, parseLaunchArgs } from '../src/args.js';
import { planProfileEnv, renderGitConfig, expandValue } from '../src/env.js';
import { getAgent } from '../src/agents.js';
import { detectProfile } from '../src/detect.js';
import { startFleet } from '../src/fleet.js';
import { readGhUser } from '../src/github.js';
import { shq } from '../src/system.js';

const config = {
  profiles: {
    work: { defaultAgent: 'copilot', git: { name: 'Dino', email: 'dino@work.example' }, workdir: '~/work' },
    private: { defaultAgent: 'claude', git: { email: 'dino@home.example' }, github: { host: 'ghe.example' } },
  },
  agents: {},
};
const paths = { home: '/home/u', xdgConfigHome: '/home/u/.config', stationDir: '/data/profiles' };

test('parseArgs handles flags, booleans and passthrough', () => {
  const r = parseArgs(['add', 'work', '--git-email=a@b', '--agent', 'claude', '--default', '--', 'x'], { boolean: ['default'] });
  assert.deepEqual(r._, ['add', 'work']);
  assert.equal(r.flags.gitEmail, 'a@b');
  assert.equal(r.flags.agent, 'claude');
  assert.equal(r.flags.default, true);
  assert.deepEqual(r.rest, ['x']);
});

test('parseLaunchArgs passes everything after the agent through', () => {
  const r = parseLaunchArgs(['--force', 'work', 'claude', '--resume', '-p', 'hi'], config);
  assert.equal(r.profile, 'work');
  assert.equal(r.agent, 'claude');
  assert.equal(r.force, true);
  assert.deepEqual(r.rest, ['--resume', '-p', 'hi']);
  assert.equal(parseLaunchArgs(['antigravity'], config).agent, 'agy');
  assert.throws(() => parseLaunchArgs(['nope'], config), /neither a command, a profile nor an agent/);
  assert.throws(() => parseLaunchArgs(['stauts'], config), (e) => /Did you mean `cosmo status`/.test(e.hint));
});

test('planProfileEnv isolates logins and scrubs tokens', () => {
  const baseEnv = { PATH: '/bin', HOME: '/home/u', GH_TOKEN: 'leak', ANTHROPIC_API_KEY: 'leak', KEEP: '1' };
  const p = planProfileEnv({ config, profileName: 'work', agent: getAgent('claude', config, 'linux'), baseEnv, paths });
  assert.equal(p.env.GH_TOKEN, undefined);
  assert.equal(p.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(p.env.KEEP, '1');
  assert.equal(p.env.CLAUDE_CONFIG_DIR, '/data/profiles/work/agents/claude');
  assert.equal(p.env.GH_CONFIG_DIR, '/data/profiles/work/gh');
  assert.equal(p.env.GIT_CONFIG_GLOBAL, '/data/profiles/work/gitconfig');
  assert.equal(p.env.COSMODROME_PROFILE, 'work');
  assert.equal(p.env.GH_HOST, undefined);
});

test('agy gets a private HOME and no D-Bus on Linux only', () => {
  const baseEnv = { HOME: '/home/u', DBUS_SESSION_BUS_ADDRESS: 'unix:x' };
  const linux = planProfileEnv({ config, profileName: 'private', agent: getAgent('agy', config, 'linux'), baseEnv, paths });
  assert.equal(linux.env.HOME, '/data/profiles/private/agents/agy/home');
  assert.equal(linux.env.DBUS_SESSION_BUS_ADDRESS, undefined);
  assert.ok(linux.dirs.includes('/data/profiles/private/agents/agy/home'));
  assert.equal(linux.env.GH_HOST, 'ghe.example');
  const mac = planProfileEnv({ config, profileName: 'private', agent: getAgent('agy', config, 'darwin'), baseEnv, paths });
  assert.equal(mac.env.DBUS_SESSION_BUS_ADDRESS, 'unix:x');
});

test('passthroughEnv and ${VAR} expansion', () => {
  const work = { ...config.profiles.work, passthroughEnv: ['OPENAI_API_KEY'], env: { ANTHROPIC_API_KEY: '${WORK_KEY}' } };
  const cfg = { ...config, profiles: { ...config.profiles, work } };
  const p = planProfileEnv({ config: cfg, profileName: 'work', baseEnv: { OPENAI_API_KEY: 'o', WORK_KEY: 'w' }, paths });
  assert.equal(p.env.OPENAI_API_KEY, 'o');
  assert.equal(p.env.ANTHROPIC_API_KEY, 'w');
  assert.equal(expandValue('~/x', {}, '/h'), '/h/x');
});

test('git config sets identity and gh credential helper', () => {
  const g = renderGitConfig({ includes: ['/h/.gitconfig'], name: 'Di "no"', email: 'd@e', ghPath: '/usr/bin/gh' });
  assert.match(g, /\[include\]\n\tpath = "\/h\/.gitconfig"/);
  assert.match(g, /name = "Di \\"no\\""/);
  assert.match(g, /\[credential "https:\/\/github.com"\]\n\thelper = \n\thelper = "!\/usr\/bin\/gh auth git-credential"/);
});

test('detectProfile picks the folder owner', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-'));
  fs.mkdirSync(path.join(home, 'work', 'repo'), { recursive: true });
  assert.equal(detectProfile(config, path.join(home, 'work', 'repo'), home).name, 'work');
  assert.equal(detectProfile(config, home, home), null);
});

test('readGhUser parses hosts.yml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-'));
  fs.writeFileSync(
    path.join(dir, 'hosts.yml'),
    'github.com:\n    users:\n        dino-ce:\n            oauth_token: x\n    git_protocol: https\n    user: dino-ce\n',
  );
  assert.equal(readGhUser(dir, 'github.com'), 'dino-ce');
  assert.equal(readGhUser(dir, 'other.host'), null);
});

test('startFleet builds a tiled tmux session', () => {
  const calls = [];
  let n = 0;
  const tmux = (args) => {
    calls.push(args);
    if (args[0] === 'has-session') return { status: 1, stdout: '' };
    if (args[0] === 'new-session' || args[0] === 'split-window') return { status: 0, stdout: `%${n++}\n` };
    return { status: 0, stdout: '' };
  };
  const r = startFleet({ profile: 'work', agents: ['claude', 'copilot'], cwd: '/w', cosmoCmd: 'cosmo', tmux });
  assert.equal(r.name, 'cosmo-work');
  assert.deepEqual(r.attachArgs, ['attach-session', '-t', '=cosmo-work']);
  assert.ok(calls.some((c) => c[0] === 'split-window' && c.at(-1).includes('launch --force work copilot')));
  assert.ok(calls.some((c) => c[0] === 'select-pane' && c.includes('-T') && c.includes('claude')));
});

test('shq quotes safely', () => {
  assert.equal(shq('/usr/bin/gh'), '/usr/bin/gh');
  assert.equal(shq("it's"), `'it'\\''s'`);
});

test('did-you-mean and failure hints', async () => {
  const { closest, failureHint } = await import('../src/ui.js');
  assert.equal(closest('stauts', ['status', 'shell']), 'status');
  assert.equal(closest('xyz', ['status']), null);
  const h = (output, code = 1) => failureHint({ agent: 'claude', label: 'Claude Code', code, output });
  assert.match(h('Invalid API key · Please run /login'), /\/login claude/);
  assert.match(h('error: unknown option --foo'), /arguments/);
  assert.match(h('429 rate limit reached'), /usage limit/);
  assert.match(h('', 127), /could not be started/);
  assert.match(h('segfault'), /\/native/);
});

test('macOS Keychain advice depends on platform and agent version', async () => {
  const { getAgent, keychainAdvice } = await import('../src/agents.js');
  const claude = getAgent('claude');
  assert.equal(keychainAdvice(claude, { platform: 'linux', version: [2, 0, 0] }), null);
  assert.equal(keychainAdvice(claude, { platform: 'darwin', version: [2, 1, 302] }).level, 'ok');
  assert.equal(keychainAdvice(claude, { platform: 'darwin', version: [2, 1, 120] }).level, 'warn');
  assert.equal(keychainAdvice(claude, { platform: 'darwin', version: null }).level, 'warn');
  assert.equal(keychainAdvice(getAgent('agy'), { platform: 'darwin' }).level, 'warn');
  assert.equal(keychainAdvice(getAgent('codex'), { platform: 'darwin' }), null);
});
