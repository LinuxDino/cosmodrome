import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageTracker, isUsageLimit } from '../src/usage.js';
import {
  parseSubagentCalls,
  parseCosmoToolTag,
  pickLocalModel,
  routePromptToAgent,
  stripCosmoTags,
} from '../src/orchestrator.js';
import {
  parseSkillFile,
  initCustomizations,
  loadSkills,
  loadRules,
  loadMcpServers,
  syncAgentCustomizations,
} from '../src/skills.js';
import { buildCosmoContext } from '../src/context.js';
import { detectTextToolCall } from '../src/tui/runner.js';
import { spinnerLine, subagentLines } from '../src/tui/components/spinner.js';
import { createMarkdownState, renderMarkdownLine, renderPreviewBox } from '../src/tui/markdown.js';
import { getAgent } from '../src/agents.js';

const plain = new Proxy({}, { get: () => (s) => String(s) });

test('package.json has zero runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {});
});

test('UsageTracker detects rate limits and silently fails over to healthy provider', () => {
  assert.equal(isUsageLimit({ code: 1, stderr: 'Error 429: Too Many Requests - usage limit reached' }), true);
  assert.equal(isUsageLimit({ code: 1, text: 'Your credit balance is too low or quota exceeded.' }), true);
  assert.equal(isUsageLimit({ code: 0, text: 'Normal answer about rate limit algorithms' }), false);

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'usage.json');
  const tracker = new UsageTracker(tmp, { cooldownMs: 60_000 });

  const r1 = tracker.record('work', 'claude', { code: 1, stderr: '429 usage limit exceeded' }, 1200);
  assert.equal(r1.limited, true);
  assert.equal(tracker.isThrottled('work', 'claude'), true);

  const picked = tracker.pickAgent({
    profile: 'work',
    preferred: 'claude',
    candidates: ['claude', 'codex', 'agy', 'ollama'],
    isInstalled: (a) => ['claude', 'codex', 'ollama'].includes(a),
  });
  assert.equal(picked.switched, true);
  assert.equal(picked.agent, 'codex');
  assert.equal(picked.from, 'claude');

  tracker.clearCooldowns();
  assert.equal(tracker.isThrottled('work', 'claude'), false);
});

test('orchestrator parses <cosmo:subagent> and <cosmo:tool> tags and routes tasks', () => {
  const output = `
    <cosmo:tool name="Analyze" detail="src/tui/app.js" />
    Let me delegate this to specialists:
    <cosmo:subagent agent="claude" mode="ask">Audit src/env.js for security</cosmo:subagent>
    <cosmo:subagent agent="agy" mode="ask">Search latest MCP specification</cosmo:subagent>
  `;
  const calls = parseSubagentCalls(output);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { agent: 'claude', mode: 'ask', prompt: 'Audit src/env.js for security' });
  assert.deepEqual(calls[1], { agent: 'agy', mode: 'ask', prompt: 'Search latest MCP specification' });

  const tool = parseCosmoToolTag('<cosmo:tool name="WebSearch" detail="node test runner" />');
  assert.deepEqual(tool, { name: 'WebSearch', detail: 'node test runner' });
  assert.equal(stripCosmoTags(output), 'Let me delegate this to specialists:');

  assert.equal(pickLocalModel(['mistral:latest', 'qwen2.5-coder:7b'], {}, {}), 'qwen2.5-coder:7b');
  assert.equal(routePromptToAgent('search the web for latest docs', ['claude', 'agy']).agent, 'agy');
  assert.equal(routePromptToAgent('fix test suite in sandbox', ['claude', 'codex']).agent, 'codex');
});

test('skills, rules and MCP initialize and sync across agent profiles', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-skills-'));
  const paths = {
    configDir: path.join(base, 'config'),
    stationDir: path.join(base, 'data', 'profiles'),
    home: base,
  };
  const created = initCustomizations(paths);
  assert.equal(created.length, 3);

  const mcpFile = path.join(paths.configDir, 'mcp.json');
  fs.writeFileSync(
    mcpFile,
    JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } } }),
  );

  const skills = loadSkills(paths, base);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'cosmo-orchestration');

  const rules = loadRules(paths, base);
  assert.equal(rules.length, 1);

  const mcp = loadMcpServers(paths, base);
  assert.ok(mcp.mcpServers.filesystem);

  for (const agentName of ['claude', 'agy', 'codex', 'opencode']) {
    const agent = getAgent(agentName);
    const agentDir = path.join(paths.stationDir, 'work', 'agents', agentName);
    const res = syncAgentCustomizations({ agent, agentDir, paths, cwd: base });
    assert.ok(res.synced.length > 0, `synced files for ${agentName}`);
  }

  const briefing = buildCosmoContext({
    profile: 'work',
    agent: 'ollama',
    cwd: '/repo',
    installedAgents: ['ollama', 'claude', 'agy'],
    throttledAgents: ['claude'],
    paths,
  });
  assert.ok(briefing.includes('#work/ollama'));
  assert.ok(briefing.includes('@claude'));
  assert.ok(briefing.includes('cosmo-orchestration'));
  assert.ok(briefing.includes('filesystem'));
});

test('TUI live tool detection, subagent tree HUD, and preview cards', () => {
  assert.deepEqual(detectTextToolCall('<cosmo:tool name="Read" detail="src/cli.js" />'), {
    name: 'Read',
    detail: 'src/cli.js',
    consumeLine: true,
  });
  assert.deepEqual(detectTextToolCall('⏺ WebSearch(npm trusted publishing)'), {
    name: 'WebSearch',
    detail: 'npm trusted publishing',
    consumeLine: true,
  });

  const spin = spinnerLine({
    frame: 0,
    verb: 'Orbiting',
    agent: 'claude',
    startedAt: Date.now() - 3000,
    action: { name: 'Read', detail: 'src/app.js' },
    toolCount: 2,
    t: plain,
  });
  assert.ok(spin.includes('▸ Read(src/app.js)') && spin.includes('2 tools'));

  const tree = subagentLines(
    [
      { agent: 'claude', status: 'running', action: 'Read(src/env.js)', startedAt: Date.now() - 2000 },
      { agent: 'agy', status: 'done', action: 'completed', startedAt: Date.now() - 4000, endedAt: Date.now() - 1000 },
    ],
    { t: plain },
  );
  assert.equal(tree.length, 2);
  assert.ok(tree[0].includes('├─') && tree[0].includes('@claude'));
  assert.ok(tree[1].includes('└─') && tree[1].includes('@agy'));

  const st = createMarkdownState();
  assert.ok(renderMarkdownLine('```preview Architecture', st, plain).includes('✦ Architecture'));
  assert.ok(renderMarkdownLine('See [app.js](file:///repo/src/app.js#L10)', st, plain).includes('app.js'));
  assert.ok(renderMarkdownLine('```', st, plain).includes('╰'));

  const box = renderPreviewBox({ title: 'package.json', url: 'file:///repo/package.json', lines: ['{', '  "name": "cosmodrome"', '}'], t: plain });
  assert.equal(box.length, 5);
  assert.ok(box[0].includes('package.json'));
});
