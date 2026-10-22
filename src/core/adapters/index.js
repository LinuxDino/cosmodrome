import { claude } from './claude.js';
import { codex } from './codex.js';
import { copilot } from './copilot.js';
import { opencode } from './opencode.js';
import { agy } from './agy.js';
import { ollama } from './ollama.js';
import { text } from './text.js';
import { createMockAdapter } from './mock.js';

const ADAPTERS = { claude, codex, copilot, opencode, agy, ollama, text };
const mock = createMockAdapter((name) => ADAPTERS[name]);
ADAPTERS.mock = mock;

/** Output format in the agent registry (headless.stream) -> adapter. */
const BY_STREAM = {
  'claude-json': claude,
  'codex-json': codex,
  'copilot-json': copilot,
  'opencode-json': opencode,
  'agy-json': agy,
  'ollama-http': ollama,
  mock,
  text,
};

export function adapterNames() {
  return Object.keys(ADAPTERS);
}

/**
 * The adapter for an agent name or an agent definition from src/agents.js. A definition is
 * matched by its headless.stream format, so custom agents get the text adapter.
 * COSMO_MOCK=1 (in env) replays fixtures instead of starting real agents.
 */
export function getAdapter(agent, env = process.env) {
  if (env?.COSMO_MOCK && env.COSMO_MOCK !== '0') return mock;
  if (typeof agent === 'string') return ADAPTERS[agent] || null;
  if (!agent) return null;
  const stream = agent.headless?.stream;
  if (stream && BY_STREAM[stream]) return BY_STREAM[stream];
  if (agent.headless) return text;
  return ADAPTERS[agent.name] || null;
}
