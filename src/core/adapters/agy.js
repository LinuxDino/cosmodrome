import { parseJsonLine, summarizeInput, runCli } from './base.js';
import { cliArgs } from './args.js';

/**
 * Antigravity CLI: `agy -p … --output-format stream-json` prints NDJSON events.
 * Flags checked against agy 1.4.5 (`agy --help`); `--conversation <id>` resumes.
 *
 * init -> session    step_update tool ACTIVE/DONE -> tool_start/tool_end
 * step_update agent_response text_delta -> text   result -> usage (+ error unless SUCCESS)
 */
export const agy = {
  name: 'agy',
  checkedWith: 'agy 1.4.5',
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
        if (ev.conversation_id) run.session(ev.conversation_id);
        if (ev.event === 'step_update') {
          const s = ev.step_update || {};
          if (s.conversation_id) run.session(s.conversation_id);
          if (s.step_type === 'tool') {
            const id = `step_${s.step_index}`;
            run.toolStart(id, s.tool_name || s.tool_info?.name, summarizeInput(s.tool_info?.parameters));
            if (s.state === 'DONE') run.toolEnd(id, true);
            else if (/ERROR|FAIL|CANCEL/.test(s.state || '')) run.toolEnd(id, false);
          } else if (s.step_type === 'agent_response' && s.text_delta) {
            run.text(s.text_delta);
            if (s.state === 'DONE') run.endBlock();
          }
        } else if (ev.event === 'result') {
          const r = ev.result || {};
          run.session(r.conversation_id);
          if (!run.hasText && r.response) run.text(r.response, { final: true });
          run.usage({ inputTokens: r.usage?.input_tokens, outputTokens: r.usage?.output_tokens, durationMs: r.duration_seconds != null ? Math.round(r.duration_seconds * 1000) : undefined });
          if (r.status && r.status !== 'SUCCESS') run.error(r.error?.message || r.error || `agy finished with ${r.status}`);
        } else if (ev.event === 'error') {
          run.error(ev.error?.message || ev.message || 'agy reported an error');
        }
      },
    };
  },
  run(opts) {
    return runCli(this, opts);
  },
};
