import os from 'node:os';
import { spawn } from 'node:child_process';
import { parseCosmoToolTag } from '../orchestrator.js';

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.query ?? input.url ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description;
  const s = v != null ? String(v) : JSON.stringify(input);
  return s.length > 70 ? s.slice(0, 69) + '…' : s;
}

/**
 * Detect tool calls in plain text / stderr output for agents that don't use claude-json
 * (agy, copilot, codex, opencode, ollama).
 */
export function detectTextToolCall(line) {
  const s = String(line).trim();
  if (!s) return null;
  const tag = parseCosmoToolTag(s);
  if (tag) return { ...tag, consumeLine: true };

  // Heuristic tool patterns emitted by CLI agents (e.g. "⏺ WebSearch(x)", "✓ Read src/a.js")
  const m1 = s.match(/^(?:⏺|●|▸|⚡|Running tool:?)\s*([A-Z][A-Za-z0-9_]+)\(([^)\n]{0,80})\)$/);
  if (m1) return { name: m1[1], detail: m1[2], consumeLine: true };

  const m2 = s.match(/^(?:Reading|Viewing|Searching|Fetching|Executing|Running)\s+(`?[^`\n]{2,70}`?)$/i);
  if (m2) {
    const verb = s.split(/\s+/)[0];
    return { name: verb, detail: m2[1].replace(/`/g, ''), consumeLine: false };
  }
  return null;
}

/**
 * Run an agent CLI (or shell command) without a terminal and stream its output.
 * format 'claude-json' understands Claude Code's stream-json events (text, tool calls, session id);
 * 'text' streams stdout line by line while also surfacing <cosmo:tool> and heuristic tool actions.
 */
export function runProcess({ bin, args, env, cwd, format = 'text', onText, onTool }) {
  // Own process group, so an interrupt also reaches the tools the agent started
  // (a surviving grandchild would keep the output pipe open and the run would never end).
  const child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const texts = [];
  let stderr = '';
  let buf = '';
  let sessionId = null;
  let result = null;
  let cancelled = false;
  let killTimer = null;

  const handleLine = (line) => {
    if (format === 'claude-json') {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        if (line.trim()) {
          texts.push(line);
          onText?.(line);
        }
        return;
      }
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
            onText?.(block.text, { block: true });
          } else if (block.type === 'tool_use') {
            onTool?.(block.name, summarizeInput(block.input));
          }
        }
      } else if (ev.type === 'result') {
        result = ev;
        if (ev.is_error && ev.result && !texts.length) {
          texts.push(String(ev.result));
          onText?.(String(ev.result), { block: true });
        }
      }
      return;
    }

    const detected = detectTextToolCall(line);
    if (detected) {
      onTool?.(detected.name, detected.detail);
      if (detected.consumeLine) return;
    }
    texts.push(line);
    onText?.(line);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-20000);
    for (const l of String(d).split('\n')) {
      const detected = detectTextToolCall(l);
      if (detected) onTool?.(detected.name, detected.detail);
    }
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
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      if (cancelled) signalGroup('SIGKILL'); // leftovers that ignored SIGINT (e.g. background jobs)
      if (buf) handleLine(buf.replace(/\r$/, ''));
      buf = '';
      const exit = code ?? 128 + (os.constants.signals[signal] || 0);
      resolve({ code: exit, stderr, sessionId, result, text: texts.join('\n'), cancelled });
    };
    child.on('error', (error) => {
      done = true;
      resolve({ code: 127, error, stderr, sessionId, result, text: texts.join('\n'), cancelled });
    });
    child.on('close', finish);
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
