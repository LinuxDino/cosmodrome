import path from 'node:path';
import { getAgent, agentNames, canonicalAgentName } from '../agents.js';
import { which } from '../system.js';
import { readGhUser } from '../github.js';
import { tildify } from '../paths.js';
import { CosmoError } from '../ui.js';
import { detectProfile } from '../detect.js';

/**
 * A channel is one profile + one agent, written "work/claude".
 * Every channel keeps its own conversation; switching never mixes accounts.
 */
export class ChannelManager {
  constructor(app) {
    this.app = app;
    this.current = null;
    this.ghUser = null;
    this.sessions = new Map();
  }

  get config() {
    return this.app.config;
  }

  get id() {
    return this.current ? `${this.current.profile}/${this.current.agent}` : null;
  }

  installed(agentName) {
    const def = getAgent(agentName, this.config, this.app.ctx.platform);
    return Boolean(def && which(def.command, this.app.ctx.env.PATH));
  }

  /** Default agent of a profile, falling back to the first installed one. */
  defaultAgent(profileName) {
    const p = this.config.profiles[profileName];
    const names = agentNames(this.config);
    return p?.defaultAgent || this.config.defaultAgent || names.find((a) => this.installed(a)) || names[0];
  }

  all() {
    const out = [];
    for (const profile of Object.keys(this.config?.profiles || {})) {
      for (const agent of agentNames(this.config)) {
        out.push({
          id: `${profile}/${agent}`,
          profile,
          agent,
          installed: this.installed(agent),
          isDefault: this.defaultAgent(profile) === agent,
        });
      }
    }
    return out;
  }

  /** "work/claude", "#work", "copilot" (same profile) -> { profile, agent } */
  parse(spec) {
    const s = String(spec).replace(/^#/, '').trim();
    const profiles = this.config?.profiles || {};
    if (s.includes('/')) {
      const [profile, agentRaw] = s.split('/');
      const agent = canonicalAgentName(agentRaw, this.config);
      if (!profiles[profile]) throw new CosmoError(`Unknown profile "${profile}".`);
      if (!agent) throw new CosmoError(`Unknown agent "${agentRaw}".`);
      return { profile, agent };
    }
    if (profiles[s]) return { profile: s, agent: this.defaultAgent(s) };
    const agent = canonicalAgentName(s, this.config);
    if (agent && this.current) return { profile: this.current.profile, agent };
    throw new CosmoError(`Unknown channel "${spec}".`, { hint: 'Use profile/agent, e.g. #work/claude - /channels lists them.' });
  }

  switchTo(spec, reason = '') {
    const next = typeof spec === 'string' ? this.parse(spec) : spec;
    const changed = this.id !== `${next.profile}/${next.agent}`;
    this.current = next;
    this.ghUser = readGhUser(
      path.join(this.app.ctx.paths.stationDir, next.profile, 'gh'),
      this.config.profiles[next.profile].github?.host || 'github.com',
    );
    if (changed) {
      const t = this.app.t;
      const warn = this.installed(next.agent) ? '' : t.yellow(`  (${next.agent} is not installed)`);
      this.app.print(`${t.magenta('↪')} ${t.bold(`#${this.id}`)}${reason ? t.dim(`  ${reason}`) : ''}${warn}`);
      const owner = detectProfile(this.config, this.app.state.cwd, this.app.ctx.paths.home);
      if (owner && owner.name !== next.profile) {
        this.app.print(`  ${t.yellow('!')} ${t.yellow(`This folder belongs to profile "${owner.name}" - commits and logins will use "${next.profile}".`)}`);
      }
    }
    return changed;
  }

  /** Pick the channel for the current folder (auto switch). */
  autoSelect({ quietIfSame = false } = {}) {
    if (!this.config || !Object.keys(this.config.profiles).length) return false;
    let choice;
    try {
      choice = this.app.cli.chooseProfile(this.config, null, this.app.state.cwd, this.app.cliCtx());
    } catch {
      return false;
    }
    if (quietIfSame && this.current?.profile === choice.name) return false;
    const agent = this.current?.profile === choice.name ? this.current.agent : this.defaultAgent(choice.name);
    return this.switchTo({ profile: choice.name, agent }, choice.reason ? `(${choice.reason})` : '');
  }

  /** Re-check after config edits: drop a channel whose profile is gone. */
  revalidate() {
    if (this.current && !this.config?.profiles?.[this.current.profile]) this.current = null;
    if (!this.current) this.autoSelect();
  }

  cycleAgent() {
    if (!this.current) return;
    const names = agentNames(this.config).filter((a) => this.installed(a));
    if (!names.length) return;
    const i = names.indexOf(this.current.agent);
    this.switchTo({ profile: this.current.profile, agent: names[(i + 1) % names.length] });
  }

  session(profile = this.current?.profile, agent = this.current?.agent) {
    const key = `${profile}/${agent}`;
    if (!this.sessions.has(key)) this.sessions.set(key, { continued: false, resumeId: null });
    return this.sessions.get(key);
  }

  resetSession() {
    if (this.current) this.sessions.delete(this.id);
  }

  describe() {
    return { id: this.id, ghUser: this.ghUser, cwd: tildify(this.app.state.cwd, this.app.ctx.paths.home) };
  }
}
