import fs from 'node:fs';
import path from 'node:path';
import { CosmoError } from './ui.js';

export const CONFIG_VERSION = 1;

/** Command names can't be profile names, so `cosmo <profile>` stays unambiguous. */
export const RESERVED_NAMES = new Set([
  'init', 'profile', 'profiles', 'login', 'launch', 'fleet', 'shell', 'env',
  'status', 'doctor', 'agents', 'config', 'help', 'version', 'ui',
]);

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function emptyConfig() {
  return { version: CONFIG_VERSION, defaultProfile: null, defaultAgent: null, profiles: {}, agents: {} };
}

/** "Private" -> "private", " My Work " -> "my-work": what people type, as a valid name. */
export function normalizeProfileName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

export function validateProfileName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new CosmoError(`Invalid profile name "${name}".`, {
      hint: 'Use lowercase letters, digits, "-" or "_" (max 32 chars), e.g. work, private.',
    });
  }
  if (RESERVED_NAMES.has(name)) {
    throw new CosmoError(`"${name}" is a cosmo command and can't be a profile name.`);
  }
}

export function normalizeConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CosmoError('Config file must contain a JSON object.');
  }
  const config = { ...emptyConfig(), ...data };
  if (config.version > CONFIG_VERSION) {
    throw new CosmoError(`Config version ${config.version} is newer than this cosmodrome understands.`, {
      hint: 'Update cosmodrome: npm install -g cosmodrome',
    });
  }
  config.profiles = config.profiles || {};
  config.agents = config.agents || {};
  for (const name of Object.keys(config.profiles)) validateProfileName(name);
  return config;
}

/** Returns the config, or null if there is none yet. */
export function loadConfig(paths) {
  let raw;
  try {
    raw = fs.readFileSync(paths.configFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new CosmoError(`Config file is not valid JSON: ${paths.configFile}`, { hint: err.message });
  }
  return normalizeConfig(data);
}

export function requireConfig(paths) {
  const config = loadConfig(paths);
  if (!config) {
    throw new CosmoError('cosmodrome is not set up yet.', { hint: 'Run `cosmo init` to create your first profile.' });
  }
  return config;
}

export function saveConfig(paths, config) {
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true, mode: 0o700 });
  const tmp = `${paths.configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, paths.configFile);
}

export function getProfile(config, name) {
  const profile = config.profiles[name];
  if (!profile) {
    const known = Object.keys(config.profiles);
    throw new CosmoError(`Unknown profile "${name}".`, {
      hint: known.length ? `Profiles: ${known.join(', ')}` : 'Create one: cosmo profile add work',
    });
  }
  return profile;
}

export function assertSafeValue(label, value) {
  if (value != null && /[\r\n]/.test(String(value))) {
    throw new CosmoError(`${label} must not contain line breaks.`);
  }
}
