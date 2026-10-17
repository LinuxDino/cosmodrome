import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './paths.js';

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Which profile owns this folder? The profile whose "workdir" contains cwd wins;
 * nested workdirs resolve to the deepest match. Returns { name, workdir } or null.
 */
export function detectProfile(config, cwd, home) {
  const here = real(cwd);
  let best = null;
  for (const [name, profile] of Object.entries(config.profiles || {})) {
    if (!profile.workdir) continue;
    const wd = real(path.resolve(expandHome(profile.workdir, home)));
    const prefix = wd.endsWith(path.sep) ? wd : wd + path.sep;
    if (here === wd || here.startsWith(prefix)) {
      if (!best || wd.length > best.workdir.length) best = { name, workdir: wd };
    }
  }
  return best;
}
