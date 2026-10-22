import { runCli } from './base.js';
import { cliArgs } from './args.js';

/**
 * Plain-text adapter for agents without a structured mode (custom agents from config).
 * Every stdout line is answer text (one block per run). Tool lines are never guessed from wording; only an
 * explicit `<cosmo:tool name="…" detail="…" />` line counts as a tool step.
 */
export const text = {
  name: 'text',
  checkedWith: 'any CLI that prints its answer on stdout',
  capabilities: () => ({ structured: false, streaming: true, resume: false, readOnlyMode: false }),
  buildArgs: cliArgs,
  createParser() {
    let steps = 0;
    return {
      line(line, run) {
        const tag = parseCosmoToolTag(line);
        if (tag) {
          const id = `step_${++steps}`;
          run.toolStart(id, tag.name, tag.detail);
          run.toolEnd(id, true);
          return;
        }
        run.text(`${line}\n`);
      },
      end(res, run) {
        run.endBlock();
      },
    };
  },
  run(opts) {
    return runCli(this, opts);
  },
};

/**
 * Parse `<cosmo:tool name="Read" detail="src/app.js" />` tags from AI output.
 */
export function parseCosmoToolTag(line) {
  const m = String(line).match(/<cosmo:tool\s+([^>]*?)\/?>/i);
  if (!m) return null;
  const attrs = m[1];
  const name = attrs.match(/name=["']([^"']+)["']/i)?.[1] || 'Step';
  const detail = attrs.match(/detail=["']([^"']+)["']/i)?.[1] || '';
  return { name, detail };
}
