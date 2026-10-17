import os from 'node:os';
import path from 'node:path';

export function expandHome(p, home = os.homedir()) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

export function tildify(p, home = os.homedir()) {
  if (typeof p !== 'string') return p;
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

/**
 * Where cosmodrome keeps things.
 *  - config file:  $XDG_CONFIG_HOME/cosmodrome/config.json   (~/.config/cosmodrome/config.json)
 *  - station dir:  $XDG_DATA_HOME/cosmodrome/profiles/<name>  (~/.local/share/cosmodrome/profiles/<name>)
 * COSMODROME_HOME puts both under one folder (handy for tests and portable setups).
 */
export function resolvePaths(env = process.env) {
  const home = env.HOME || os.homedir();
  if (env.COSMODROME_HOME) {
    const root = path.resolve(expandHome(env.COSMODROME_HOME, home));
    return {
      home,
      xdgConfigHome: env.XDG_CONFIG_HOME || path.join(home, '.config'),
      configDir: root,
      configFile: path.join(root, 'config.json'),
      stationDir: path.join(root, 'profiles'),
    };
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const dataBase = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const configDir = path.join(xdgConfigHome, 'cosmodrome');
  return {
    home,
    xdgConfigHome,
    configDir,
    configFile: path.join(configDir, 'config.json'),
    stationDir: path.join(dataBase, 'cosmodrome', 'profiles'),
  };
}

export function profileDir(paths, name) {
  return path.join(paths.stationDir, name);
}

export function agentDir(paths, profileName, agentName) {
  return path.join(paths.stationDir, profileName, 'agents', agentName);
}
