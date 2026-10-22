import { t } from './theme.js';
import { sanitize } from './screen.js';
import { getAgent } from '../agents.js';
import { failureHint } from '../ui.js';
import { createSubagentTagFilter } from '../orchestrator.js';

/**
 * Turns core protocol events (src/core/events.js) into terminal output: streamed answer text,
 * tool lines, the subagent tree, failover notices and the meta line after each run.
 * State per run lives in app.views (runId -> view); display options in app.display.
 */
function updateSub(app, stepId, patch) {
  const sub = app.state.running?.subagents?.find((x) => x.stepId === stepId);
  if (sub) Object.assign(sub, patch);
  app.requestRender();
}

/** Render one protocol event. Runs with role main/synthesis stream; step runs show in the tree. */
export function renderCoreEvent(app, ev) {
  const s = app.state;
  const d = app.display || {};
  const v = app.views.get(ev.runId);
  switch (ev.type) {
    case 'run_start': {
      const view = { role: ev.role || 'main', agent: ev.agent, stepId: ev.stepId, buf: '', write: null, errors: [], hideTags: createSubagentTagFilter(), startedAt: Date.now() };
      app.views.set(ev.runId, view);
      if (view.role === 'step') updateSub(app, ev.stepId, { agent: ev.agent, status: 'running', action: 'starting…' });
      else if (s.running && view.role !== 'planner') s.running.agent = ev.agent;
      break;
    }
    case 'text': {
      if (!v) break;
      if (v.role === 'step') {
        const line = ev.text.trim().split('\n').pop();
        if (line) updateSub(app, v.stepId, { action: line.slice(0, 36) });
      } else if (v.role !== 'planner' && !d.suppressOutput) streamText(app, v, ev.text, ev.final);
      break;
    }
    case 'tool_start': {
      if (!v) break;
      if (s.running) {
        s.running.action = { name: v.role === 'step' ? `@${ev.agent}:${ev.name}` : ev.name, detail: ev.detail };
        s.running.toolCount = (s.running.toolCount || 0) + 1;
      }
      if (v.role === 'step') updateSub(app, v.stepId, { action: `${ev.name}${ev.detail ? `(${ev.detail.slice(0, 28)})` : ''}` });
      else if (v.role !== 'planner' && !d.suppressOutput) {
        flushText(app, v);
        app.print(`${t.magenta('⏺')} ${t.bold(sanitize(ev.name))}${ev.detail ? t.dim(`(${sanitize(ev.detail)})`) : ''}`);
      }
      app.requestRender();
      break;
    }
    case 'error':
      if (v) v.errors.push(ev);
      else app.print(`  ${t.red('✗')} ${ev.stepId ? `${ev.stepId} @${ev.agent}: ` : ''}${sanitize(ev.message)}`); // a run that never started
      break;
    case 'failover':
      if (ev.role === 'step') updateSub(app, ev.stepId, { agent: ev.to, status: 'switched', action: `${ev.from} limit → @${ev.to}` });
      else if (ev.reason === 'cooldown') app.print(`  ${t.yellow('⟳')} ${t.dim(`@${ev.from} is on usage cooldown — switched silently to`)} ${t.bold(`@${ev.to}`)}`);
      else app.print(`  ${t.yellow('⟳')} ${t.yellow(`@${ev.from} hit a usage limit — switching silently to @${ev.to}`)}`);
      break;
    case 'notice':
      if (ev.kind === 'cooldown_wait') app.print(`  ${t.yellow('⏱')} ${t.dim(ev.message)}`);
      else if (!d.quietMeta) app.print(t.dim(`  ${ev.message}`));
      break;
    case 'plan':
      if (ev.plan.steps.length > 1) {
        if (s.running) {
          s.running.agent = `${ev.plan.steps.length} agents`;
          s.running.subagents = ev.plan.steps.map((st) => ({ stepId: st.id, agent: st.agent, mode: st.mode, prompt: st.prompt, status: 'waiting', action: st.dependsOn.length ? `after ${st.dependsOn.join(', ')}` : 'queued', startedAt: Date.now(), endedAt: null }));
        }
        app.print(`${t.magenta('✦')} ${t.bold('Plan')} ${t.dim(ev.plan.steps.map((st) => `${st.id} @${st.agent} (${st.mode})`).join(' · '))}`);
      }
      break;
    case 'step_start':
      updateSub(app, ev.stepId, { status: 'running', startedAt: Date.now() });
      break;
    case 'step_end': {
      const ok = ev.status === 'done';
      updateSub(app, ev.stepId, { status: ok ? 'done' : 'error', action: ok ? 'completed' : ev.status === 'skipped' ? 'skipped' : `exit ${ev.code}`, endedAt: Date.now() });
      if (s.running?.subagents) {
        const label = ok ? '✓ done' : ev.status === 'skipped' ? '– skipped (an earlier step failed)' : ev.status === 'cancelled' ? '✗ interrupted' : `✗ exit ${ev.code}`;
        app.print(`${t.magenta('✦')} ${t.bold(`@${ev.agent}`)} ${t.dim(`${ev.stepId} ${label}`)}`);
      }
      break;
    }
    case 'run_end':
      if (v && (v.role === 'main' || v.role === 'synthesis')) {
        flushText(app, v);
        printRunMeta(app, v, ev);
      }
      app.views.delete(ev.runId);
      break;
    default:
  }
}

/** Answer text arrives in pieces; print whole lines, and start a new ⏺ block after `final`. */
function streamText(app, v, text, final) {
  const shown = v.hideTags(text);
  if (shown != null) v.buf += shown;
  let i;
  while ((i = v.buf.indexOf('\n')) >= 0) {
    writeLine(app, v, v.buf.slice(0, i));
    v.buf = v.buf.slice(i + 1);
  }
  if (final) flushText(app, v);
}

function writeLine(app, v, line) {
  if (!v.write) v.write = app.makeWriter();
  v.write(line);
}

function flushText(app, v) {
  if (v.buf) writeLine(app, v, v.buf);
  v.buf = '';
  v.write = null;
}

function printRunMeta(app, v, res) {
  const d = app.display || {};
  const meta = [res.agent];
  if (res.toolCount > 0) meta.push(`${res.toolCount} tool${res.toolCount === 1 ? '' : 's'}`);
  const ms = res.usage?.durationMs || Date.now() - v.startedAt;
  if (Math.round(ms / 1000)) meta.push(`${Math.round(ms / 1000)}s`);
  if (res.usage?.costUsd) meta.push(`$${Number(res.usage.costUsd).toFixed(3)}`);
  if (res.cancelled) meta.push('interrupted');
  else if (res.code) meta.push(`exit ${res.code}`);
  const def = getAgent(res.agent, app.config, app.ctx.platform);
  if (!res.text.trim() && !res.cancelled && res.code === 0 && !d.quietMeta) {
    app.print(t.dim(`  (no output)${def?.headless?.emptyHint ? ' ' + def.headless.emptyHint : ''}`));
  }
  if (res.code && !res.cancelled && res.stderr?.trim()) {
    app.print(res.stderr.trim().split('\n').slice(-6).map((l) => `  ${t.red(sanitize(l))}`));
  }
  if (!d.quietMeta) app.print(t.dim(`  ⎿ ${meta.join(' · ')}`));
  if (res.code && !res.cancelled) {
    const output = `${res.stderr || ''}\n${v.errors.map((e) => e.message).join('\n')}\n${res.text}`;
    const hint = failureHint({ agent: res.agent, label: def?.label || res.agent, code: res.code, output });
    app.print(`  ${t.yellow('!')} ${hint}`);
  }
}
