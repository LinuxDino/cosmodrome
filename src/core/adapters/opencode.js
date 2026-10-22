import { parseJsonLine, summarizeInput, runCli } from './base.js';
import { cliArgs } from './args.js';

/**
 * OpenCode: `opencode run --format json` prints one JSON event per line.
 * Flags checked against opencode 1.19.3 (`opencode run --help`).
 * Tool parts arrive once they have finished, so tool_start and tool_end come together.
 *
 * text -> text    tool_use -> tool_start + tool_end    step_finish -> usage
 * sessionID -> session    error -> error
 */
export const opencode = {
  name: 'opencode',
  checkedWith: 'opencode 1.19.3',
  capabilities: () => ({ structured: true, streaming: true, resume: true, readOnlyMode: true }),
  buildArgs: cliArgs,
  createParser() {
    return {
      line(line, run) {
        const ev = parseJsonLine(line);
        if (!ev) {
          if (line.trim()) run.text(line, { final: true });
          return;
        }
        if (ev.sessionID) run.session(ev.sessionID);
        const part = ev.part || {};
        if (ev.type === 'text' && part.text) {
          run.text(part.text, { final: true });
        } else if (ev.type === 'tool_use') {
          const id = part.callID || part.id;
          const status = part.state?.status;
          run.toolStart(id, part.tool, summarizeInput(part.state?.input));
          if (status === 'completed' || status === 'error') run.toolEnd(id, status === 'completed');
        } else if (ev.type === 'step_finish') {
          run.usage({ inputTokens: part.tokens?.input, outputTokens: part.tokens?.output, costUsd: part.cost || undefined });
        } else if (ev.type === 'error') {
          const e = ev.error || {};
          run.error(e.data?.message || e.message || e.name || 'OpenCode reported an error');
        }
      },
    };
  },
  run(opts) {
    return runCli(this, opts);
  },
};
