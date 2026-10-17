import { capture, which } from './system.js';
import { AGENT_ROLES } from './context.js';
import { DEFAULT_PRIORITY } from './usage.js';

const PREFERRED_LOCAL_MODELS = [
  'qwen2.5-coder',
  'qwen3',
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
  if (!installedModels.length) return 'qwen2.5-coder';
  for (const pref of PREFERRED_LOCAL_MODELS) {
    const hit = installedModels.find((m) => m.toLowerCase().startsWith(pref));
    if (hit) return hit;
  }
  return installedModels[0];
}

/** Most subagents one answer may start; the tags can also come from text an agent merely read. */
export const MAX_SUBAGENTS = 4;

function likelyNeedsAdvisors(prompt) {
  return /\b(review|audit|research|compare|architecture|design|security|investigate|analy[sz]e|multiple|repo|codebase|workflow|integration)\b/i.test(String(prompt));
}

/**
 * Parse `<cosmo:subagent agent="claude" mode="ask">prompt</cosmo:subagent>` blocks from AI output.
 * The mode is only a request: the app never runs a subagent above the user's own mode.
 */
export function parseSubagentCalls(text, max = MAX_SUBAGENTS) {
  const calls = [];
  const re = /<cosmo:subagent\s+([^>]*)>([\s\S]*?)<\/cosmo:subagent>/gi;
  let m;
  while ((m = re.exec(String(text))) !== null && calls.length < max) {
    const attrs = m[1] || '';
    const prompt = (m[2] || '').trim();
    const agentMatch = attrs.match(/agent=["']?([a-zA-Z0-9_-]+)["']?/i);
    const modeMatch = attrs.match(/mode=["']?(ask|auto)["']?/i);
    if (prompt) {
      calls.push({
        agent: (agentMatch ? agentMatch[1] : 'claude').toLowerCase(),
        mode: modeMatch ? modeMatch[1].toLowerCase() : 'ask',
        prompt,
      });
    }
  }
  return calls;
}

/**
 * Parse `<cosmo:tool name="Read" detail="src/app.js" />` tags from AI output.
 */
export function parseCosmoToolTag(line) {
  const m = String(line).match(/<cosmo:tool\s+([^>]*?)\/?>/i);
  if (!m) return null;
  const attrs = m[1];
  const name = attrs.match(/name=["']([^"']+)["']/i)?.[1] || 'Step';
  const detail = attrs.match(/detail=["']([^"']+)["']/i)?.[1] || '';
  return { name, detail };
}

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

/**
 * Heuristic router when choosing which specialist agent best fits a prompt.
 */
export function routePromptToAgent(prompt, installedAgents = [], currentProfile = 'default', usage = null) {
  const q = String(prompt).toLowerCase();
  let preferred = 'claude';
  if (/\b(web|search|latest|news|docs|research|google|url|http)\b/.test(q) && installedAgents.includes('agy')) {
    preferred = 'agy';
  } else if (/\b(test|fix test|benchmark|algorithm|sandbox|exec)\b/.test(q) && installedAgents.includes('codex')) {
    preferred = 'codex';
  } else if (/\b(pr|pull request|issue|gh|github|actions|workflow)\b/.test(q) && installedAgents.includes('copilot')) {
    preferred = 'copilot';
  } else if (/\b(quick|short|summarize|commit message|tldr|explain briefly)\b/.test(q) && installedAgents.includes('ollama')) {
    preferred = 'ollama';
  } else if (installedAgents.includes('claude')) {
    preferred = 'claude';
  } else if (installedAgents.length) {
    preferred = installedAgents[0];
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

/**
 * Run a delegated multi-agent workflow:
 * 1. If local Ollama is installed, ask it to either answer directly or emit `<cosmo:subagent>` tasks.
 * 2. If subagents are requested (or if Ollama isn't installed, route smartly across available agents),
 *    execute subagents with live HUD tracking and automatic usage-limit failover.
 * 3. Synthesize the results into a clean final response.
 */
export async function runDelegation(prompt, app) {
  const ch = app.requireChannel();
  const { t } = app;
  const installed = DEFAULT_PRIORITY.filter((a) => app.channels.installed(a));
  const throttled = installed.filter((a) => app.usage.isThrottled(ch.profile, a));

  app.print(`${t.magenta('✦')} ${t.bold('Mission Control')} ${t.dim(`· analyzing task across ${installed.length} installed agent(s)`)}`);

  let calls = [];
  if (installed.includes('ollama') && likelyNeedsAdvisors(prompt)) {
    const specialists = installed.filter((a) => a !== 'ollama').map((a) => `@${a}`).join(', ') || 'none';
    const plannerPrompt =
      `You are Cosmodrome's fast router. Return only delegation tags or the word DIRECT. ` +
      `Do not explain, summarize, or answer the task. Emit at most 3 concise tags using available specialists: ${specialists}. ` +
      `Use mode="ask" for advisor work. Delegate only when specialist input materially improves the result.\n\n` +
      `Available agents: ${installed.join(', ')}\n` +
      `On cooldown: ${throttled.join(', ') || 'none'}\n` +
      `Task: ${prompt}`;

    const planRes = await app.sendPrompt(plannerPrompt, {
      agent: 'ollama',
      echo: false,
      quietMeta: true,
      skipSubagentSpawn: true,
      enrich: false,
      suppressOutput: true,
    });
    calls = parseSubagentCalls(planRes.text);
  }

  if (!calls.length) {
    const routed = routePromptToAgent(prompt, installed, ch.profile, app.usage);
    calls = [{ agent: routed.agent, mode: app.state.mode, prompt }];
  }

  const finalizer = installed.includes('claude') ? 'claude' : installed.includes('ollama') ? 'ollama' : null;
  return app.executeSubagents(calls, { parentPrompt: prompt, synthesizeWith: finalizer });
}

/**
 * Run multiple agents in parallel ("Council") in read-only ask mode and compare/synthesize their findings.
 */
export async function runCouncil(prompt, requestedAgents, app) {
  const ch = app.requireChannel();
  const { t } = app;
  const installed = DEFAULT_PRIORITY.filter((a) => app.channels.installed(a));
  const targets = (requestedAgents?.length ? requestedAgents : installed.filter((a) => a !== 'ollama').slice(0, 3)).filter((a) =>
    app.channels.installed(a),
  );
  const agents = targets.length ? targets : installed.slice(0, 2);

  app.print(`${t.magenta('✦')} ${t.bold('Agent Council')} ${t.dim(`· consulting ${agents.map((a) => '@' + a).join(', ')} in parallel`)}`);

  const calls = agents.map((agent) => ({
    agent,
    mode: 'ask',
    prompt: `${prompt}\n\n(Provide a concise, high-signal response with clickable file:// links where relevant.)`,
  }));

  return app.executeSubagents(calls, {
    parentPrompt: prompt,
    synthesizeWith: installed.includes('ollama') ? 'ollama' : agents[0],
    council: true,
  });
}
