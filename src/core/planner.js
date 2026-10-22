import { DEFAULT_PRIORITY } from '../usage.js';
import { ollamaChat } from './adapters/ollama.js';

/** Most steps one plan may have. */
export const MAX_STEPS = 4;
const MODES = ['ask', 'auto'];
const PLAN_KEYS = ['kind', 'steps', 'synthesize'];
const STEP_KEYS = ['id', 'agent', 'mode', 'prompt', 'dependsOn'];
const MAX_PROMPT = 8000;

/**
 * JSON schema of a plan, narrowed to the agents and modes that are allowed right now. Ollama
 * gets it as `format` (structured outputs), so the model can only answer with a valid shape.
 */
export function planSchema({ agents, sessionMode = 'auto' }) {
  const modes = sessionMode === 'auto' ? MODES : ['ask'];
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['direct', 'delegate'] },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_STEPS,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            agent: { type: 'string', enum: agents },
            mode: { type: 'string', enum: modes },
            prompt: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: STEP_KEYS,
        },
      },
      synthesize: {
        type: 'object',
        properties: { agent: { type: 'string', enum: agents } },
        required: ['agent'],
      },
    },
    required: ['kind', 'steps'],
  };
}

/**
 * Check a plan. Rules: known keys only; 1..MAX_STEPS steps; `direct` has exactly one step;
 * agents are available (installed, not on cooldown); a step's mode is never above the
 * session's mode; prompts are non-empty; ids are unique; dependsOn only names earlier steps
 * (which also rules out cycles). Returns { ok, plan, errors } with a normalized plan.
 */
