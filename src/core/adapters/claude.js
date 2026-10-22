import { parseJsonLine, summarizeInput, runCli } from './base.js';
import { cliArgs } from './args.js';

/**
 * Claude Code: `-p --output-format stream-json --verbose --include-partial-messages`.
 * Flags checked against Claude Code 2.1.308 (`claude --help`).
 *
 * stream_event text_delta  -> text (token streaming)
 * assistant tool_use       -> tool_start      user tool_result -> tool_end
 * session_id               -> session         result           -> usage (+ error)
 */
export const claude = {
  name: 'claude',
  checkedWith: 'Claude Code 2.1.308',
  capabilities: () => ({ structured: true, streaming: true, resume: true, readOnlyMode: true }),
  buildArgs: cliArgs,
  createParser() {
    const streamed = new Set(); // message ids whose text came as deltas
    const openBlocks = new Map(); // index -> type, for the message being streamed
    return {
      line(line, run) {
        const ev = parseJsonLine(line);
        if (!ev) {
          if (line.trim()) run.text(line, { final: true });
          return;
        }
        if (ev.session_id) run.session(ev.session_id);
        // Messages of Claude's own subagents (Task tool) are not part of the answer.
        const nested = ev.parent_tool_use_id != null;
        if (ev.type === 'stream_event') {
          if (nested) return;
          const e = ev.event || {};
          if (e.type === 'content_block_start') {
            openBlocks.set(e.index, e.content_block?.type);
          } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            if (ev.api_message_id) streamed.add(ev.api_message_id);
            run.text(e.delta.text);
          } else if (e.type === 'content_block_stop') {
            if (openBlocks.get(e.index) === 'text') run.text('', { final: true });
            openBlocks.delete(e.index);
          }
        } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text && !nested && !streamed.has(ev.message.id)) {
              run.text(block.text, { final: true });
            } else if (block.type === 'tool_use') {
              run.toolStart(block.id, block.name, summarizeInput(block.input));
            }
          }
        } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'tool_result') run.toolEnd(block.tool_use_id, !block.is_error);
          }
        } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected') {
          run.usage({ limitHit: true });
        } else if (ev.type === 'result') {
          run.usage({
            inputTokens: ev.usage?.input_tokens,
            outputTokens: ev.usage?.output_tokens,
            costUsd: ev.total_cost_usd,
            durationMs: ev.duration_ms,
          });
          if (ev.is_error) {
            const msg = String(ev.result || ev.subtype || 'Claude reported an error');
            if (!run.hasText && ev.result) run.text(String(ev.result), { final: true });
            run.error(msg);
          }
        }
      },
    };
  },
  run(opts) {
    return runCli(this, opts);
  },
};
