import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdapter, adapterNames } from '../src/core/adapters/index.js';
import { runCli, spawnProcess } from '../src/core/adapters/base.js';
import { validateEvent, classifyError, PROTOCOL_VERSION, EVENT_TYPES } from '../src/core/events.js';
import { getAgent } from '../src/agents.js';

/** Replay a fixture through the agent's parser; returns { events, res, summary }. */
async function replay(fixture, opts = {}) {
  const events = [];
  const agent = fixture.split('/')[0];
  const res = await getAdapter('mock').run({ agent, fixture, delayMs: 0, onEvent: (e) => events.push(e), ...opts }).promise;
  for (const e of events) assert.deepEqual(validateEvent(e), [], `${fixture}: ${JSON.stringify(e)}`);
  const summary = events.map((e) => {
    if (e.type === 'text') return e.final ? `text!${e.text}` : `text:${e.text}`;
    if (e.type === 'tool_start') return `tool_start:${e.name}:${e.detail}`;
    if (e.type === 'tool_end') return `tool_end:${e.ok}`;
    if (e.type === 'error') return `error:${e.kind}`;
    return e.type;
  });
  return { events, res, summary };
}

const CASES = {
  'claude/simple': {
    events: ['run_start', 'session', 'text:2 + 2 is 4.', 'text:\nThe sky is blue.', 'text!', 'usage', 'run_end'],
    res: { code: 0, text: '2 + 2 is 4.\nThe sky is blue.', sessionId: '11111111-1111-4111-8111-111111111111', limitHit: false },
    usage: { costUsd: 0.0123, inputTokens: 12, outputTokens: 14 },
  },
  'claude/tool': {
    events: ['run_start', 'session', 'tool_start:Read:/work/a.txt', 'tool_end:true', 'text:hello', 'text!', 'usage', 'run_end'],
    res: { code: 0, text: 'hello', toolCount: 1 },
  },
  'claude/limit': {
    events: ['run_start', 'session', 'usage', "text!You've hit your usage limit · resets 3pm", 'error:limit', 'run_end'],
    res: { code: 1, limitHit: true, errorKind: 'limit' },
  },
  'claude/auth': {
    events: ['run_start', 'session', 'usage', 'text!Invalid API key · Please run /login', 'error:auth', 'run_end'],
    res: { code: 1, limitHit: false, errorKind: 'auth' },
  },
  'claude/cancelled': {
    events: ['run_start', 'session', ...['Once', ' upon', ' a time,', ' a small', ' rocket', ' waited', ' on', ' the', ' launch', ' pad.'].map((w) => `text:${w}`), 'text!', 'run_end'],
    res: { code: 0, text: 'Once upon a time, a small rocket waited on the launch pad.' },
  },
  'codex/simple': {
    events: ['run_start', 'session', 'text!2 + 2 is 4.\nThe sky is blue.', 'usage', 'run_end'],
    res: { code: 0, sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
  },
  'codex/tool': {
    events: ['run_start', 'session', "tool_start:Bash:/bin/zsh -lc 'cat a.txt'", 'tool_end:true', 'text!The file says **hello**.', 'usage', 'run_end'],
    res: { code: 0, text: 'The file says **hello**.' },
  },
  'codex/auth': { events: ['run_start', 'session', 'error:auth', 'run_end'], res: { code: 1, errorKind: 'auth', limitHit: false } },
  'codex/limit': { events: ['run_start', 'session', 'error:limit', 'run_end'], res: { code: 1, limitHit: true } },
  'copilot/simple': {
    events: ['run_start', 'text:2 + 2 is 4.', 'text:\nThe sky is blue.', 'text!', 'session', 'usage', 'run_end'],
    res: { code: 0, text: '2 + 2 is 4.\nThe sky is blue.', sessionId: '22222222-2222-4222-8222-222222222222' },
  },
  'copilot/tool': {
    events: ['run_start', 'tool_start:view:/work/a.txt', 'tool_end:true', 'text:hello', 'text!', 'session', 'usage', 'run_end'],
    res: { code: 0, text: 'hello' },
  },
  'copilot/auth': { events: ['run_start', 'error:auth', 'session', 'usage', 'run_end'], res: { code: 1, errorKind: 'auth' } },
  'opencode/simple': { events: ['run_start', 'session', 'text!2 + 2 is 4.\nThe sky is blue.', 'usage', 'run_end'], res: { code: 0 } },
  'opencode/tool': {
    events: ['run_start', 'session', 'tool_start:read:/work/a.txt', 'tool_end:true', 'usage', 'text!hello', 'usage', 'run_end'],
    res: { code: 0, text: 'hello' },
    usage: { inputTokens: 15336, outputTokens: 94 },
  },
  'opencode/auth': { events: ['run_start', 'session', 'error:auth', 'run_end'], res: { code: 1, errorKind: 'auth' } },
  'agy/simple': {
    events: ['run_start', 'session', 'text:2', 'text: + 2 is 4.\nThe sky is blue.', 'text:\n', 'text!', 'usage', 'run_end'],
    res: { code: 0, text: '2 + 2 is 4.\nThe sky is blue.', sessionId: '33333333-3333-4333-8333-333333333333' },
  },
  'agy/tool': {
    events: ['run_start', 'session', 'tool_start:read_file:/work/a.txt', 'tool_end:true', 'text:hello\n', 'text!', 'usage', 'run_end'],
    res: { code: 0, text: 'hello' },
  },
  'ollama/simple': {
    events: ['run_start', 'text:2 + 2 is 4.', 'text:\nThe sky', 'text: is blue.', 'usage', 'text!', 'run_end'],
    res: { code: 0, text: '2 + 2 is 4.\nThe sky is blue.' },
    usage: { inputTokens: 22, outputTokens: 12 },
  },
};

for (const [fixture, want] of Object.entries(CASES)) {
  test(`adapter: ${fixture} fixture -> events`, async () => {
    const { summary, res } = await replay(fixture);
    assert.deepEqual(summary, want.events);
    for (const [k, v] of Object.entries(want.res)) assert.deepEqual(res[k], v, `run_end.${k}`);
    for (const [k, v] of Object.entries(want.usage || {})) assert.equal(res.usage[k], v, `usage.${k}`);
    assert.equal(res.type, 'run_end', 'the promise resolves with the run_end event');
  });
}

test('every fixture file has an expected event list', () => {
  const dir = new URL('./fixtures/', import.meta.url);
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.jsonl')).map((f) => String(f).replace(/\.jsonl$/, ''));
  assert.deepEqual(files.sort(), Object.keys(CASES).sort());
});

test('registry: every built-in agent has an adapter that matches its output format', () => {
  for (const name of ['claude', 'codex', 'copilot', 'opencode', 'agy', 'ollama']) {
    const adapter = getAdapter(getAgent(name), {});
    assert.equal(adapter.name, name);
    const caps = adapter.capabilities();
    assert.deepEqual(Object.keys(caps).sort(), ['readOnlyMode', 'resume', 'streaming', 'structured']);
    assert.equal(caps.structured, true, `${name} uses a structured output mode`);
    assert.match(adapter.checkedWith, /\d/, `${name} notes the version its flags were checked against`);
  }
  const custom = getAgent('aider', { agents: { aider: { headless: { args: ['{prompt}'], stream: 'text' } } } });
  assert.equal(getAdapter(custom, {}).name, 'text');
  assert.equal(getAdapter(getAgent('claude'), { COSMO_MOCK: '1' }).name, 'mock');
  assert.ok(adapterNames().includes('mock'));
});

test('text adapter: plain lines are one answer, and only <cosmo:tool> makes a tool line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-text-'));
  fs.mkdirSync(path.join(dir, 'text'));
  fs.writeFileSync(path.join(dir, 'text', 'simple.txt'), '⏺ WebSearch(latest docs)\nReading src/app.js\n<cosmo:tool name="Test" detail="npm test" />\ndone\n');
  const events = [];
  const ok = await getAdapter('mock').run({ agent: 'aider', fixture: 'text/simple', fixtureDir: dir, delayMs: 0, onEvent: (e) => events.push(e) }).promise;
  const tools = events.filter((e) => e.type === 'tool_start');
  assert.deepEqual(tools.map((e) => e.name), ['Test'], 'no tool guessed from "⏺ WebSearch(...)" or "Reading ..."');
  assert.equal(ok.text, '⏺ WebSearch(latest docs)\nReading src/app.js\ndone');
  assert.equal(events.filter((e) => e.type === 'text' && e.final).length, 1, 'one block, not one per line');
});

