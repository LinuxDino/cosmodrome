import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/cosmo.js', import.meta.url));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-cli-'));
  const fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  // A fake "claude" that prints what it would see.
  fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\necho "DIR=$CLAUDE_CONFIG_DIR TOKEN=${GH_TOKEN:-none} ARGS=$*"\ngit config user.email\n', { mode: 0o755 });
  // The tests expect opencode to be missing; drop folders that have it, or the real one starts and waits.
  const hostPath = process.env.PATH.split(path.delimiter).filter((d) => d && !fs.existsSync(path.join(d, 'opencode')));
  const env = {
    PATH: [fakeBin, ...hostPath].join(path.delimiter),
    HOME: path.join(root, 'home'),
    COSMODROME_HOME: path.join(root, 'cosmo'),
    GH_TOKEN: 'from-shell',
    NO_COLOR: '1',
  };
  fs.mkdirSync(env.HOME);
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', cwd: root });
  return { root, run };
}

test('profile add + launch uses the profile identity', () => {
  const { root, run } = setup();
  let r = run('profile', 'add', 'work', '--agent', 'claude', '--git-name', 'Dino', '--git-email', 'dino@work.example');
  assert.equal(r.status, 0, r.stderr);
  r = run('profile', 'add', 'private', '--agent', 'claude', '--git-email', 'dino@home.example');
  assert.equal(r.status, 0, r.stderr);

  r = run('work', 'claude', '--resume');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`DIR=${root}/cosmo/profiles/work/agents/claude TOKEN=none ARGS=--resume`));
  assert.match(r.stdout, /dino@work\.example/);

  r = run('private');
  assert.match(r.stdout, /profiles\/private\/agents\/claude/);
  assert.match(r.stdout, /dino@home\.example/);
});

test('status, env and errors', () => {
  const { run } = setup();
  assert.match(run().stderr, /cosmo init/);
  run('profile', 'add', 'work', '--agent', 'claude', '--git-email', 'a@b');
  assert.match(run('status').stdout, /work/);
  assert.match(run('env', 'work', 'claude').stdout, /export CLAUDE_CONFIG_DIR=/);
  const bad = run('work', 'opencode');
  assert.equal(bad.status, 127);
  assert.match(bad.stderr, /npm install -g opencode-ai/);
  assert.equal(run('profile', 'add', 'status').status, 1);
});

test('init without profiles is not "set up", and names are normalized', () => {
  const { run } = setup();
  assert.match(run('init').stderr, /Created/);
  const again = run('init').stderr;
  assert.doesNotMatch(again, /Already set up/);
  assert.match(again, /No profiles yet/);
  assert.equal(run('profile', 'add', 'Private', '--agent', 'claude', '--git-email', 'a@b').status, 0);
  assert.match(run('profile', 'list').stdout, /^private /m);
  assert.match(run('init').stderr, /Already set up/);
});

test('native launch passes the profile model to the agent', () => {
  const { root, run } = setup();
  run('profile', 'add', 'work', '--agent', 'claude', '--git-email', 'a@b');
  const cfgFile = path.join(root, 'cosmo', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.profiles.work.agents = { claude: { model: 'opus' } };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const res = run('work', 'claude', '--resume');
  assert.match(res.stdout, /ARGS=--model opus --resume/);
});
