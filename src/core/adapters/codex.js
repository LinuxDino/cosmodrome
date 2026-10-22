import { parseJsonLine, runCli } from './base.js';
import { cliArgs } from './args.js';

/**
 * OpenAI Codex CLI: `codex exec --json` prints JSONL events.
 * Flags checked against codex-cli 0.163.0 (`codex exec --help`, `codex exec resume --help`):
 * exec options go before the `resume` subcommand; `resume` takes no --sandbox, so the
 * sandbox is set with `-c sandbox_mode=...`, which both accept. `--full-auto` no longer exists.
 *
 * thread.started -> session     item.started/completed command_execution, file_change,
 * mcp_tool_call, web_search -> tool_start/tool_end     agent_message -> text
 * turn.completed -> usage       turn.failed -> error
 */
const TOOL_ITEMS = {
  command_execution: (i) => ['Bash', i.command],
  file_change: (i) => ['Edit', (i.changes || []).map((c) => c.path).join(', ')],
  mcp_tool_call: (i) => [`${i.server || 'mcp'}.${i.tool || 'tool'}`, ''],
  web_search: (i) => ['WebSearch', i.query],
};

export const codex = {
  name: 'codex',
  checkedWith: 'codex-cli 0.163.0',
  capabilities: () => ({ structured: true, streaming: true, resume: true, readOnlyMode: true }),
  buildArgs: cliArgs,
  createParser() {
    let lastError = null;
    return {
      line(line, run) {
        const ev = parseJsonLine(line);
        if (!ev) return; // codex only prints JSON on stdout in --json mode
        const item = ev.item || {};
        const tool = TOOL_ITEMS[item.type];
        switch (ev.type) {
          case 'thread.started':
            run.session(ev.thread_id);
            break;
          case 'item.started':
            if (tool) run.toolStart(item.id, ...tool(item));
            break;
          case 'item.completed':
            if (item.type === 'agent_message') run.text(item.text || '', { final: true });
            else if (tool) {
              run.toolStart(item.id, ...tool(item));
              const ok = item.status ? item.status === 'completed' : item.exit_code == null || item.exit_code === 0;
              run.toolEnd(item.id, ok && (item.exit_code == null || item.exit_code === 0));
            }
            break;
          case 'turn.completed':
            run.usage({ inputTokens: ev.usage?.input_tokens, outputTokens: ev.usage?.output_tokens });
            break;
          case 'turn.failed':
            run.error(ev.error?.message || lastError || 'Codex turn failed');
            lastError = null;
            break;
          case 'error':
            // "Reconnecting... 2/5" and similar: only the last one matters if the turn fails.
            lastError = ev.message;
            break;
          default:
        }
      },
      end(res, run) {
        if (lastError && res.code !== 0 && !res.cancelled) run.error(lastError);
      },
    };
  },
  run(opts) {
    return runCli(this, opts);
  },
};
