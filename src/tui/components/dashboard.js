import { truncate } from '../screen.js';

const statusMark = (status) => {
  if (status === 'completed') return '[x]';
  if (status === 'failed') return '[!]';
  if (status === 'cancelled') return '[-]';
  if (status === 'executing' || status === 'planning') return '[>]';
  return '[ ]';
};

const statusColor = (status, t) => {
  if (status === 'completed') return t.green;
  if (status === 'failed') return t.red;
  if (status === 'cancelled') return t.dim;
  if (status === 'executing' || status === 'planning') return t.yellow;
  return t.dim;
};

function taskLines(tasks, { cols = 80, t, limit = 16 } = {}) {
  const items = Array.isArray(tasks) ? tasks : [];
  const byParent = new Map();
  for (const task of items) {
    const key = task.parentTaskId || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(task);
  }
  const lines = [];
  const visit = (task, prefix, last) => {
    if (lines.length >= limit) return;
    const branch = prefix ? `${prefix}${last ? '`-' : '|-'}` : '';
    const owner = task.assignedAgent ? ` @${task.assignedAgent}` : '';
    const text = `${branch}${statusMark(task.status)} ${task.prompt || task.id}${owner}`;
    lines.push(truncate(`  ${statusColor(task.status, t)(text)}`, Math.max(10, cols - 1)));
    const children = byParent.get(task.id) || [];
    children.forEach((child, index) => visit(child, `${prefix}${last ? '  ' : '| '}`, index === children.length - 1));
  };
  for (const root of byParent.get(null) || []) visit(root, '', true);
  if (!lines.length) lines.push(`  ${t.dim('No saved tasks.')}`);
  else if (items.length > lines.length) lines.push(`  ${t.dim(`... ${items.length - lines.length} more task(s)`)}`);
  return lines;
}

function providerState(row, t) {
  if (row.installed === false) return t.dim('[not installed]');
  return row.throttled ? t.yellow(`[cooldown ${row.cooldownSecs}s]`) : row.errors ? t.yellow('[degraded]') : t.green('[healthy]');
}

export function renderTaskTree(tasks, options = {}) {
  const { t } = options;
  return [t.bold('Task tree'), ...taskLines(tasks, options)];
}

export function renderProviderHealth(rows, { t, cols = 80 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [t.bold('Provider health'), `  ${t.dim('No provider runs recorded yet.')}`];
  return [
    t.bold('Provider health'),
    ...list.map((row) => truncate(
      `  ${row.profile || 'default'}/${row.agent} ${providerState(row, t)} ${row.runs || 0} run(s)${row.lastReason ? ` - ${row.lastReason}` : ''}`,
      Math.max(10, cols - 1),
    )),
  ];
}

export function renderProviderMetrics(rows, { t, cols = 80 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [t.bold('Provider metrics'), `  ${t.dim('No provider metrics recorded yet.')}`];
  const totals = list.reduce((sum, row) => ({
    runs: sum.runs + (Number(row.runs) || 0),
    errors: sum.errors + (Number(row.errors) || 0),
    limits: sum.limits + (Number(row.rateLimits) || 0),
    cost: sum.cost + (Number(row.costUsd) || 0),
    duration: sum.duration + (Number(row.durationMs) || 0),
  }), { runs: 0, errors: 0, limits: 0, cost: 0, duration: 0 });
  return [
    t.bold('Provider metrics'),
    `  runs ${totals.runs} · errors ${totals.errors} · limits ${totals.limits}`,
    `  cost $${totals.cost.toFixed(3)} · duration ${(totals.duration / 1000).toFixed(1)}s`,
    ...list.map((row) => truncate(
      `  ${row.profile || 'default'}/${row.agent}: ${row.runs || 0} runs, ${row.errors || 0} errors, $${(Number(row.costUsd) || 0).toFixed(3)}`,
      Math.max(10, cols - 1),
    )),
  ];
}

export function renderTaskMetrics(tasks, { t } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const completed = list.filter((task) => task.status === 'completed');
  const failed = list.filter((task) => task.status === 'failed');
  const active = list.filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status));
  const durations = completed
    .map((task) => Date.parse(task.updatedAt) - Date.parse(task.createdAt))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const average = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
  const success = completed.length + failed.length ? Math.round((completed.length / (completed.length + failed.length)) * 100) : 0;
  return [
    t.bold('Task metrics'),
    `  active ${active.length} · completed ${completed.length} · failed ${failed.length}`,
    `  success ${success}% · average ${(average / 1000).toFixed(1)}s · total ${list.length}`,
  ];
}

export function renderDashboard({ tasks = [], rows = [], failovers = [], t, cols = 80 } = {}) {
  return [
    t.bold('Cosmodrome dashboard'),
    ...renderTaskTree(tasks, { t, cols }),
    '',
    ...renderTaskMetrics(tasks, { t }),
    '',
    ...renderProviderHealth(rows, { t, cols }),
    '',
    ...renderProviderMetrics(rows, { t, cols }),
    ...(failovers.length ? ['', t.bold('Recent failovers'), ...failovers.slice(-5).map((f) => `  ${f.profile}: @${f.from} -> @${f.to} (${f.reason})`)] : []),
  ];
}
