import { capture, which } from './system.js';
import { MAX_STEPS } from './core/planner.js';

// Planning and running plans live in src/core (planner.js, executor.js, session.js).
export { routePromptToAgent } from './core/planner.js';
export { parseCosmoToolTag } from './core/adapters/text.js';

const PREFERRED_LOCAL_MODELS = [
  'qwen3.5',
  'qwen3',
  'ministral-3',
  'gemma4',
  'qwen2.5-coder',
  'llama3.2',
  'llama3.1',
  'deepseek-r1',
  'deepseek-coder',
  'codestral',
  'gemma3',
  'mistral',
];

/**
 * List installed local Ollama models via `ollama list` (pure CLI, zero network/token handling).
 */
export function listOllamaModels({ env = process.env, captureFn = capture } = {}) {
  const bin = which('ollama', env.PATH);
  if (!bin) return [];
  const r = captureFn(bin, ['list'], { env, timeout: 3000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * Pick the best local Ollama model from installed models or config.
 */
export function pickLocalModel(installedModels = [], config = {}, env = process.env) {
  if (env.COSMO_LOCAL_MODEL) return env.COSMO_LOCAL_MODEL;
  if (config?.localModel) return config.localModel;
  if (!installedModels.length) return 'qwen3:8b';
  for (const pref of PREFERRED_LOCAL_MODELS) {
    const hit = installedModels.find((m) => m.toLowerCase().startsWith(pref));
    if (hit) return hit;
  }
  return installedModels[0];
}

/** Most agents one plan may start. */
export const MAX_SUBAGENTS = MAX_STEPS;

/**
 * Streaming filter that hides <cosmo:subagent>…</cosmo:subagent> blocks (also across lines and
 * chunks): they are instructions for cosmo, not text for the user. Returns null for a chunk
 * that was only tags.
 */
export function createSubagentTagFilter() {
  let inside = false;
  return (chunk) => {
    const kept = [];
    for (let line of String(chunk).split('\n')) {
      let out = '';
      let hidden = false;
      while (line) {
        if (inside) {
          const end = line.search(/<\/cosmo:subagent>/i);
          hidden = true;
          if (end < 0) {
            line = '';
            break;
          }
          inside = false;
          line = line.slice(end + '</cosmo:subagent>'.length);
        } else {
          const start = line.search(/<cosmo:subagent[\s>]/i);
          if (start < 0) {
            out += line;
            break;
          }
          out += line.slice(0, start);
          inside = true;
          line = line.slice(start).replace(/^<cosmo:subagent[^>]*>/i, '');
        }
      }
      if (!(hidden && !out.trim())) kept.push(out);
    }
    return kept.length ? kept.join('\n') : null;
  };
}

export function stripCosmoTags(text) {
  return String(text)
    .replace(/<cosmo:tool\s+[^>]*?\/?>/gi, '')
    .replace(/<cosmo:subagent\s+[^>]*>[\s\S]*?<\/cosmo:subagent>/gi, '')
    .trim();
}
