import os from 'node:os';
import { spawn } from 'node:child_process';

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.query ?? input.url ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.description;
  const s = v != null ? String(v) : JSON.stringify(input);
  return s.length > 70 ? s.slice(0, 69) + '…' : s;
}

/**
 * Run an agent CLI (or shell command) without a terminal and stream its output.
 * format 'claude-json' understands Claude Code's stream-json events (text, tool calls, session id);
 * 'text' streams stdout line by line.
 */
export function runProcess({ bin, args, env, cwd, format = 'text', onText, onTool }) {
  const child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
  });

  const promise = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: 127, error, stderr, sessionId, result, text: texts.join('\n'), cancelled }));
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (buf) handleLine(buf.replace(/\r$/, ''));
      buf = '';
      const exit = code ?? 128 + (os.constants.signals[signal] || 0);
      resolve({ code: exit, stderr, sessionId, result, text: texts.join('\n'), cancelled });
    });
  });

  const cancel = () => {
    cancelled = true;
    try {
      child.kill('SIGINT');
    } catch {
      /* gone */
    }
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, 2500);
  };

  return { promise, cancel, child };
}
