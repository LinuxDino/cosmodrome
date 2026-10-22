import { spawnProcess } from '../core/adapters/base.js';
import { parseCosmoToolTag } from '../core/adapters/text.js';

/**
 * An explicit `<cosmo:tool name="…" detail="…" />` line. Tool calls are never guessed from
 * ordinary wording ("Reading foo", "⏺ Name(x)"): plain text is better than a wrong tool line.
 */
export function detectTextToolCall(line) {
  const tag = parseCosmoToolTag(String(line).trim());
  return tag ? { ...tag, consumeLine: true } : null;
}

/**
 * Run a shell command (or any process) without a terminal and stream its stdout line by line.
 * Agents run through src/core/adapters; this is for `!command` and similar.
 */
export function runProcess({ bin, args, env, cwd, onText }) {
  const lines = [];
  const proc = spawnProcess({
    bin,
    args,
    env,
    cwd,
    onLine: (line) => {
      lines.push(line);
      onText?.(line);
    },
  });
  const promise = proc.promise.then((res) => ({ ...res, text: lines.join('\n') }));
  return { promise, cancel: proc.cancel, signal: proc.signal, child: proc.child };
}
