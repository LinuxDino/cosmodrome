import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse YAML-like frontmatter (name, description) from a SKILL.md file without external dependencies.
 */
export function parseSkillFile(content, fallbackName = 'skill') {
  const s = String(content);
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    const firstLine = s.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
    return { name: fallbackName, description: firstLine.trim().slice(0, 120), body: s.trim() };
  }
  const front = m[1];
  const body = m[2].trim();
  const get = (key) => {
    const hit = front.match(new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?`, 'm'));
    return hit ? hit[1].trim() : '';
  };
  return {
    name: get('name') || fallbackName,
    description: get('description') || body.split('\n')[0]?.slice(0, 120) || '',
    body,
  };
}

function findRepoRoot(cwd) {
  let cur = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Load all skills from global (~/.config/cosmodrome/skills) and workspace (<repo>/.cosmo/skills).
 */
export function loadSkills(paths, cwd) {
  const dirs = [{ scope: 'global', dir: path.join(paths.configDir, 'skills') }];
  const repo = cwd ? findRepoRoot(cwd) : null;
  if (repo) dirs.push({ scope: 'repo', dir: path.join(repo, '.cosmo', 'skills') });

  const byName = new Map();
  for (const { scope, dir } of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const skillFile = path.join(dir, ent.name, 'SKILL.md');
        const raw = readIfExists(skillFile);
        if (raw != null) {
          const parsed = parseSkillFile(raw, ent.name);
          byName.set(parsed.name, { ...parsed, scope, path: skillFile });
        }
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        const skillFile = path.join(dir, ent.name);
        const raw = readIfExists(skillFile);
        if (raw != null) {
          const parsed = parseSkillFile(raw, ent.name.replace(/\.md$/, ''));
          byName.set(parsed.name, { ...parsed, scope, path: skillFile });
        }
      }
    }
  }
  return [...byName.values()];
}

/**
 * Load shared rules from global (~/.config/cosmodrome/rules.md) and workspace (<repo>/.cosmo/rules.md).
 */
export function loadRules(paths, cwd) {
  const out = [];
  const globalRules = path.join(paths.configDir, 'rules.md');
  const g = readIfExists(globalRules);
  if (g?.trim()) out.push({ scope: 'global', path: globalRules, content: g.trim() });

  const repo = cwd ? findRepoRoot(cwd) : null;
  if (repo) {
    const repoRules = path.join(repo, '.cosmo', 'rules.md');
    const r = readIfExists(repoRules);
    if (r?.trim()) out.push({ scope: 'repo', path: repoRules, content: r.trim() });
  }
  return out;
}

/**
 * Load unified MCP server definitions from ~/.config/cosmodrome/mcp.json and <repo>/.cosmo/mcp.json.
 */
export function loadMcpServers(paths, cwd) {
  const servers = {};
  const files = [path.join(paths.configDir, 'mcp.json')];
  const repo = cwd ? findRepoRoot(cwd) : null;
  if (repo) files.push(path.join(repo, '.cosmo', 'mcp.json'));

  const sources = [];
  for (const f of files) {
    const raw = readIfExists(f);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const map = data.mcpServers || data.servers || {};
      for (const [k, v] of Object.entries(map)) {
        servers[k] = v;
      }
      sources.push(f);
    } catch {
      /* ignore invalid mcp json */
    }
  }
  return { mcpServers: servers, sources };
}

/**
 * Create starter rules.md, skills/cosmo-cooperation/SKILL.md, and mcp.json in ~/.config/cosmodrome.
 */
export function initCustomizations(paths) {
  const created = [];
  fs.mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });

  const rulesFile = path.join(paths.configDir, 'rules.md');
  if (!fs.existsSync(rulesFile)) {
    fs.writeFileSync(
      rulesFile,
      `# Cosmodrome Shared AI Rules\n\n` +
        `- Keep answers concise and actionable.\n` +
        `- Format file paths as clickable links: [basename](file:///absolute/path#L1).\n` +
        `- Use \`\`\`preview Title blocks to show key architecture summaries or UI previews in the terminal.\n`,
      { mode: 0o600 },
    );
    created.push(rulesFile);
  }

  const skillDir = path.join(paths.configDir, 'skills', 'cosmo-orchestration');
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      skillFile,
      `---\nname: cosmo-orchestration\ndescription: Delegate subtasks across specialized agents (@claude, @codex, @agy, @copilot, @ollama) and render rich terminal previews.\n---\n\n` +
        `# Cosmodrome Multi-Agent Cooperation\n\n` +
        `1. Emit \`<cosmo:tool name="ToolName" detail="what you are doing" />\` when performing multi-step reasoning.\n` +
        `2. Emit \`<cosmo:subagent agent="claude" mode="ask">subtask prompt</cosmo:subagent>\` to delegate work to another agent.\n` +
        `3. Use \`[filename](file:///absolute/path#L10)\` for clickable terminal links.\n`,
      { mode: 0o600 },
    );
    created.push(skillFile);
  }

  const mcpFile = path.join(paths.configDir, 'mcp.json');
  if (!fs.existsSync(mcpFile)) {
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({ mcpServers: {} }, null, 2) + '\n',
      { mode: 0o600 },
    );
    created.push(mcpFile);
  }

  return created;
}

