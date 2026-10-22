import { EventEmitter } from 'node:events';
import { getAgent, agentNames, canonicalAgentName, agentModel } from '../agents.js';
import { enrichPrompt, AGENT_ROLES } from '../context.js';
import { tildify } from '../paths.js';
import { CosmoError } from '../ui.js';
import { makeEvent, newRunId } from './events.js';
import { getAdapter } from './adapters/index.js';
import { validatePlan, planWithOllama, routerPlan, plannerChoice, parsePlanJson, plannerPrompt } from './planner.js';
import { executePlan } from './executor.js';

/** The mode a run actually gets: a request can lower the session's mode, never raise it. */
export function clampMode(sessionMode, requested) {
  if (requested === 'ask') return 'ask';
  if (requested === 'auto') return sessionMode === 'auto' ? 'auto' : 'ask';
  return sessionMode;
}

/**
 * Remember a finished run so the next message continues it. A failed run (not signed in,
 * bad flag, ...) leaves the conversation untouched, so we never resume one that was never created.
 */
export function recordRun(conversation, res) {
  conversation.moved = false;
  const usable = res.code === 0 || (res.cancelled && res.text.trim());
  if (!usable) return false;
  conversation.continued = true;
  if (res.sessionId) conversation.resumeId = res.sessionId;
  return true;
}

/**
 * The core of cosmo: one user's session (mode, folder, channel, conversations, runs).
 * Everything that happens is emitted as protocol events (`session.on('event', fn)`, see
 * src/core/events.js); nothing here writes to the terminal. The TUI, and later a daemon or
 * an app, only render those events.
 *
 * host: { config(), env, platform, paths, isInstalled(agent), resolveBin(agentDef),
 *         profilePlan(profile, agentDef) -> { env, mcpConfig }, localModel(agentDef), fetch? }
 */
export class CoreSession extends EventEmitter {
  constructor({ host, usage, tasks, mode = 'auto', cwd = process.cwd() }) {
    super();
    this.host = host;
    this.usage = usage;
    this.tasks = tasks;
    this.mode = mode;
    this.cwd = cwd;
    this.channel = null; // { profile, agent }
    this.conversations = new Map();
    this.active = new Set();
    this.cancelled = false;
    this.wakers = new Set();
  }

  get config() {
    return this.host.config();
  }

  get running() {
    return this.active.size > 0;
  }

  emitEvent(ev) {
    this.emit('event', ev);
  }

  notice(message, fields = {}) {
    this.emitEvent(makeEvent('notice', { message, ...fields }));
  }

  requireChannel() {
    if (!this.channel) throw new CosmoError('No channel yet.', { hint: 'Run /init or /channel profile/agent.' });
    return this.channel;
  }

  installedAgents() {
    return agentNames(this.config).filter((a) => this.host.isInstalled(a));
  }

  /**
   * Conversation state of a channel in a folder. Agents store conversations per folder
   * (Claude can't --resume a session from another folder), so a new folder starts fresh;
   * `moved` says that an earlier conversation was left behind.
   */
  conversation(profile = this.channel?.profile, agent = this.channel?.agent, cwd = this.cwd) {
    const key = `${profile}/${agent}`;
    const old = this.conversations.get(key);
    if (old && old.cwd === cwd) return old;
    const fresh = { continued: false, resumeId: null, cwd, moved: Boolean(old?.continued) };
    this.conversations.set(key, fresh);
    return fresh;
  }

  resetConversation(profile = this.channel?.profile, agent = this.channel?.agent) {
    this.conversations.delete(`${profile}/${agent}`);
  }

  cancel() {
    this.cancelled = true;
    for (const h of this.active) h.cancel?.();
    for (const w of this.wakers) w();
  }

