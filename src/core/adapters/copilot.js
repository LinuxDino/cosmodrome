import { parseJsonLine, summarizeInput, runCli } from './base.js';
import { cliArgs } from './args.js';

/**
 * GitHub Copilot CLI: `copilot -p … --output-format json --stream on` prints JSONL events.
 * Flags checked against GitHub Copilot CLI 1.0.98 (`copilot --help`).
 *
 * assistant.message_delta -> text (streaming)   assistant.message -> text when not streamed
 * tool.execution_start/complete -> tool_start/tool_end
 * result -> session + usage                     *.error / session.error -> error
 */
export const copilot = {
  name: 'copilot',
  checkedWith: 'GitHub Copilot CLI 1.0.98',
  capabilities: () => ({ structured: true, streaming: true, resume: true, readOnlyMode: true }),
  buildArgs: cliArgs,
  createParser() {
    const streamed = new Set();
    let open = null; // message id whose deltas are being written
    return {
      line(line, run) {
        const ev = parseJsonLine(line);
        if (!ev) {
          if (line.trim()) run.text(line, { final: true });
          return;
        }
        const d = ev.data || {};
        switch (ev.type) {
          case 'assistant.message_delta':
            if (open && open !== d.messageId) run.endBlock();
            open = d.messageId;
            streamed.add(d.messageId);
            run.text(d.deltaContent || '');
            break;
          case 'assistant.message':
            if (open === d.messageId) {
              run.endBlock();
              open = null;
            } else if (d.content && !streamed.has(d.messageId)) run.text(d.content, { final: true });
            break;
          case 'tool.execution_start':
            run.toolStart(d.toolCallId, d.toolName, summarizeInput(d.arguments));
            break;
          case 'tool.execution_complete':
            run.toolEnd(d.toolCallId, d.success !== false, d.error?.message);
            break;
          case 'result':
            run.session(ev.sessionId);
            run.usage({ premiumRequests: ev.usage?.premiumRequests, durationMs: ev.usage?.sessionDurationMs });
            break;
          default:
            if (/(^|\.)error$/.test(ev.type || '')) run.error(d.message || d.error?.message || ev.message || 'Copilot reported an error');
        }
      },
    };
  },
  run(opts) {
    return runCli(this, opts);
  },
};
