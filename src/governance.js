export const AGENT_PROFILES = {
  claude: {
    title: 'Lead engineer',
    strengths: 'architecture, multi-file changes, difficult debugging',
    reviews: 'design and integration review',
  },
  codex: {
    title: 'Implementation engineer',
    strengths: 'fast edits, algorithms, test repair',
    reviews: 'tests and executable correctness',
  },
  agy: {
    title: 'Research analyst',
    strengths: 'web research, broad analysis, planning',
    reviews: 'evidence and source freshness',
  },
  copilot: {
    title: 'Repository maintainer',
    strengths: 'GitHub issues, pull requests, Actions and releases',
    reviews: 'repository and CI integration',
  },
  opencode: {
    title: 'Flexible implementation engineer',
    strengths: 'multi-provider coding and edits',
    reviews: 'alternative implementation review',
  },
  ollama: {
    title: 'Supervisor',
    strengths: 'local routing, progress monitoring and synthesis',
    reviews: 'task completeness and next-step decisions',
  },
};

export const REVIEW_GATES = [
  { id: 'scope', label: 'Scope and acceptance criteria', owner: 'ollama' },
  { id: 'implementation', label: 'Implementation and architecture', owner: 'claude' },
  { id: 'tests', label: 'Tests and reproducibility', owner: 'codex' },
  { id: 'security', label: 'Security and secret handling', owner: 'claude' },
  { id: 'integration', label: 'Repository and CI integration', owner: 'copilot' },
];

export function agentProfile(agent) {
  return AGENT_PROFILES[agent] || {
    title: 'Project agent',
    strengths: 'general project work',
    reviews: 'task-specific review',
  };
}

export function buildProjectReviewPrompt(scope = 'the current project') {
  return `Act as Cosmodrome's project review board for ${scope}.

Review the project, not just one file. First inspect its instructions, structure, tests, CI, and recent changes. Then report:
1. What the project does and its current health.
2. Which agents should own which responsibilities, with reasons.
3. A review of architecture, correctness, testing, security, documentation, and delivery risks.
4. A prioritized loop of work: plan -> implement -> verify -> review -> continue.
5. Clear acceptance checks for the top three improvements.

Do not edit files during this review. Identify evidence with file paths and line numbers. Mark guesses as uncertain.`;
}

export function buildWorkLoopPrompt(goal) {
  return `Supervise this engineering loop until the goal is complete: ${goal}

Use this loop and report each transition:
1. PLAN: define the smallest useful work items and assign the best agents.
2. EXECUTE: implement one bounded item at a time; avoid conflicting edits.
3. VERIFY: run focused tests, then the project's normal checks.
4. REVIEW: inspect the diff, security implications, docs, and acceptance criteria.
5. CONTINUE: fix failures or assign the next item; stop only when the definition of done is met.

Do not claim completion from an agent response alone. Cite changed files and checks.`;
}
