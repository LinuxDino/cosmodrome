import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun } from './base.js';

/**
 * Replays a recorded run (test/fixtures/<agent>/<case>.jsonl or .txt) through the real
 * parser of that agent, with realistic timing. For tests and for working on the interface
 * without accounts: COSMO_MOCK=1 replays <agent>/simple for every agent, COSMO_MOCK=<case>
 * picks another case. COSMO_MOCK_DIR points at other fixtures, COSMO_MOCK_DELAY sets ms per line.
 *
 * Next to the output file: <case>.exit (exit code, default 0) and <case>.stderr.
 */
export const FIXTURES_DIR = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));

export function loadFixture(name, dir = FIXTURES_DIR) {
  const base = path.join(dir, name);
  const file = ['.jsonl', '.txt'].map((ext) => base + ext).find((f) => fs.existsSync(f));
  if (!file) throw new Error(`no fixture "${name}" in ${dir}`);
  const read = (ext) => {
    try {
      return fs.readFileSync(base + ext, 'utf8');
    } catch {
      return null;
    }
  };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { lines, code: Number(read('.exit') ?? 0) || 0, stderr: read('.stderr') || '' };
}

export function createMockAdapter(getAdapter) {
  return {
    name: 'mock',
    checkedWith: 'recorded fixtures',
    capabilities: () => ({ structured: true, streaming: true, resume: false, readOnlyMode: true }),
    run(opts) {
      const env = opts.profileEnv || process.env;
      const replayName = opts.replay || (opts.agent && opts.agent !== 'mock' ? opts.agent : 'claude');
      const explicit = opts.fixture || env.COSMO_MOCK_FIXTURE;
      const dir = opts.fixtureDir || env.COSMO_MOCK_DIR || FIXTURES_DIR;
      let fixture = explicit || `${replayName}/${mockCase(env)}`;
      // A case an agent has no recording for falls back to its simple answer.
      if (!explicit && !hasFixture(fixture, dir)) fixture = `${replayName}/simple`;
      const replayAgent = fixture.split('/')[0];
      const delay = Number(opts.delayMs ?? env.COSMO_MOCK_DELAY ?? 15);
      const agent = opts.agent || replayAgent;
      const run = createRun({ agent, mode: opts.mode, prompt: opts.displayPrompt ?? opts.prompt, role: opts.role, onEvent: opts.onEvent, runId: opts.runId, extra: opts.extra });
      run.start();
      let cancelled = false;
      let wake = null;
      const sleep = (ms) => new Promise((r) => {
        wake = r;
        setTimeout(r, ms);
      });
      const promise = (async () => {
        let data;
        try {
          data = loadFixture(fixture, dir);
        } catch (err) {
          run.error(err.message, 'crash');
          return run.finish({ code: 127 });
        }
        const replay = getAdapter(replayAgent);
        const parser = replay?.createParser ? replay.createParser(opts) : null;
        for (const line of data.lines) {
          if (cancelled) break;
          if (delay > 0) await sleep(delay);
          if (cancelled) break;
          if (parser) parser.line(line, run);
          else run.text(line, { final: true });
        }
        const res = cancelled ? { code: 130, cancelled: true, stderr: '' } : { code: data.code, cancelled: false, stderr: data.stderr };
        parser?.end?.(res, run);
        return run.finish(res);
      })();
      const cancel = () => {
        cancelled = true;
        run.cancelRequested();
        wake?.();
      };
      return { promise, cancel, signal: cancel, runId: run.runId };
    },
  };
}

function hasFixture(name, dir) {
  return ['.jsonl', '.txt'].some((ext) => fs.existsSync(path.join(dir, name + ext)));
}

function mockCase(env) {
  const v = String(env.COSMO_MOCK || '');
  return !v || v === '1' || v === 'true' ? 'simple' : v;
}
