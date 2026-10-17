import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable on PATH (or check an explicit path). */
export function which(cmd, PATH = process.env.PATH || '') {
  if (!cmd) return null;
  if (cmd.includes('/')) return isExecutable(cmd) ? path.resolve(cmd) : null;
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** POSIX shell quoting. */
export function shq(s) {
  const str = String(s);
  if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a program attached to this terminal and resolve with its exit code.
 * Ctrl-C goes straight to the child (same process group), so we ignore it here.
 */
export function runInteractive(command, args, { env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, cwd });
    const ignore = () => {};
    const forward = (sig) => () => {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const handlers = { SIGINT: ignore, SIGQUIT: ignore, SIGTERM: forward('SIGTERM'), SIGHUP: forward('SIGHUP') };
    for (const [sig, h] of Object.entries(handlers)) process.on(sig, h);
    const cleanup = () => {
      for (const [sig, h] of Object.entries(handlers)) process.off(sig, h);
    };
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      if (code !== null) resolve(code);
      else resolve(128 + (os.constants.signals[signal] || 0));
    });
  });
}

export function capture(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** "git version 2.43.0" -> [2, 43, 0]; null if git is missing. */
export function gitVersion(PATH) {
  const git = which('git', PATH);
  if (!git) return null;
  const r = capture(git, ['--version']);
  const m = r.stdout.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

export function versionAtLeast(v, min) {
  for (let i = 0; i < min.length; i++) {
    if ((v[i] || 0) > min[i]) return true;
    if ((v[i] || 0) < min[i]) return false;
  }
  return true;
}

export function dirHasEntries(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
