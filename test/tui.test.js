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

const plain = new Proxy({}, { get: () => (s) => String(s) });

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
