import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeEvent, classifyError, newRunId } from '../events.js';
import { isUsageLimit } from '../../usage.js';

/** Short label for a tool's input: the query, path or command it works on. */
export function summarizeInput(input) {
  if (input == null) return '';
  if (typeof input !== 'object') return clip(String(input));
  const v = input.query ?? input.url ?? input.command ?? input.file_path ?? input.filePath ?? input.path ?? input.Path ?? input.pattern ?? input.description;
  return clip(v != null ? String(v) : JSON.stringify(input));
}

function clip(s, max = 70) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Start a process in its own process group and hand its stdout to `onLine`, line by line.
 * Cancel: SIGINT to the group, SIGKILL after 2.5 s; a second cancel kills at once.
 * Resolves { code, signal, stderr, cancelled, error }.
 */
export function spawnProcess({ bin, args, env, cwd, onLine, onStderr, record = null }) {
  // Own process group, so an interrupt also reaches the tools the agent started
  // (a surviving grandchild would keep the output pipe open and the run would never end).
  const child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  let buf = '';
  let cancelled = false;
  let killTimer = null;
  const rec = record ? openRecorder(record) : null;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    rec?.stdout(d);
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine?.(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    rec?.stderr(d);
    stderr = (stderr + d).slice(-20000);
    onStderr?.(d);
  });

  const signalGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    }
  };

  let closeTimer = null;
  const promise = new Promise((resolve) => {
    let done = false;
    const finish = (code, signal, error = null) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      if (cancelled) signalGroup('SIGKILL'); // leftovers that ignored SIGINT (e.g. background jobs)
      if (buf) onLine?.(buf.replace(/\r$/, ''));
      buf = '';
      const exit = error ? 127 : code ?? 128 + (os.constants.signals[signal] || 0);
      rec?.close(exit);
      resolve({ code: exit, signal, stderr, cancelled, error });
    };
    child.on('error', (error) => finish(127, null, error));
    child.on('close', (code, signal) => finish(code, signal));
    // Something that left our process group may still hold the pipes: stop waiting for them.
    child.on('exit', (code, signal) => {
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, 1000);
    });
  });

  const cancel = () => {
    if (cancelled) return signalGroup('SIGKILL'); // second Esc: no more waiting
    cancelled = true;
    signalGroup('SIGINT');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), 2500);
  };

  return { promise, cancel, signal: signalGroup, child };
}

/** COSMO_RECORD=dir: keep the raw stdout/stderr of every run there (for new test fixtures). */
function openRecorder({ dir, name }) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  const base = path.join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const append = (file, d) => {
    try {
      fs.appendFileSync(file, d, { mode: 0o600 });
    } catch {
      /* best effort */
    }
  };
  return {
    stdout: (d) => append(`${base}.stdout`, d),
    stderr: (d) => append(`${base}.stderr`, d),
    close: (code) => append(`${base}.exit`, `${code}\n`),
  };
}

export function recordTarget(env, agent) {
  const dir = env?.COSMO_RECORD || process.env.COSMO_RECORD;
  return dir ? { dir, name: agent } : null;
}

/**
 * Event builder for one run. Adapters call text/toolStart/toolEnd/session/usage/error;
 * finish() emits run_end and returns the result (the same object as the run_end event).
 */
