import { CosmoError, closest } from './ui.js';
import { canonicalAgentName } from './agents.js';

const COMMAND_NAMES = ['init', 'profile', 'login', 'launch', 'fleet', 'shell', 'env', 'status', 'doctor', 'agents', 'config', 'help', 'version'];

const camel = (s) => s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

/** Small argv parser: positionals in `_`, --flag value / --flag=value / -x, and `--` passthrough in `rest`. */
export function parseArgs(args, { boolean = [], alias = {} } = {}) {
  const result = { _: [], flags: {}, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      result.rest = args.slice(i + 1);
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      let key;
      let val;
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
        val = eq >= 0 ? a.slice(eq + 1) : undefined;
      } else {
        key = a.slice(1);
      }
      key = alias[key] || key;
      if (boolean.includes(key)) {
        result.flags[camel(key)] = val === undefined ? true : val !== 'false';
        continue;
      }
      if (val === undefined) {
        val = args[++i];
        if (val === undefined) throw new CosmoError(`Option --${key} needs a value.`);
      }
      result.flags[camel(key)] = val;
    } else {
      result._.push(a);
    }
  }
  return result;
}

/**
 * Launch arguments: [options] [profile] [agent] [agent args...]
 * Everything after the agent name (or after `--`) goes to the agent untouched,
 * so `cosmo work claude --resume` passes --resume to Claude Code.
 */
export function parseLaunchArgs(args, config) {
  const opts = { force: false, quiet: false, cd: null, profile: null, agent: null, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      opts.rest = args.slice(i + 1);
      return opts;
    }
    if (opts.agent) {
      opts.rest = args.slice(i);
      return opts;
    }
    if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--cd' || a === '-C') {
      opts.cd = args[++i];
      if (!opts.cd) throw new CosmoError(`${a} needs a folder.`);
    } else if (a.startsWith('--cd=')) opts.cd = a.slice(5);
    else if (a.startsWith('-')) {
      throw new CosmoError(`Unknown option ${a}.`, {
        hint: 'Options for the agent go after the agent name, e.g. cosmo work claude --resume',
      });
    } else if (!opts.profile && config.profiles[a]) opts.profile = a;
    else if (canonicalAgentName(a, config)) opts.agent = canonicalAgentName(a, config);
    else {
      const guess = closest(a, [...Object.keys(config.profiles), ...COMMAND_NAMES]);
      throw new CosmoError(`"${a}" is neither a command, a profile nor an agent.`, {
        hint: guess
          ? `Did you mean \`cosmo ${guess}\`?`
          : `Profiles: ${Object.keys(config.profiles).join(', ') || 'none'} · run \`cosmo help\` for commands`,
      });
    }
  }
  return opts;
}