export function validatePlan(raw, { isAvailable = () => true, sessionMode = 'auto', maxSteps = MAX_STEPS } = {}) {
  const errors = [];
  const fail = (msg) => {
    errors.push(msg);
    return { ok: false, plan: null, errors };
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('plan must be an object');
  for (const k of Object.keys(raw)) if (!PLAN_KEYS.includes(k)) errors.push(`unknown key "${k}"`);
  if (!['direct', 'delegate'].includes(raw.kind)) errors.push('kind must be "direct" or "delegate"');
  if (!Array.isArray(raw.steps) || !raw.steps.length) return fail('steps must be a non-empty list');
  if (raw.steps.length > maxSteps) errors.push(`at most ${maxSteps} steps`);
  if (raw.kind === 'direct' && raw.steps.length !== 1) errors.push('a direct plan has exactly one step');

  const seen = new Set();
  const steps = [];
  raw.steps.forEach((s, i) => {
    const where = `step ${i + 1}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`${where} must be an object`);
      return;
    }
    for (const k of Object.keys(s)) if (!STEP_KEYS.includes(k)) errors.push(`${where}: unknown key "${k}"`);
    const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : null;
    if (!id) errors.push(`${where}: id must be a non-empty string`);
    else if (seen.has(id)) errors.push(`${where}: duplicate id "${id}"`);
    const agent = typeof s.agent === 'string' ? s.agent.trim().toLowerCase() : '';
    if (!agent) errors.push(`${where}: agent is missing`);
    else if (!isAvailable(agent)) errors.push(`${where}: agent "${agent}" is not available`);
    const mode = s.mode === undefined ? 'ask' : s.mode;
    if (!MODES.includes(mode)) errors.push(`${where}: mode must be ask or auto`);
    else if (mode === 'auto' && sessionMode !== 'auto') errors.push(`${where}: mode auto is above the session mode (${sessionMode})`);
    const prompt = typeof s.prompt === 'string' ? s.prompt.trim() : '';
    if (!prompt) errors.push(`${where}: prompt is empty`);
    else if (prompt.length > MAX_PROMPT) errors.push(`${where}: prompt is too long`);
    const deps = s.dependsOn === undefined ? [] : s.dependsOn;
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) errors.push(`${where}: dependsOn must be a list of step ids`);
    else for (const d of deps) if (!seen.has(d)) errors.push(`${where}: dependsOn "${d}" is not an earlier step`);
    if (id) seen.add(id);
    steps.push({ id, agent, mode, prompt, dependsOn: Array.isArray(deps) ? [...new Set(deps)] : [] });
  });

  let synthesize = null;
  if (raw.synthesize !== undefined && raw.synthesize !== null) {
    const a = raw.synthesize?.agent;
    if (typeof raw.synthesize !== 'object' || Object.keys(raw.synthesize).some((k) => k !== 'agent')) errors.push('synthesize must be { "agent": name }');
    else if (typeof a !== 'string' || !isAvailable(a.toLowerCase())) errors.push(`synthesize: agent "${a}" is not available`);
    else synthesize = { agent: a.toLowerCase() };
  }
  if (errors.length) return { ok: false, plan: null, errors };
  const kind = raw.kind;
  return { ok: true, errors, plan: { kind, steps, ...(kind === 'delegate' && synthesize ? { synthesize } : {}) } };
}

/** Parse model output that should be JSON (tolerates a ```json fence around it). */
export function parsePlanJson(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  return JSON.parse(body);
}

export function plannerPrompt(prompt, { agents, roles = {}, throttled = [], sessionMode }) {
  const lines = agents.map((a) => `- ${a}: ${roles[a] || 'coding agent'}`);
  return [
    'You are the task router of cosmodrome. Decide who does the task. Answer with JSON only.',
    'Use {"kind":"direct","steps":[one step]} when one agent can do it (most tasks).',
    `Use {"kind":"delegate","steps":[2-${MAX_STEPS} steps],"synthesize":{"agent":name}} only for clearly separate parts.`,
    'Each step: {"id":"s1","agent":name,"mode":"ask"|"auto","prompt":"...","dependsOn":[]}. dependsOn lists earlier step ids whose results the step needs.',
    sessionMode === 'auto'
      ? 'mode "auto" lets the agent edit files and run commands; use it for implementation, fixes and tests. Use "ask" for research and advice.'
      : 'Only mode "ask" is allowed (read and answer, no edits).',
    'Write each step prompt as a complete instruction; the agent sees nothing else.',
    'Agents:',
    ...lines,
    ...(throttled.length ? [`On cooldown (avoid): ${throttled.join(', ')}`] : []),
    '',
    `Task: ${prompt}`,
  ].join('\n');
}

/** Ask a local Ollama model for a plan, with structured outputs (`format` = plan schema). */
export async function planWithOllama(prompt, { agents, sessionMode, roles, throttled, model, env, fetchFn, signal }) {
  const body = await ollamaChat({
    env,
    model,
    fetchFn,
    signal,
    format: planSchema({ agents, sessionMode }),
    messages: [{ role: 'user', content: plannerPrompt(prompt, { agents, roles, throttled, sessionMode }) }],
  });
  return parsePlanJson(body.message?.content);
}

/**
 * Keyword router: the fallback when there is no planner or its plan is invalid.
 * `rules` (config.routing) come first: [{ "match": "regex", "agent": "copilot" }].
 * The result still goes through usage.pickAgent, so an agent on cooldown is skipped.
 */
export function routePromptToAgent(prompt, installedAgents = [], currentProfile = 'default', usage = null, rules = []) {
  const q = String(prompt).toLowerCase();
  let preferred = null;
  for (const r of Array.isArray(rules) ? rules : []) {
    let re;
    try {
      re = new RegExp(r.match, 'i');
    } catch {
      continue;
    }
    if (r.agent && installedAgents.includes(r.agent) && re.test(q)) {
      preferred = r.agent;
      break;
    }
  }
  if (!preferred) {
    if (/\b(web|search|latest|news|docs|research|google|url|http)\b/.test(q) && installedAgents.includes('agy')) preferred = 'agy';
    else if (/\b(test|fix test|benchmark|algorithm|sandbox|exec)\b/.test(q) && installedAgents.includes('codex')) preferred = 'codex';
    else if (/\b(pr|pull request|issue|gh|github|actions|workflow)\b/.test(q) && installedAgents.includes('copilot')) preferred = 'copilot';
    else if (/\b(quick|short|summarize|commit message|tldr|explain briefly)\b/.test(q) && installedAgents.includes('ollama')) preferred = 'ollama';
    else if (installedAgents.includes('claude')) preferred = 'claude';
    else preferred = installedAgents[0] || 'claude';
  }
  if (usage) {
    return usage.pickAgent({
      profile: currentProfile,
      preferred,
      candidates: DEFAULT_PRIORITY,
      isInstalled: (a) => installedAgents.includes(a),
    });
  }
  return { agent: preferred, switched: false, from: null };
}

/** A plan with one direct step, from the keyword router. */
export function routerPlan(prompt, { installed, profile, usage, rules, sessionMode }) {
  const routed = routePromptToAgent(prompt, installed, profile, usage, rules);
  return { kind: 'direct', steps: [{ id: 's1', agent: routed.agent, mode: sessionMode, prompt, dependsOn: [] }] };
}

/** Which planner to use: config.planner (ollama | claude | off), default ollama when installed. */
export function plannerChoice(config = {}, installed = []) {
  const p = config.planner;
  if (p === 'off' || p === 'claude' || p === 'ollama') return p === 'off' || installed.includes(p) ? p : 'off';
  return installed.includes('ollama') ? 'ollama' : 'off';
}
