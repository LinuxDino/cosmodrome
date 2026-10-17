import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function id() {
  return `task-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function safeRead(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readEvents(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  });
}

/**
 * Small durable task journal. It deliberately uses JSON and built-in Node APIs so
 * the task state works in the same portable, zero-dependency environments as Cosmo.
 */
export class TaskStore {
  constructor(root) {
    this.root = root;
    this.tasksFile = path.join(root, 'tasks.json');
    this.eventsFile = path.join(root, 'events.jsonl');
    this.tasks = safeRead(this.tasksFile, {});
    this.eventsByTask = new Map();
    for (const event of readEvents(this.eventsFile)) {
      const taskId = event?.taskId;
      const events = this.eventsByTask.get(taskId);
      if (events) events.push(event);
      else this.eventsByTask.set(taskId, [event]);
    }
  }

  create(input) {
    const now = new Date().toISOString();
    const task = {
      id: id(),
      prompt: String(input.prompt || ''),
      cwd: input.cwd || process.cwd(),
      profile: input.profile || 'default',
      mode: input.mode || 'auto',
      status: 'queued',
      phase: 'queued',
      createdAt: now,
      updatedAt: now,
      retryAt: null,
      checkpoint: null,
      lastError: null,
      parentTaskId: input.parentTaskId || null,
      assignedAgent: input.assignedAgent || null,
      origin: input.origin || 'user',
    };
    this.tasks[task.id] = task;
    this.save();
    this.event(task.id, 'task.created', { prompt: task.prompt });
    return task;
  }

  get(taskId) {
    return this.tasks[taskId] || null;
  }

  children(taskId) {
    return this.list({ activeOnly: false }).filter((task) => task.parentTaskId === taskId);
  }

  list({ activeOnly = false } = {}) {
    return Object.values(this.tasks)
      .filter((task) => !activeOnly || !['completed', 'cancelled'].includes(task.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  update(taskId, patch, eventType = 'task.updated') {
    const task = this.get(taskId);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.save();
    this.event(taskId, eventType, patch);
    return task;
  }

  checkpoint(taskId, checkpoint) {
    return this.update(taskId, { checkpoint }, 'task.checkpoint');
  }

  event(taskId, type, data = {}) {
    fs.mkdirSync(path.dirname(this.eventsFile), { recursive: true, mode: 0o700 });
    const event = { id: id(), taskId, type, timestamp: new Date().toISOString(), ...data };
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n', { mode: 0o600 });
    const events = this.eventsByTask.get(event.taskId);
    if (events) events.push(event);
    else this.eventsByTask.set(event.taskId, [event]);
  }

  events(taskId, limit = 100) {
    return (this.eventsByTask.get(taskId) || []).slice(-limit);
  }

  recover() {
    const recovered = [];
    for (const task of this.list({ activeOnly: true })) {
      if (task.status === 'executing' || task.status === 'planning') {
        this.update(task.id, {
          status: 'queued',
          phase: 'recovery',
          lastError: 'Cosmo restarted while this task was active.',
        }, 'task.recovered');
        recovered.push(task);
      }
    }
    return recovered;
  }

  save() {
    writeJson(this.tasksFile, this.tasks);
  }
}
