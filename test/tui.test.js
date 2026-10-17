import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getAgent, buildHeadless } from '../src/agents.js';
import { extractFiles, saveArtifact, listArtifacts, zipArtifacts, slugify } from '../src/artifacts.js';
import { crc32, createZip } from '../src/zip.js';
import { promptBox } from '../src/tui/components/promptBox.js';
import { renderMarkdownLine, createMarkdownState } from '../src/tui/markdown.js';
import { width, truncate, sanitize, Screen } from '../src/tui/screen.js';
import { ChannelManager, recordRun } from '../src/tui/channels.js';
import { runProcess } from '../src/tui/runner.js';
import { renderDashboard, renderProviderHealth, renderProviderMetrics, renderTaskMetrics, renderTaskTree } from '../src/tui/components/dashboard.js';
import { App } from '../src/tui/app.js';

const plain = new Proxy({}, { get: () => (s) => String(s) });

test('dashboard renders compact task tree and provider panels', () => {
  const tasks = [
    { id: 'root', prompt: 'Ship dashboard', status: 'executing', assignedAgent: 'claude', parentTaskId: null },
    { id: 'child', prompt: 'Run tests', status: 'completed', assignedAgent: 'codex', parentTaskId: 'root' },
  ];
  const rows = [{ profile: 'work', agent: 'claude', runs: 2, errors: 1, rateLimits: 0, costUsd: 0.12, durationMs: 2500, throttled: false }];
  const tree = renderTaskTree(tasks, { t: plain, cols: 60 });
  assert.ok(tree.some((line) => line.includes('[>] Ship dashboard @claude')));
  assert.ok(tree.some((line) => line.includes('`-[x] Run tests @codex')));
  assert.ok(renderProviderHealth(rows, { t: plain }).some((line) => line.includes('[degraded]')));
  assert.ok(renderProviderHealth([{ profile: 'work', agent: 'opencode', installed: false }], { t: plain }).some((line) => line.includes('[not installed]')));
  assert.ok(renderProviderMetrics(rows, { t: plain }).some((line) => line.includes('runs 2')));
  assert.ok(renderTaskMetrics([
    { status: 'completed', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:02Z' },
    { status: 'failed', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:04Z' },
  ], { t: plain }).some((line) => line.includes('success 50%')));
  assert.ok(renderDashboard({ tasks, rows, t: plain }).includes('Cosmodrome dashboard'));
});

test('headless args per agent and mode', () => {
  const claude = getAgent('claude');
  const first = buildHeadless(claude, 'hi', { mode: 'ask' });
  assert.equal(first[0], '-p');
  assert.deepEqual(first.slice(-2), ['--', 'hi']);
  assert.deepEqual(buildHeadless(claude, '- list files', {}).slice(-2), ['--', '- list files']);
  assert.ok(first.includes('stream-json'));
  assert.ok(!first.includes('--permission-mode'));
  const next = buildHeadless(claude, 'again', { mode: 'auto', resumeId: 'abc', continued: true });
  assert.ok(next.includes('--resume') && next.includes('abc') && next.includes('acceptEdits'));
  assert.ok(buildHeadless(getAgent('copilot'), 'x', { mode: 'auto' }).includes('--allow-all-tools'));
  assert.deepEqual(buildHeadless(getAgent('opencode'), 'x', { mode: 'ask' }), ['run', '--agent', 'plan', 'x']);
  assert.ok(buildHeadless(getAgent('codex'), 'x', { continued: true, mode: 'ask' }).join(' ').includes('read-only resume --last x'));
  const ollama = getAgent('local');
  assert.equal(ollama.name, 'ollama');
  assert.deepEqual(buildHeadless(ollama, 'explain this', { model: 'qwen3:8b' }), ['run', 'qwen3:8b', 'explain this']);
  const custom = getAgent('aider', { agents: { aider: { command: 'aider', headless: { args: ['--message', '{prompt}'], autoArgs: ['--yes'] } } } });
  assert.deepEqual(buildHeadless(custom, 'go', { mode: 'auto' }), ['--message', 'go', '--yes']);
});

test('extractFiles finds named and unnamed code blocks safely', () => {
  const files = extractFiles('```README.md\n# A\n```\n```js src/a.js\nx\n```\n```bash\nls\n```\n```yaml\n# file: .github/workflows/ci.yml\non: push\n```\n```../evil.sh\nrm\n```');
  assert.deepEqual(files.map((f) => f.path), ['README.md', 'src/a.js', 'snippet-1.sh', '.github/workflows/ci.yml', 'snippet-2.txt']);
  assert.equal(slugify('Hello, World!  Ünïcode'), 'hello-world-unicode');
});

test('artifacts save, list and zip', () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'art-')), '.cosmo', 'artifacts');
  saveArtifact(root, { title: 'Demo', text: 'x\n```a.txt\nhello\n```', kind: 'artifact' });
  const list = listArtifacts(root);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].files, ['RESPONSE.md', 'a.txt']);
  assert.equal(fs.readFileSync(path.join(path.dirname(root), '.gitignore'), 'utf8'), '*\n');
  const { file } = zipArtifacts(root, list);
  const r = spawnSync('unzip', ['-tq', file], { encoding: 'utf8' });
  if (r.error?.code !== 'ENOENT') assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('zip writer basics', () => {
  assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
  const buf = createZip([{ name: 'a.txt', data: 'hi' }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50);
});

test('prompt box wraps and places the cursor', () => {
  const chars = Array.from('x'.repeat(30));
  const box = promptBox({ chars, cursor: 30, cols: 27, t: plain });
  assert.equal(box.lines.length, 4);
  for (const l of box.lines) assert.equal(width(l), 26);
  assert.deepEqual(box.cursor, { row: 2, col: 4 + 10 });
});

test('markdown styling and truncation', () => {
  const st = createMarkdownState();
  assert.equal(renderMarkdownLine('- item', st, plain), '• item');
  assert.equal(renderMarkdownLine('```js', st, plain), '┌─ js');
  assert.equal(renderMarkdownLine('- not a bullet', st, plain), '│ - not a bullet');
  assert.equal(renderMarkdownLine('```', st, plain), '└─');
  assert.equal(width(truncate('\x1b[35mhello world\x1b[39m', 6)), 6);
});

test('channel sessions continue only after a good run and only in the same folder', () => {
  const app = { state: { cwd: '/a' } };
  const ch = new ChannelManager(app);
  const s = ch.session('work', 'claude');
  assert.equal(recordRun(s, { code: 1, text: '', sessionId: 'x', cancelled: false }), false);
  assert.equal(s.continued, false);
  assert.equal(s.resumeId, null);
  recordRun(s, { code: 0, text: 'hi', sessionId: 'abc', cancelled: false });
  assert.equal(ch.session('work', 'claude').resumeId, 'abc');
  app.state.cwd = '/b';
  const moved = ch.session('work', 'claude');
  assert.equal(moved.continued, false);
  assert.equal(moved.moved, true);
  assert.equal(ch.session('work', 'claude'), moved);
});

test('interrupt stops the agent and the tools it started', async () => {
  const lines = [];
  const handle = runProcess({ bin: '/bin/sh', args: ['-c', 'echo started; sleep 30 & sleep 30; wait'], onText: (l) => lines.push(l) });
  while (!lines.length) await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  handle.cancel();
  const res = await handle.promise;
  assert.ok(Date.now() - t0 < 4000, 'run ended after interrupt');
  assert.equal(res.cancelled, true);
  assert.deepEqual(lines, ['started']);
});

test('markdown keeps bold intact next to a link', () => {
  const ansi = { bold: (s) => `\x1b[1m${s}\x1b[22m`, underline: (s) => `<u>${s}</u>`, dim: (s) => s, cyan: (s) => s, italic: (s) => s, magenta: (s) => s };
  const out = renderMarkdownLine('- **Point** one [src](https://example.com)', createMarkdownState(), ansi);
  assert.ok(out.includes('\x1b[1mPoint\x1b[22m one <u>src</u> (https://example.com)'), out);
});

test('sanitize keeps colors but drops cursor moves, \\r progress and tabs', () => {
  assert.equal(sanitize('\x1b[31mred\x1b[39m'), '\x1b[31mred\x1b[39m');
  assert.equal(sanitize('a\x1b[2Jb\x1b[1Ac\x1b]52;c;eA==\x07d'), 'abcd');
  assert.equal(sanitize('10%\r50%\r100%'), '100%');
  assert.equal(sanitize('a\tb'), 'a       b');
  assert.equal(sanitize('bell\x07'), 'bell');
});

test('screen draws each frame in one synchronized write', () => {
  const writes = [];
  const screen = new Screen({ columns: 40, rows: 20, write: (s) => writes.push(s) });
  screen.render(['one', 'two'], { row: 0, col: 2 });
  screen.render(['three'], { row: 0, col: 0 });
  assert.equal(writes.length, 2);
  for (const w of writes) assert.ok(w.startsWith('\x1b[?2026h') && w.endsWith('\x1b[?2026l'));
  assert.ok(writes[1].includes('\x1b[J'), 'second frame erases the first');
});

test('app coalesces near-simultaneous render requests', async () => {
  const app = Object.create(App.prototype);
  app.state = { suspended: false };
  app.exited = false;
  app.renderTimer = null;
  let renders = 0;
  app.render = () => {
    renders++;
  };

  app.requestRender();
  app.requestRender();
  assert.equal(renders, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(renders, 1);
});

test('orbit header steps down with the width and falls back to ASCII', async () => {
  const { header } = await import('../src/tui/components/header.js');
  const { pickGlyphs } = await import('../src/tui/theme.js');
  const wide = header({ version: '1.0.0', cwd: '~/w', cols: 100, t: plain });
  assert.equal(wide[1], ".'    ✦    '.◉    cosmodrome v1.0.0");
  assert.ok(wide.every((l) => width(l) <= 99));
  const narrow = header({ version: '1.0.0', cwd: '~/w', cols: 50, t: plain });
  assert.equal(narrow[0], '-(✦)-◉  cosmodrome v1.0.0 · ~/w');
  assert.ok(header({ version: '1', cwd: '~/a/very/long/folder/name/here', cols: 30, t: plain }).every((l) => width(l) <= 29));
  assert.deepEqual(pickGlyphs({ LANG: 'C' }), { star: '*', sat: 'o', idle: '+', ascii: true });
  assert.equal(pickGlyphs({ LANG: 'de_DE.UTF-8' }).star, '✦');
  assert.equal(pickGlyphs({}).star, '✦');
  assert.equal(pickGlyphs({ LANG: 'en_US.UTF-8', COSMO_ASCII: '1' }).ascii, true);
});

test('orbit spinner: satellite passes in front, then behind, and can stand still', async () => {
  const { orbitFrame, ORBIT_FRAMES } = await import('../src/tui/components/spinner.js');
  const glyphs = { star: '✦', sat: '◉' };
  const frames = Array.from({ length: ORBIT_FRAMES }, (_, i) => orbitFrame(i, { t: plain, glyphs }));
  assert.equal(frames[0], '(◉  ✦   )');
  assert.equal(frames[3], '(   ◉   )');
  assert.equal(frames[7], '(   ✦ . )');
  assert.equal(new Set(frames.map((f) => width(f))).size, 1, 'every frame has the same width');
  assert.equal(orbitFrame(5, { t: plain, glyphs }), orbitFrame(5 + ORBIT_FRAMES, { t: plain, glyphs }));
  assert.equal(orbitFrame(null, { t: plain, glyphs }), '(   ✦   )');
});

test('status line and prompt box fit narrow terminals', async () => {
  const { statusLine, shortenPath } = await import('../src/tui/components/statusLine.js');
  const args = { channel: 'work/claude', mode: 'ask', ghUser: 'dino', cwd: '~/work/clients/acme/api', t: plain };
  const wide = statusLine({ ...args, cols: 100 });
  assert.equal(wide[0], '  #work/claude · ask mode · GitHub dino · ~/work/clients/acme/api');
  assert.equal(wide.length, 2);
  const mid = statusLine({ ...args, cols: 60 });
  assert.ok(!mid[0].includes('GitHub') && mid.length === 2);
  const narrow = statusLine({ ...args, cols: 40 });
  assert.equal(narrow.length, 1, 'no key hints below 60 columns');
  for (const cols of [100, 60, 40, 30]) for (const l of statusLine({ ...args, cols })) assert.ok(width(l) <= cols - 1, `${cols}: ${l}`);
  assert.equal(shortenPath('~/work/clients/acme/api', 16), '~/work/…/api');
  const box = promptBox({ chars: [], cursor: 0, cols: 30, t: plain, placeholder: 'Message #work/claude · / for commands' });
  assert.ok(box.lines[1].includes('…') && box.lines.every((l) => width(l) === 29));
});

test('screen erases the right rows after the terminal got narrower', () => {
  const out = { columns: 80, rows: 24, write: () => {} };
  const screen = new Screen(out);
  screen.render(['a'.repeat(79), 'b'.repeat(79), 'c'], { row: 2, col: 1 });
  assert.equal(screen.rowsAboveCursor(), 2);
  out.columns = 40; // the two long lines now wrap to 2 rows each
  assert.equal(screen.rowsAboveCursor(), 4);
});

test('ASCII mode swaps every interface symbol 1:1', () => {
  const writes = [];
  const screen = new Screen({ columns: 40, rows: 20, write: (s) => writes.push(s) }, { ascii: true });
  const box = promptBox({ chars: [], cursor: 0, cols: 40, t: plain, placeholder: 'Message · x' });
  screen.render(['⏺ ↪ ❯ • ✓ ✗ ⎿ …', ...box.lines], { row: 2, col: 4 });
  const drawn = writes[0].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  assert.ok(/^[\x20-\x7e\n\r]*$/.test(drawn), drawn);
  assert.ok(drawn.includes('* > > * v x ` .') && drawn.includes('+------'));
});

test('emoji and combined characters are measured and kept whole', async () => {
  const { graphemes, clusterWidth } = await import('../src/tui/screen.js');
  assert.equal(width('✅'), 2);
  assert.equal(width('❤️'), 2);
  assert.equal(width('👨‍👩‍👧'), 2);
  assert.equal(width('🇩🇪'), 2);
  assert.equal(width('e\u0301'), 1);
  assert.equal(width('✦ ⏺ ↪'), 5, 'interface symbols stay one column');
  assert.deepEqual(graphemes('a👨‍👩‍👧b'), ['a', '👨‍👩‍👧', 'b']);
  assert.equal(clusterWidth('\t'), 1);
  assert.equal(truncate('ab✅cd', 4), 'ab…');
  assert.equal(width(truncate('\x1b]8;;https://x.y\x07link\x1b]8;;\x07 and more text', 6)), 6, 'OSC links take no room');
  const box = promptBox({ chars: graphemes('hi 👨‍👩‍👧 ✅'), cursor: 4, cols: 30, t: plain });
  assert.ok(box.lines.every((l) => width(l) === 29));
  assert.equal(box.cursor.col, 4 + 5);
});

test('orbit map draws a profile with its agents as satellites', async () => {
  const { orbitMap } = await import('../src/tui/components/orbitMap.js');
  const lines = orbitMap({
    profile: 'work',
    agents: [{ name: 'claude', current: true, isDefault: true }, { name: 'copilot' }, { name: 'codex' }, { name: 'opencode' }],
    missing: ['agy'],
    t: plain,
  });
  assert.deepEqual(lines, [
    '             ◉ claude (default)',
    "        .'''      '''.",
    '    ✦  work            ✧ copilot',
    "        '...      ...'",
    '             ✧ codex',
    '    also: ✧ opencode',
    '    not installed: agy',
  ]);
});