export function createRun({ agent, mode = 'ask', prompt = '', role = 'main', onEvent, runId = newRunId(), extra = {} }) {
  const blocks = [];
  let current = '';
  const tools = new Map();
  const errors = [];
  const usage = {};
  let sessionId = null;
  let limitHit = false;
  let cancelling = false;
  const base = { runId, agent, ...extra };
  const emit = (type, fields = {}) => {
    const ev = makeEvent(type, { ...base, ...fields });
    try {
      onEvent?.(ev);
    } catch {
      /* a broken listener must not break the run */
    }
    return ev;
  };

  const run = {
    runId,
    agent,
    get sessionId() {
      return sessionId;
    },
    start() {
      emit('run_start', { mode, prompt, role });
    },
    /** Append answer text. `final` closes the current block (a paragraph or message). */
    text(text, { final = false } = {}) {
      const s = String(text ?? '');
      if (!s && !final) return;
      current += s;
      emit('text', { text: s, ...(final ? { final: true } : {}) });
      if (final) {
        blocks.push(current.replace(/\n+$/, ''));
        current = '';
      }
    },
    endBlock() {
      if (current) run.text('', { final: true });
    },
    get hasText() {
      return Boolean(blocks.length || current);
    },
    toolStart(toolId, name, detail = '') {
      const id = String(toolId ?? `tool_${tools.size + 1}`);
      if (tools.has(id)) return;
      tools.set(id, { name, ended: false });
      emit('tool_start', { toolId: id, name: String(name || 'Tool'), detail: String(detail || '') });
    },
    toolEnd(toolId, ok, detail) {
      const id = String(toolId);
      const t = tools.get(id);
      if (!t || t.ended) return;
      t.ended = true;
      emit('tool_end', { toolId: id, ok: Boolean(ok), ...(detail ? { detail: String(detail) } : {}) });
    },
    session(id) {
      if (!id || id === sessionId) return;
      sessionId = String(id);
      emit('session', { sessionId });
    },
    usage(u = {}) {
      for (const [k, v] of Object.entries(u)) {
        if (v == null) continue;
        if (k === 'limitHit') limitHit = limitHit || Boolean(v);
        else if (typeof v === 'number' && ['inputTokens', 'outputTokens'].includes(k)) usage[k] = (usage[k] || 0) + v;
        else usage[k] = v;
      }
      emit('usage', u);
    },
    /** After an interrupt, agents report "cancelled"/"context canceled": that is not an error. */
    cancelRequested() {
      cancelling = true;
    },
    error(message, kind) {
      if (cancelling && kind !== 'crash') return;
      const k = kind || classifyError(message);
      if (k === 'limit') limitHit = true;
      errors.push({ message: String(message), kind: k });
      emit('error', { message: String(message), kind: k });
    },
    finish({ code = 0, cancelled = false, stderr = '', error = null } = {}) {
      run.endBlock();
      for (const [id, t] of tools) if (!t.ended) run.toolEnd(id, !cancelled && code === 0);
      const text = blocks.join('\n');
      if (error) run.error(error.code === 'ENOENT' ? `${agent} was not found` : String(error.message || error), 'crash');
      if (!cancelled && code !== 0 && !limitHit) {
        const detail = `${stderr}\n${errors.map((e) => e.message).join('\n')}\n${text}`;
        if (isUsageLimit({ code, stderr, text: detail })) {
          limitHit = true;
          if (!errors.some((e) => e.kind === 'limit')) run.error(lastLine(stderr) || 'usage limit', 'limit');
        } else if (!errors.length) {
          run.error(lastLine(stderr) || `exit ${code}`, classifyError(detail, { code }));
        }
      }
      return emit('run_end', {
        code,
        cancelled,
        text,
        sessionId,
        usage: { ...usage },
        limitHit,
        stderr: String(stderr || '').slice(-4000),
        errorKind: errors[errors.length - 1]?.kind || null,
        toolCount: tools.size,
      });
    },
  };
  return run;
}

function lastLine(s) {
  return String(s || '').trim().split('\n').pop()?.trim() || '';
}

/**
 * Run a CLI agent: spawn `bin args`, feed stdout lines to `parser.line(line, run)`, and finish.
 * Adapters supply `buildArgs(opts)` and `createParser()`.
 */
export function runCli(adapter, opts) {
  const { bin, cwd, profileEnv, onEvent, agent = adapter.name, mode = 'ask', prompt = '', role = 'main', runId, extra } = opts;
  const run = createRun({ agent, mode, prompt: opts.displayPrompt ?? prompt, role, onEvent, runId, extra });
  const parser = adapter.createParser(opts);
  run.start();
  const proc = spawnProcess({
    bin,
    args: adapter.buildArgs(opts),
    env: profileEnv,
    cwd,
    record: recordTarget(profileEnv, agent),
    onLine: (line) => {
      try {
        parser.line(line, run);
      } catch (err) {
        run.error(`could not read ${agent} output: ${err.message}`, 'parse');
      }
    },
  });
  const promise = proc.promise.then((res) => {
    parser.end?.(res, run);
    return run.finish(res);
  });
  const cancel = () => {
    run.cancelRequested();
    proc.cancel();
  };
  return { promise, cancel, signal: proc.signal, runId: run.runId };
}

/** JSON.parse a JSONL line; non-JSON lines come back as null. */
export function parseJsonLine(line) {
  const s = String(line).trim();
  if (!s.startsWith('{')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
