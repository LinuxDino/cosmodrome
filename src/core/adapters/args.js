import { getAgent, buildHeadless } from '../../agents.js';

/**
 * Command-line arguments for a headless run. The flags live in the agent registry
 * (src/agents.js), so custom agents and `cosmo config` overrides keep working.
 * opts: { agentDef?, agent, prompt, mode, sessionId, continued, model, agentModel, mcpConfig }
 */
export function cliArgs(opts) {
  const def = opts.agentDef || getAgent(opts.agent);
  const args = def && buildHeadless(def, opts.prompt, {
    mode: opts.mode,
    continued: Boolean(opts.continued || opts.sessionId),
    resumeId: opts.sessionId || null,
    model: opts.model,
    agentModel: opts.agentModel,
    mcpConfig: opts.mcpConfig,
  });
  if (!args) throw new Error(`${opts.agent} has no one-shot mode configured`);
  return args;
}