test('real process: runCli spawns the agent, parses stdout and resolves run_end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-cli-'));
  const bin = path.join(dir, 'claude');
  const fixture = fileURLToPathSafe(new URL('./fixtures/claude/tool.jsonl', import.meta.url));
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\ncat "${fixture}"\n`, { mode: 0o755 });
  const events = [];
  const rec = path.join(dir, 'rec');
  const res = await getAdapter('claude').run({
    agent: 'claude',
    bin,
    prompt: 'read a.txt',
    mode: 'ask',
    sessionId: 'abc',
    cwd: dir,
    profileEnv: { PATH: process.env.PATH, COSMO_RECORD: rec },
    onEvent: (e) => events.push(e),
  }).promise;
  assert.equal(res.code, 0);
  assert.equal(res.text, 'hello');
  const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
  assert.match(args, /--output-format stream-json --verbose --include-partial-messages/);
  assert.match(args, /--resume abc/);
  const saved = fs.readdirSync(rec);
  assert.ok(saved.some((f) => f.startsWith('claude-') && f.endsWith('.stdout')), 'COSMO_RECORD keeps the raw output');
});

test('real process: cancel interrupts the process group (SIGINT, then SIGKILL)', async () => {
  const lines = [];
  const proc = spawnProcess({ bin: '/bin/sh', args: ['-c', 'echo started; sleep 30 & sleep 30; wait'], onLine: (l) => lines.push(l) });
  while (!lines.length) await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  proc.cancel();
  const res = await proc.promise;
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(res.cancelled, true);
});

test('a missing binary ends as a crash error, not an exception', async () => {
  const events = [];
  const res = await runCli(getAdapter('codex'), { agent: 'codex', bin: '/nonexistent/codex', prompt: 'x', mode: 'ask', cwd: os.tmpdir(), profileEnv: {}, onEvent: (e) => events.push(e) }).promise;
  assert.equal(res.code, 127);
  assert.equal(res.errorKind, 'crash');
});

test('mock run can be cancelled mid-way', async () => {
  const events = [];
  const handle = getAdapter('mock').run({ agent: 'claude', fixture: 'claude/cancelled', delayMs: 10, onEvent: (e) => events.push(e) });
  while (!events.some((e) => e.type === 'text')) await new Promise((r) => setTimeout(r, 5));
  handle.cancel();
  const res = await handle.promise;
  assert.equal(res.cancelled, true);
  assert.ok(res.text.startsWith('Once') && !res.text.endsWith('pad.'), 'partial answer kept');
});

function fakeFetch(lines, { status = 200 } = {}) {
  return async (url, init) => {
    fakeFetch.last = { url, body: JSON.parse(init.body) };
    if (status !== 200) return { ok: false, status, text: async () => JSON.stringify({ error: lines }), json: async () => ({ error: lines }) };
    const enc = new TextEncoder();
    return {
      ok: true,
      status,
      body: (async function* () {
        for (const l of lines) yield enc.encode(JSON.stringify(l) + '\n');
      })(),
    };
  };
}

test('ollama adapter talks to /api/chat over HTTP and keeps the conversation', async () => {
  const chunk = (content, done = false) => ({ model: 'qwen3:8b', message: { role: 'assistant', content }, done, ...(done ? { prompt_eval_count: 5, eval_count: 3 } : {}) });
  const fetchFn = fakeFetch([chunk('Hi'), chunk(' there'), chunk('', true)]);
  const events = [];
  const res = await getAdapter('ollama').run({ prompt: 'hello', model: 'qwen3:8b', profileEnv: { OLLAMA_HOST: '0.0.0.0:11434' }, fetchFn, onEvent: (e) => events.push(e) }).promise;
  assert.equal(fakeFetch.last.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(fakeFetch.last.body.stream, true);
  assert.equal(res.text, 'Hi there');
  assert.equal(res.usage.outputTokens, 3);
  const again = await getAdapter('ollama').run({ prompt: 'and now?', sessionId: res.sessionId, profileEnv: {}, fetchFn: fakeFetch([chunk('ok', true)]) }).promise;
  assert.deepEqual(fakeFetch.last.body.messages.map((m) => m.content), ['hello', 'Hi there', 'and now?']);
  assert.equal(again.code, 0);
});

test('ollama adapter: unknown model and server down become error events', async () => {
  const missing = await getAdapter('ollama').run({ prompt: 'x', model: 'nope:1b', profileEnv: {}, fetchFn: fakeFetch("model 'nope:1b' not found", { status: 404 }) }).promise;
  assert.equal(missing.code, 1);
  assert.equal(missing.errorKind, 'other');
  const down = await getAdapter('ollama').run({
    prompt: 'x',
    profileEnv: {},
    fetchFn: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
  }).promise;
  assert.equal(down.code, 1);
  assert.equal(down.errorKind, 'crash');
});

test('events: validation and error classification', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.ok(EVENT_TYPES.run_end.includes('text'));
  assert.deepEqual(validateEvent({ type: 'text', runId: 'r', ts: new Date().toISOString(), text: 'x' }), []);
  assert.ok(validateEvent({ type: 'text', runId: 'r', ts: 'yesterday', text: 'x' }).length);
  assert.ok(validateEvent({ type: 'nope', runId: 'r', ts: new Date().toISOString() }).length);
  assert.ok(validateEvent({ type: 'error', runId: 'r', ts: new Date().toISOString(), message: 'x', kind: 'weird' }).length);
  assert.equal(classifyError('Rate limit exceeded, try again in 5 minutes'), 'limit');
  assert.equal(classifyError('401 Unauthorized'), 'auth');
  assert.equal(classifyError('segfault'), 'other');
});

function fileURLToPathSafe(u) {
  return decodeURIComponent(u.pathname);
}
