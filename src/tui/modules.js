import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * User modules live in <config dir>/modules/*.js|*.mjs (e.g. ~/.config/cosmodrome/modules).
 * Each one default-exports a function that receives the module API:
 *
 *   export default function (cosmo) {
 *     cosmo.addCommand({ name: 'standup', description: 'Draft my standup', run: (args) => cosmo.ask('...') });
 *     cosmo.addStatusItem(() => 'custom status');
 *   }
 */
export function moduleDir(paths) {
  return path.join(paths.configDir, 'modules');
}

export async function loadModules(app) {
  const dir = moduleDir(app.ctx.paths);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.(m?js)$/.test(f)).sort();
  } catch {
    return { loaded: [], errors: [] };
  }
  const loaded = [];
  const errors = [];
  for (const file of files) {
    const name = file.replace(/\.(m?js)$/, '');
    try {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      const register = mod.default;
      if (typeof register !== 'function') throw new Error('default export must be a function');
      const added = [];
      await register(app.moduleApi(name, added));
      loaded.push({ name, file, commands: added });
    } catch (err) {
      errors.push({ name, file, message: err.message });
    }
  }
  return { loaded, errors };
}