  /** Pass a signal on to every running agent (terminal closing, crash). */
  signal(sig) {
    for (const h of this.active) h.signal?.(sig);
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  /**
   * Run one agent with silent failover: an agent on cooldown is swapped before the run, and
   * one that hits a usage limit is swapped for the next healthy agent. Resolves the run_end
   * result plus { agent, label, durationMs }.
   * role: main | step | synthesis | planner. Steps and the planner start fresh conversations.
   */
  async run(opts) {
    const { prompt, mode, role = 'main', enrich = true, stepId = null, taskId = null, tried = new Set(), waited = false } = opts;
    const fresh = opts.fresh ?? (role === 'step' || role === 'planner');
    const ch = this.requireChannel();
    let name = canonicalAgentName(opts.agent || ch.agent, this.config) || opts.agent || ch.agent;
    const runId = newRunId();

    if (this.usage.isThrottled(ch.profile, name)) {
      const picked = this.usage.pickAgent({ profile: ch.profile, preferred: name, candidates: agentNames(this.config), isInstalled: (a) => this.host.isInstalled(a), exclude: tried });
      if (picked.switched) {
        this.emitEvent(makeEvent('failover', { runId, from: name, to: picked.agent, reason: 'cooldown', role, ...(stepId ? { stepId } : {}) }));
        name = picked.agent;
      }
    }

    const def = getAgent(name, this.config, this.host.platform);
    if (!def) throw new CosmoError(`Unknown agent "${name}".`, { hint: `Agents: ${agentNames(this.config).join(', ')}` });
    const adapter = getAdapter(def, this.host.env);
    if (!adapter) throw new CosmoError(`${def.label} has no one-shot mode configured.`, { hint: 'Use /native, or add "headless" to the agent in cosmo config edit.' });
    const needsBin = !['ollama', 'mock'].includes(adapter.name);
    const bin = needsBin ? this.host.resolveBin(def) : null;
    const runMode = clampMode(this.mode, mode);
    const plan = this.host.profilePlan(ch.profile, def);
    const convo = fresh ? { continued: false, resumeId: null } : this.conversation(ch.profile, def.name);
    if (convo.moved && role === 'main') {
      this.notice(`new conversation for ${tildify(this.cwd, this.host.paths?.home)} (agents keep conversations per folder)`, { runId });
    }
    const effectivePrompt = enrich
      ? enrichPrompt(prompt, {
          profile: ch.profile,
          agent: def.name,
          cwd: this.cwd,
          mode: runMode,
          installedAgents: this.installedAgents(),
          paths: this.host.paths,
          allowSubagents: def.name !== 'ollama',
        })
      : prompt;

    const startedAt = Date.now();
    const handle = adapter.run({
      agent: def.name,
      agentDef: def,
      prompt: effectivePrompt,
      displayPrompt: prompt,
      mode: runMode,
      role,
      bin,
      cwd: this.cwd,
      profileEnv: plan.env,
      sessionId: convo.resumeId,
      continued: convo.continued,
      model: this.host.localModel(def),
      agentModel: agentModel(this.config, ch.profile, def.name),
      mcpConfig: plan.mcpConfig,
      fetchFn: this.host.fetch,
      runId,
      extra: { profile: ch.profile, ...(taskId ? { taskId } : {}), ...(stepId ? { stepId } : {}) },
      onEvent: (ev) => this.emitEvent(ev),
    });
    this.active.add(handle);
    if (this.cancelled) handle.cancel();
    let res;
    try {
      res = await handle.promise;
    } finally {
      this.active.delete(handle);
    }
    const durationMs = Date.now() - startedAt;
    const { limited } = this.usage.record(ch.profile, def.name, res, durationMs);
    tried.add(def.name);

    if (limited && !res.cancelled && !this.cancelled) {
      const next = this.usage.pickAgent({ profile: ch.profile, preferred: def.name, candidates: agentNames(this.config), isInstalled: (a) => this.host.isInstalled(a), exclude: tried });
      if (next.switched && next.agent !== def.name) {
        this.usage.recordFailover({ profile: ch.profile, from: def.name, to: next.agent, reason: 'usage limit' });
        this.emitEvent(makeEvent('failover', { runId, from: def.name, to: next.agent, reason: 'usage limit', role, ...(stepId ? { stepId } : {}) }));
        return this.run({ ...opts, agent: next.agent, tried });
      }
      const waitMs = this.usage.nextCooldownMs(ch.profile, agentNames(this.config));
      if (waitMs > 0 && !waited) {
        this.notice(`all agents are on cooldown - retrying in ${Math.max(1, Math.ceil(waitMs / 1000))}s`, { runId, kind: 'cooldown_wait' });
        await this.sleep(waitMs);
        if (!this.cancelled) return this.run({ ...opts, tried: new Set(), waited: true });
      }
    }

    if (!fresh) recordRun(convo, res);
    if (taskId) {
      this.tasks.event(taskId, res.code === 0 ? 'agent.completed' : 'agent.failed', { agent: def.name, code: res.code, summary: res.text.slice(-1000) });
    }
    return { ...res, agent: def.name, label: def.label, durationMs, emptyHint: def.headless?.emptyHint || null };
  }

  /** Send a prompt to one agent (the active channel's unless `agent` is given). */
  async ask(prompt, { agent, mode, enrich = true, taskId = null } = {}) {
    this.cancelled = false;
    const ch = this.requireChannel();
    if (taskId) this.tasks.update(taskId, { status: 'executing', phase: 'agent', assignedAgent: agent || ch.agent }, 'agent.started');
    const res = await this.run({ prompt, agent, mode, role: 'main', enrich, taskId });
    if (taskId) this.finishTask(taskId, res.code === 0, res.code ? `Agent exited with code ${res.code}.` : null);
    return res;
  }

  finishTask(taskId, ok, lastError = null) {
    this.tasks.update(taskId, { status: ok ? 'completed' : 'failed', phase: ok ? 'completed' : 'failed', lastError: ok ? null : lastError }, ok ? 'task.completed' : 'task.failed');
  }

  /**
   * Plan a task and run the plan. The planner (config.planner: ollama | claude | off) answers
   * with JSON that is validated; anything invalid falls back to one direct step from the
   * keyword router. Delegation never comes from text in an agent's answer.
   */
  async delegate(prompt, { taskId = null } = {}) {
    this.cancelled = false;
    const ch = this.requireChannel();
    const installed = this.installedAgents();
    const available = installed.filter((a) => !this.usage.isThrottled(ch.profile, a));
    const isAvailable = (a) => available.includes(a);
    // COSMO_MOCK=1: no planner model either, plans come from the keyword router (unless COSMO_MOCK_PLANNER=1).
    const mock = this.host.env?.COSMO_MOCK && this.host.env.COSMO_MOCK !== '0' && this.host.env.COSMO_MOCK_PLANNER !== '1';
    const choice = mock ? 'off' : plannerChoice(this.config, installed);
    let plan = null;
    let source = 'router';
    if (choice !== 'off' && available.length) {
      let errors;
      try {
        const raw = await this.requestPlan(choice, prompt, { agents: available, throttled: installed.filter((a) => !available.includes(a)) });
        const v = validatePlan(raw, { isAvailable, sessionMode: this.mode });
        if (v.ok) {
          plan = v.plan;
          source = choice;
        } else errors = v.errors;
      } catch (err) {
        errors = [err.message];
      }
      if (!plan && !this.cancelled) this.notice(`planner answer not usable (${errors?.[0] || 'no plan'}) - routing directly`, { kind: 'planner_fallback', errors });
    }
    if (this.cancelled) return { code: 130, cancelled: true, text: '', results: [] };
    if (!plan) plan = routerPlan(prompt, { installed, profile: ch.profile, usage: this.usage, rules: this.config.routing, sessionMode: this.mode });
    return this.executePlan(plan, { prompt, taskId, source });
  }

  async requestPlan(choice, prompt, { agents, throttled }) {
    if (choice === 'claude') {
      const res = await this.run({
        agent: 'claude',
        mode: 'ask',
        role: 'planner',
        enrich: false,
        prompt: `${plannerPrompt(prompt, { agents, roles: AGENT_ROLES, throttled, sessionMode: this.mode })}\n\nAnswer with the JSON object only, no prose and no tools.`,
      });
      if (res.code !== 0) throw new Error(`claude planner exited with ${res.code}`);
      return parsePlanJson(res.text);
    }
    const ctrl = new AbortController();
    const handle = { cancel: () => ctrl.abort(), signal: () => ctrl.abort() };
    this.active.add(handle);
    try {
      return await planWithOllama(prompt, {
        agents,
        throttled,
        roles: AGENT_ROLES,
        sessionMode: this.mode,
        model: this.host.localModel(getAgent('ollama', this.config, this.host.platform)),
        env: this.host.env,
        fetchFn: this.host.fetch,
        signal: ctrl.signal,
      });
    } finally {
      this.active.delete(handle);
    }
  }

  /** Ask several agents the same question in parallel (read-only), then synthesize. */
  async council(prompt, agents = null, { taskId = null } = {}) {
    this.cancelled = false;
    const installed = this.installedAgents();
    let targets = (agents?.length ? agents : installed.filter((a) => a !== 'ollama').slice(0, 3)).filter((a) => installed.includes(a));
    if (!targets.length) targets = installed.slice(0, 2);
    if (!targets.length) throw new CosmoError('No agent is installed.', { hint: 'cosmo doctor shows how to install one.' });
    const plan = {
      kind: targets.length > 1 ? 'delegate' : 'direct',
      steps: targets.map((agent, i) => ({
        id: `s${i + 1}`,
        agent,
        mode: 'ask',
        prompt: `${prompt}\n\n(Provide a concise, high-signal response with clickable file:// links where relevant.)`,
        dependsOn: [],
      })),
    };
    return this.executePlan(plan, { prompt, taskId, source: 'council', council: true });
  }

  /** Run a validated plan with task bookkeeping: one child task per step of a multi-step plan. */
  async executePlan(plan, { prompt, taskId = null, source = 'router', council = false }) {
    const ch = this.requireChannel();
    const installed = this.installedAgents();
    const multi = plan.steps.length > 1;
    const childIds = new Map();
    if (multi) {
      for (const step of plan.steps) {
        const child = this.tasks.create({
          prompt: step.prompt,
          cwd: this.cwd,
          profile: ch.profile,
          mode: clampMode(this.mode, step.mode),
          parentTaskId: taskId,
          assignedAgent: step.agent,
          origin: council ? 'council' : 'delegation',
        });
        childIds.set(step.id, child.id);
      }
      if (taskId) this.tasks.checkpoint(taskId, { phase: council ? 'council' : 'delegation', childTaskIds: [...childIds.values()] });
    } else if (taskId) {
      this.tasks.update(taskId, { status: 'executing', phase: 'agent', assignedAgent: plan.steps[0].agent }, 'agent.started');
    }

    const runAgent = async ({ agent, mode, prompt: stepPrompt, role, stepId }) => {
      const childId = childIds.get(stepId) || null;
      if (childId) this.tasks.update(childId, { status: 'executing', phase: 'agent', assignedAgent: agent, lastError: null }, 'agent.started');
      let res;
      try {
        res = await this.run({ agent, mode, prompt: stepPrompt, role, stepId, taskId: childId || (role === 'step' ? null : taskId) });
      } catch (err) {
        res = { code: 127, cancelled: false, text: '', agent, error: err.message };
        this.emitEvent(makeEvent('error', { runId: `step_${stepId}`, stepId, agent, message: err.message, kind: 'crash' }));
      }
      if (childId) {
        this.tasks.update(childId, {
          status: res.code === 0 ? 'completed' : 'failed',
          phase: res.code === 0 ? 'completed' : 'failed',
          assignedAgent: res.agent || agent,
          lastError: res.code === 0 ? null : `Agent exited with code ${res.code}.`,
        }, res.code === 0 ? 'task.completed' : 'task.failed');
      }
      return res;
    };

    const result = await executePlan(plan, {
      runAgent,
      emit: (ev) => this.emitEvent({ ...ev, source }),
      parentPrompt: prompt,
      isAvailable: (a) => installed.includes(a) && !this.usage.isThrottled(ch.profile, a),
      isCancelled: () => this.cancelled,
      synthesisMode: this.mode,
    });
    if (taskId) {
      const ok = result.code === 0;
      this.finishTask(taskId, ok, multi ? 'Delegated agents failed.' : `Agent exited with code ${result.code}.`);
    }
    return result;
  }
}
