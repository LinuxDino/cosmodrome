import { loadRules, loadSkills, loadMcpServers } from './skills.js';
import { agentProfile, REVIEW_GATES } from './governance.js';

export const AGENT_ROLES = {
  claude: 'Deep codebase reasoning, multi-file refactoring, architecture & web search',
  codex: 'Fast sandboxed code execution, algorithmic logic & test fixing',
  agy: 'Google Antigravity CLI — web research, broad repo analysis & planning',
  copilot: 'GitHub workflows, PR review, CLI & repository Q&A',
  opencode: 'Multi-provider coding agent for planning and edits',
  ollama: 'Fast local MacBook AI — zero cloud cost, routing, quick answers & synthesis',
};

/**
 * Build the Cosmodrome Cooperation Briefing so an AI agent knows it is running inside
 * Cosmodrome, what sibling agents/skills/MCP tools exist, and how to use links and delegation.
 */
export function buildCosmoContext({
  profile = 'default',
  agent = 'ollama',
  cwd = process.cwd(),
  mode = 'ask',
  installedAgents = [],
  throttledAgents = [],
  paths = null,
  allowSubagents = true,
} = {}) {
  const peers = installedAgents
    .filter((a) => a !== agent)
    .map((a) => {
      const throttled = throttledAgents.includes(a);
      const profile = agentProfile(a);
      return `- @${a}: ${AGENT_ROLES[a] || 'Coding agent'} · ${profile.title} · ${profile.strengths}${throttled ? ' (currently on usage cooldown — avoid if possible)' : ' (ready)'}`;
    });

  const rules = paths ? loadRules(paths, cwd) : [];
  const skills = paths ? loadSkills(paths, cwd) : [];
  const mcp = paths ? Object.keys(loadMcpServers(paths, cwd).mcpServers) : [];

  const lines = [
    '[COSMODROME COOPERATION CONTEXT]',
    `You are running inside Cosmodrome (channel #${profile}/${agent}, mode: ${mode}, workdir: ${cwd}).`,
    'Terminal UI formatting rules:',
    '- Format local files as clickable links: [filename](file://' + cwd + '/path/to/file#L10).',
    '- To show live step progress in the Cosmodrome UI, you may emit: <cosmo:tool name="StepName" detail="short description" />',
  ];

  if (allowSubagents && peers.length) {
    lines.push(
      'Available sibling agents in this profile:',
      ...peers,
      'Subagent delegation:',
      '- If a task needs deep repo inspection, web search, or multi-agent verification, spawn subagents by emitting one or more tags:',
      '  <cosmo:subagent agent="claude" mode="ask">Specific task for the subagent</cosmo:subagent>',
      '- Cosmodrome will run those subagents in parallel (auto-switching providers if one hits a usage limit) and return their results to you.',
    );
  }
  lines.push(
    'Project governance:',
    '- Work in a loop: plan, execute, verify, review, then continue until acceptance checks pass.',
    '- Do not claim completion from text alone; report changed files, checks, risks and remaining work.',
    `- Review gates: ${REVIEW_GATES.map((gate) => `${gate.label} (@${gate.owner})`).join('; ')}.`,
  );

  if (skills.length) {
    lines.push(
      'Before answering, editing files, or using tools, inspect and follow the applicable Active Cosmodrome skills below. Treat them as mandatory operating instructions.',
      'Active Cosmodrome skills:',
      ...skills.map((s) => `- ${s.name}: ${s.description}`),
    );
  }
  if (mcp.length) {
    lines.push(`Configured MCP servers: ${mcp.join(', ')}`);
  }
  if (rules.length) {
    lines.push('Shared rules:', ...rules.map((r) => r.content));
  }
  lines.push('[/COSMODROME COOPERATION CONTEXT]');
  return lines.join('\n');
}

/**
 * Wrap a user prompt with the Cosmodrome Cooperation Briefing when appropriate.
 */
export function enrichPrompt(prompt, ctxOpts = {}) {
  const ctx = buildCosmoContext(ctxOpts);
  return `${ctx}\n\nUser request:\n${prompt}`;
}