function mergeJsonFile(filePath, patchFn) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    current = {};
  }
  const next = patchFn(current);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Sync shared Cosmodrome rules, skills, and MCP servers into an agent's per-profile directory
 * so all agents (claude, agy, codex, copilot, opencode) share the same capabilities.
 */
export function syncAgentCustomizations({ agent, agentDir, paths, cwd }) {
  if (!agent || !agentDir) return { synced: [] };
  const rules = loadRules(paths, cwd);
  const skills = loadSkills(paths, cwd);
  const { mcpServers } = loadMcpServers(paths, cwd);
  const hasMcp = Object.keys(mcpServers).length > 0;
  if (!rules.length && !skills.length && !hasMcp) return { synced: [] };

  const synced = [];
  const combinedInstructions = [
    '# Cosmodrome Shared Rules & Skills',
    ...rules.map((r) => r.content),
    ...(skills.length
      ? [
          '## Active Cosmodrome Skills',
          ...skills.map((s) => `### ${s.name}\n${s.description}\n\n${s.body}`),
        ]
      : []),
  ].join('\n\n') + '\n';

  try {
    if (agent.name === 'claude') {
      const claudeMd = path.join(agentDir, 'CLAUDE.md');
      fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(claudeMd, combinedInstructions, { mode: 0o600 });
      synced.push(claudeMd);
      if (hasMcp) {
        const claudeJson = path.join(agentDir, '.claude.json');
        mergeJsonFile(claudeJson, (cur) => ({ ...cur, mcpServers: { ...(cur.mcpServers || {}), ...mcpServers } }));
        synced.push(claudeJson);
      }
    } else if (agent.name === 'agy') {
      const agyBase = path.join(agentDir, 'home', '.gemini', 'antigravity-cli');
      fs.mkdirSync(agyBase, { recursive: true, mode: 0o700 });
      if (hasMcp) {
        const mcpPath = path.join(agyBase, 'mcp_config.json');
        mergeJsonFile(mcpPath, (cur) => ({ ...cur, mcpServers: { ...(cur.mcpServers || {}), ...mcpServers } }));
        synced.push(mcpPath);
      }
      for (const s of skills) {
        const targetSkill = path.join(agyBase, 'skills', s.name, 'SKILL.md');
        fs.mkdirSync(path.dirname(targetSkill), { recursive: true, mode: 0o700 });
        fs.writeFileSync(targetSkill, `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}\n`, { mode: 0o600 });
        synced.push(targetSkill);
      }
    } else if (agent.name === 'codex') {
      const codexMd = path.join(agentDir, 'instructions.md');
      fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(codexMd, combinedInstructions, { mode: 0o600 });
      synced.push(codexMd);
    } else if (agent.name === 'opencode') {
      const ocDir = path.join(agentDir, 'config', 'opencode');
      fs.mkdirSync(ocDir, { recursive: true, mode: 0o700 });
      const ocMd = path.join(ocDir, 'AGENTS.md');
      fs.writeFileSync(ocMd, combinedInstructions, { mode: 0o600 });
      synced.push(ocMd);
      if (hasMcp) {
        const ocJson = path.join(ocDir, 'opencode.json');
        mergeJsonFile(ocJson, (cur) => ({ ...cur, mcp: { ...(cur.mcp || {}), ...mcpServers } }));
        synced.push(ocJson);
      }
    } else if (agent.name === 'copilot') {
      const copilotMd = path.join(agentDir, 'instructions.md');
      fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(copilotMd, combinedInstructions, { mode: 0o600 });
      synced.push(copilotMd);
    }
  } catch {
    /* non-fatal sync */
  }

  return { synced };
}
