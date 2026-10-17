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
import { buildCosmoContext, enrichPrompt } from '../src/context.js';
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
  assert.match(briefing, /Before answering, editing files, or using tools, inspect and follow/);

  const enriched = enrichPrompt('inspect the repository', { paths, cwd: base, agent: 'claude' });
  assert.ok(enriched.indexOf('inspect and follow') < enriched.indexOf('User request:'));
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

test('agent sync keeps user files and never touches Claude state', async () => {
  const { syncAgentCustomizations, writeManagedBlock, mergeJsonFile, parseSkillFile } = await import('../src/skills.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-sync-'));
  const paths = { configDir: path.join(root, 'cfg') };
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(path.join(paths.configDir, 'rules.md'), 'Be brief.');
  fs.writeFileSync(path.join(paths.configDir, 'mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }));
  const agentDir = path.join(root, 'claude');
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), '# My own notes\nkeep me\n');
  fs.writeFileSync(path.join(agentDir, '.claude.json'), '{"oauthAccount":{"x":1}}');

  const res = syncAgentCustomizations({ agent: { name: 'claude' }, agentDir, paths, cwd: root });
  const md = fs.readFileSync(path.join(agentDir, 'CLAUDE.md'), 'utf8');
  assert.match(md, /# My own notes\nkeep me/);
  assert.match(md, /cosmodrome:start[\s\S]*Be brief\.[\s\S]*cosmodrome:end/);
  assert.equal(fs.readFileSync(path.join(agentDir, '.claude.json'), 'utf8'), '{"oauthAccount":{"x":1}}');
  assert.deepEqual(JSON.parse(fs.readFileSync(res.mcpConfig, 'utf8')).mcpServers, { docs: { command: 'docs-mcp' } });

  // a second sync replaces only the managed block
  fs.writeFileSync(path.join(paths.configDir, 'rules.md'), 'Be very brief.');
  syncAgentCustomizations({ agent: { name: 'claude' }, agentDir, paths, cwd: root });
  const md2 = fs.readFileSync(path.join(agentDir, 'CLAUDE.md'), 'utf8');
  assert.equal((md2.match(/cosmodrome:start/g) || []).length, 1);
  assert.match(md2, /Be very brief\./);
  assert.doesNotMatch(md2, /Be brief\./);

  assert.equal(writeManagedBlock(path.join(root, 'x.md'), ''), false);
  const broken = path.join(root, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  assert.equal(mergeJsonFile(broken, () => ({ a: 1 })), false);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ not json');

  assert.equal(parseSkillFile('---\nname: ../../.ssh/evil\n---\nbody').name, 'ssh-evil');
});

test('claude gets the MCP file as one --mcp-config= argument', async () => {
  const { getAgent, buildHeadless } = await import('../src/agents.js');
  const args = buildHeadless(getAgent('claude'), 'hi', { mode: 'ask', mcpConfig: '/p/cosmodrome-mcp.json' });
  assert.ok(args.includes('--mcp-config=/p/cosmodrome-mcp.json'));
  assert.deepEqual(args.slice(-2), ['--', 'hi']);
});

test('model output can lower the run mode but never raise it', async () => {
  const { App } = await import('../src/tui/app.js');
  const effective = (userMode, requested) => App.prototype.effectiveMode.call({ state: { mode: userMode } }, requested);
  assert.equal(effective('ask', 'auto'), 'ask');
  assert.equal(effective('auto', 'auto'), 'auto');
  assert.equal(effective('auto', 'ask'), 'ask');
  assert.equal(effective('auto', undefined), 'auto');
  assert.equal(effective('ask', 'whatever'), 'ask');
});

test('one answer starts at most MAX_SUBAGENTS subagents', async () => {
  const { parseSubagentCalls, MAX_SUBAGENTS } = await import('../src/orchestrator.js');
  const many = Array.from({ length: 10 }, (_, i) => `<cosmo:subagent agent="codex">task ${i}</cosmo:subagent>`).join('\n');
  assert.equal(parseSubagentCalls(many).length, MAX_SUBAGENTS);
});

test('subagent tags are hidden while an answer streams', async () => {
  const { createSubagentTagFilter } = await import('../src/orchestrator.js');
  const f = createSubagentTagFilter();
  assert.equal(f('Plan:'), 'Plan:');
  assert.equal(f('<cosmo:subagent agent="codex">write'), null);
  assert.equal(f('the tests</cosmo:subagent>'), null);
  assert.equal(f('before <cosmo:subagent agent="a">x</cosmo:subagent> after'), 'before  after');
  assert.equal(f('a\n<cosmo:subagent agent="b">y</cosmo:subagent>\nb'), 'a\nb');
});

test('per-profile models reach each agent with its own flag', async () => {
  const { getAgent, buildHeadless, agentModel } = await import('../src/agents.js');
  const config = { agents: { codex: { model: 'gpt-5-codex' } }, profiles: { work: { agents: { claude: { model: 'opus' } } } } };
  assert.equal(agentModel(config, 'work', 'claude'), 'opus');
  assert.equal(agentModel(config, 'work', 'codex'), 'gpt-5-codex', 'falls back to the global agent setting');
  assert.equal(agentModel(config, 'work', 'copilot'), null);

  const claude = buildHeadless(getAgent('claude'), 'hi', { agentModel: 'opus' });
  assert.ok(claude.join(' ').includes('--model opus') && claude.at(-1) === 'hi');
  const codex = buildHeadless(getAgent('codex'), 'x', { agentModel: 'gpt-5-codex', mode: 'ask' });
  assert.deepEqual(codex.slice(0, 4), ['exec', '--skip-git-repo-check', '--model', 'gpt-5-codex']);
  assert.ok(buildHeadless(getAgent('opencode'), 'x', { agentModel: 'github-copilot/gpt-5' }).join(' ').includes('run --model github-copilot/gpt-5'));
  const custom = getAgent('aider', { agents: { aider: { headless: { args: ['--message', '{prompt}'], modelArgs: ['--model', '{model}'] } } } });
  assert.deepEqual(buildHeadless(custom, 'go', { agentModel: 'sonnet' }), ['--model', 'sonnet', '--message', 'go']);
  assert.deepEqual(getAgent('claude').launchArgs({ agentModel: 'opus', mcpConfig: '/m.json' }), ['--model', 'opus', '--mcp-config=/m.json']);
});

test('copilot: verified flags for ask/auto, model and MCP', async () => {
  const { getAgent, buildHeadless } = await import('../src/agents.js');
  const copilot = getAgent('copilot');
  const ask = buildHeadless(copilot, 'review', { mode: 'ask', agentModel: 'auto', mcpConfig: '/c/cosmodrome-mcp.json' });
  assert.deepEqual(ask.slice(0, 7), ['-p', 'review', '--output-format', 'text', '--stream', 'off', '--no-color']);
  assert.ok(ask.includes('--deny-tool=write') && ask.includes('--deny-tool=shell') && ask.includes('--allow-all-urls'));
  assert.ok(!ask.includes('--allow-all-tools'));
  assert.ok(ask.join(' ').includes('--model auto'));
  assert.ok(ask.includes('--additional-mcp-config=@/c/cosmodrome-mcp.json'));
  const auto = buildHeadless(copilot, 'fix', { mode: 'auto', continued: true });
  assert.ok(auto.includes('--allow-all-tools') && auto.includes('--continue') && !auto.includes('--deny-tool=write'));
});

test('COSMO.md reaches every agent, Copilot via copilot-instructions.md', async () => {
  const { syncAgentCustomizations, loadRules, cosmoMdPath } = await import('../src/skills.js');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-proj-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'COSMO.md'), '# Project rules\nAlways run npm test.');
  const paths = { configDir: path.join(repo, 'cfg-none') };
  assert.equal(cosmoMdPath(path.join(repo, 'src')), path.join(repo, 'COSMO.md'));
  assert.equal(loadRules(paths, path.join(repo, 'src'))[0].scope, 'project');

  const copilotDir = path.join(repo, 'agents', 'copilot');
  syncAgentCustomizations({ agent: { name: 'copilot' }, agentDir: copilotDir, paths, cwd: path.join(repo, 'src') });
  assert.match(fs.readFileSync(path.join(copilotDir, 'copilot-instructions.md'), 'utf8'), /Always run npm test\./);
  const codexDir = path.join(repo, 'agents', 'codex');
  syncAgentCustomizations({ agent: { name: 'codex' }, agentDir: codexDir, paths, cwd: repo });
  assert.match(fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8'), /Always run npm test\./);
});
